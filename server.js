// server.js - ZKnon backend (pool → recipient relay)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bs58 = require("bs58");
const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  Keypair,
} = require("@solana/web3.js");

const app = express();
const PORT = process.env.PORT || 10000;

// ---------- CORS ----------
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(express.json());

app.use(
  cors({
    origin(origin, cb) {
      // allow curl/postman (no origin)
      if (!origin) return cb(null, true);
      if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
        return cb(null, true);
      }
      return cb(new Error("Not allowed by CORS"), false);
    },
  })
);

// ---------- Solana connection ----------
const RPC_URL =
  process.env.RPC_URL || "https://solana-mainnet.gateway.tatum.io/";
const TATUM_API_KEY = process.env.TATUM_API_KEY || "";

const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  httpHeaders: TATUM_API_KEY ? { "x-api-key": TATUM_API_KEY } : undefined,
});

// ---------- Pool config ----------
if (!process.env.POOL_ADDRESS) {
  throw new Error("Missing POOL_ADDRESS in env.");
}
const POOL_ADDRESS = new PublicKey(process.env.POOL_ADDRESS);

// POOL_SECRET_B58 = base58 secret key (64 bytes) dari keypair pool
if (!process.env.POOL_SECRET_B58) {
  throw new Error("Missing POOL_SECRET_B58 in env.");
}

let poolKeypair;
try {
  const decoded = bs58.decode(process.env.POOL_SECRET_B58.trim());
  if (decoded.length !== 64 && decoded.length !== 32) {
    throw new Error(
      `POOL_SECRET_B58 must decode to 32 or 64 bytes, got ${decoded.length}`
    );
  }
  poolKeypair = Keypair.fromSecretKey(decoded);
  console.log("[pool]", "Loaded pool keypair:", POOL_ADDRESS.toBase58());
} catch (e) {
  console.error("Failed to decode POOL_SECRET_B58:", e.message || e);
  throw e;
}

// ---------- Simple rate-limit ----------
const TX_MIN_GAP_SEC = Number(process.env.TX_RATELIMIT || "8"); // detik
let lastTxTs = 0;

function checkRateLimit() {
  const now = Date.now();
  if (!TX_MIN_GAP_SEC) return;
  const gap = (now - lastTxTs) / 1000;
  if (gap < TX_MIN_GAP_SEC) {
    throw new Error(
      `Too many requests, wait ${Math.ceil(TX_MIN_GAP_SEC - gap)}s`
    );
  }
  lastTxTs = now;
}

// ---------- Helpers ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Konfirmasi berdasar signature saja (tanpa blockhash) supaya
// tidak kena "blockhash expired".
async function confirmBySignature(signature, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { value } = await connection.getSignatureStatuses(
      [signature],
      { searchTransactionHistory: true }
    );
    const st = value && value[0];
    if (
      st &&
      (st.confirmationStatus === "confirmed" ||
        st.confirmationStatus === "finalized")
    ) {
      return st;
    }
    await sleep(1500);
  }
  throw new Error("Confirmation timeout");
}

// ---------- Routes ----------
app.get("/", (_req, res) => {
  res.json({ ok: true, service: "zknon-backend" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// optional helper cek balance pool
app.get("/pool-balance", async (_req, res) => {
  try {
    const lam = await connection.getBalance(POOL_ADDRESS, "confirmed");
    res.json({
      ok: true,
      lamports: lam,
      sol: lam / LAMPORTS_PER_SOL,
      address: POOL_ADDRESS.toBase58(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Handler utama: relay withdraw
async function handleWithdraw(req, res) {
  try {
    checkRateLimit();

    const body = req.body || {};
    // frontend kirim { to, amount, depositSignature } atau { target, amountLamports }
    const target = (body.to || body.target || "").trim();
    const amountSol =
      typeof body.amount === "number" ? body.amount : Number(body.amount);
    const amountLamportsRaw =
      body.amountLamports !== undefined ? body.amountLamports : null;

    if (!target) {
      return res.status(400).json({ ok: false, error: "target required" });
    }

    let lamports;
    if (amountLamportsRaw !== null) {
      lamports = BigInt(amountLamportsRaw.toString());
    } else if (Number.isFinite(amountSol) && amountSol > 0) {
      lamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));
    } else {
      return res
        .status(400)
        .json({ ok: false, error: "amount or amountLamports required" });
    }

    const lamportsNumber = Number(lamports);
    if (!Number.isFinite(lamportsNumber) || lamportsNumber <= 0) {
      return res.status(400).json({ ok: false, error: "invalid amount" });
    }

    const toPubkey = new PublicKey(target);

    console.log("[relay]", "Starting withdraw");
    console.log("  to:", toPubkey.toBase58());
    console.log("  lamports:", lamportsNumber);
    if (body.depositSignature) {
      console.log("  depositSig:", body.depositSignature);
    }

    // --- build tx dengan blockhash baru ---
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    const ix = SystemProgram.transfer({
      fromPubkey: poolKeypair.publicKey,
      toPubkey,
      lamports: lamportsNumber,
    });

    const tx = new Transaction({
      feePayer: poolKeypair.publicKey,
      recentBlockhash: blockhash,
    }).add(ix);

    tx.sign(poolKeypair);

    const raw = tx.serialize();
    const sig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      maxRetries: 3,
    });

    console.log("[relay]", "withdraw sent:", sig);

    // Konfirmasi tanpa ikut blockhash => tidak error "blockhash expired"
    try {
      await confirmBySignature(sig, 60000);
      console.log("[relay]", "withdraw confirmed:", sig);
      return res.json({ ok: true, withdrawSignature: sig });
    } catch (e) {
      console.warn(
        "[relay] confirmation issue (but broadcasted):",
        e.message || e
      );
      // Tetap dianggap OK, tapi kasih catatan
      return res.json({
        ok: true,
        withdrawSignature: sig,
        note: "Broadcasted, confirmation pending on-chain.",
      });
    }
  } catch (e) {
    console.error("[relay] withdraw error:", e.message || e);
    return res
      .status(500)
      .json({ ok: false, error: e.message || String(e) });
  }
}

// Pakai handler yang sama untuk kedua path
app.post("/relay/withdraw", handleWithdraw);
app.post("/withdraw", handleWithdraw);

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`ZKnon backend listening on :${PORT}`);
});
