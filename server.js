require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bs58 = require("bs58");
const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  Keypair,
} = require("@solana/web3.js");

const PORT = process.env.PORT || 10000;

const {
  ALLOWED_ORIGINS = "",
  POOL_ADDRESS,
  POOL_SECRET_B58,
  POOL_SECRET_JSON,
  RPC_URL = "https://api.mainnet-beta.solana.com",
  TATUM_API_KEY,
} = process.env;

// ---------- Basic checks ----------
if (!POOL_ADDRESS) throw new Error("POOL_ADDRESS missing in env");
if (!RPC_URL) throw new Error("RPC_URL missing in env");
if (!TATUM_API_KEY) console.warn("WARN: TATUM_API_KEY missing, RPC may fail");

// ---------- Load pool keypair ----------
function loadPoolKeypair() {
  if (POOL_SECRET_JSON) {
    try {
      const arr = JSON.parse(POOL_SECRET_JSON);
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error("POOL_SECRET_JSON must be JSON array of 64 numbers");
      }
      const u8 = Uint8Array.from(arr);
      return Keypair.fromSecretKey(u8);
    } catch (e) {
      console.error("Failed decode POOL_SECRET_JSON:", e.message);
      throw e;
    }
  }

  if (POOL_SECRET_B58) {
    try {
      const bytes = bs58.decode(POOL_SECRET_B58.trim());
      // 64 bytes (full secret) atau 32 bytes (seed) dua-duanya valid
      if (bytes.length !== 64 && bytes.length !== 32) {
        throw new Error(
          `POOL_SECRET_B58 must be base58 32 or 64 bytes, got ${bytes.length}`
        );
      }
      return Keypair.fromSecretKey(bytes);
    } catch (e) {
      console.error("Failed decode POOL_SECRET_B58:", e.message);
      throw e;
    }
  }

  throw new Error("No pool secret set (POOL_SECRET_B58 / POOL_SECRET_JSON)");
}

const poolKeypair = loadPoolKeypair();
if (poolKeypair.publicKey.toBase58() !== POOL_ADDRESS) {
  console.warn(
    "WARN: POOL_ADDRESS does not match poolKeypair.publicKey. Double-check your env."
  );
}

// ---------- Solana connection (Tatum) ----------
const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  httpHeaders: TATUM_API_KEY ? { "x-api-key": TATUM_API_KEY } : {},
});

// ---------- Express app ----------
const app = express();
app.use(express.json());

const allowedOrigins = ALLOWED_ORIGINS.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // curl / Postman
      if (
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(origin.replace(/\/$/, ""))
      ) {
        return cb(null, true);
      }
      return cb(new Error("CORS not allowed"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false,
  })
);

// ---------- Helpers ----------
async function getBalanceLamports(address) {
  const pk = new PublicKey(address);
  return await connection.getBalance(pk, "confirmed");
}

// small helper to confirm by signature only (no manual blockheight)
async function confirmSignature(sig, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatuses([sig], {
      searchTransactionHistory: true,
    });
    const v = status.value && status.value[0];
    if (
      v &&
      (v.confirmationStatus === "confirmed" ||
        v.confirmationStatus === "finalized")
    ) {
      return v;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Confirmation timeout");
}

// ---------- Routes ----------

// Health check
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "zknon-backend live",
    pool: POOL_ADDRESS,
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Balance helper (optional, for debugging)
async function handleBalance(req, res) {
  const { address } = req.query;
  if (!address) {
    return res.status(400).json({ ok: false, error: "address required" });
  }
  try {
    const lamports = await getBalanceLamports(address);
    res.json({ ok: true, lamports });
  } catch (e) {
    res
      .status(500)
      .json({ ok: false, error: e.message || String(e) });
  }
}

app.get("/balance", handleBalance);
app.get("/get-balance", handleBalance); // alias

// Withdraw / relay from pool → recipient
app.post(["/relay/withdraw", "/withdraw"], async (req, res) => {
  const { to, amount, amountLamports, depositSignature } = req.body || {};

  if (!to) {
    return res
      .status(400)
      .json({ ok: false, error: "target address (to) required" });
  }

  let lamports;
  if (amountLamports !== undefined) {
    try {
      lamports = BigInt(amountLamports);
    } catch {
      return res
        .status(400)
        .json({ ok: false, error: "invalid amountLamports" });
    }
  } else if (amount !== undefined) {
    const sol = Number(amount);
    if (!Number.isFinite(sol) || sol <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: "invalid amount (SOL)" });
    }
    lamports = BigInt(Math.round(sol * LAMPORTS_PER_SOL));
  } else {
    return res
      .status(400)
      .json({ ok: false, error: "amount or amountLamports required" });
  }

  if (lamports <= 0n) {
    return res
      .status(400)
      .json({ ok: false, error: "amount must be > 0" });
  }

  const lamportsNum = Number(lamports);
  if (!Number.isSafeInteger(lamportsNum)) {
    return res
      .status(400)
      .json({ ok: false, error: "amount too large" });
  }

  let targetPk;
  try {
    targetPk = new PublicKey(to);
  } catch {
    return res
      .status(400)
      .json({ ok: false, error: "invalid target address" });
  }

  console.log(
    `[relay] depositSig=${depositSignature || "-"} ` +
      `from pool→${targetPk.toBase58()} amount=${lamportsNum}`
  );

  try {
    // fresh blockhash setiap request, biar minim kemungkinan expired
    const { blockhash } = await connection.getLatestBlockhash("finalized");

    const tx = new Transaction({
      feePayer: poolKeypair.publicKey,
      recentBlockhash: blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: poolKeypair.publicKey,
        toPubkey: targetPk,
        lamports: lamportsNum,
      })
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [poolKeypair], {
      commitment: "confirmed",
    });

    // double confirm by polling (lebih aman, tapi non-fatal kalau gagal)
    try {
      await confirmSignature(sig, 30000);
    } catch (e) {
      console.warn("confirmSignature warn:", e.message);
    }

    console.log("[relay] withdrawSignature", sig);
    res.json({ ok: true, withdrawSignature: sig });
  } catch (e) {
    console.error("Relay withdraw error:", e);
    res
      .status(500)
      .json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- Start server ----------
app.listen(PORT, () => {
  console.log(`zknon-backend listening on :${PORT}`);
});
