// server.js
const express = require("express");
const cors = require("cors");
const {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  Keypair,
} = require("@solana/web3.js");
const bs58 = require("bs58");
require("dotenv").config();

const PORT = process.env.PORT || 8080;
const TATUM_RPC =
  process.env.TATUM_RPC || "https://solana-mainnet.gateway.tatum.io";
const TATUM_API_KEY = process.env.TATUM_API_KEY; // required
const POOL_SECRET_JSON = process.env.POOL_SECRET_JSON || "";
const POOL_SECRET_B58 = process.env.POOL_SECRET_B58 || "";

if (!TATUM_API_KEY) {
  console.warn("[WARN] TATUM_API_KEY missing. RPC calls may fail with 403.");
}

// ---- Load pool keypair from ENV -------------------------------------------
function loadPoolKeypair() {
  if (POOL_SECRET_JSON) {
    try {
      const parsed = JSON.parse(POOL_SECRET_JSON);
      let arr = null;

      // case: [12, 34, ...]
      if (Array.isArray(parsed)) {
        arr = Uint8Array.from(parsed);
      }
      // case: { secretKey: [ ... ] }
      else if (parsed && Array.isArray(parsed.secretKey)) {
        arr = Uint8Array.from(parsed.secretKey);
      }
      // case: { _keypair: { secretKey: [ ... ] } }
      else if (
        parsed &&
        parsed._keypair &&
        Array.isArray(parsed._keypair.secretKey)
      ) {
        arr = Uint8Array.from(parsed._keypair.secretKey);
      }

      if (arr) {
        console.log("[POOL] Loaded from POOL_SECRET_JSON");
        return Keypair.fromSecretKey(arr);
      }
    } catch (e) {
      console.error("[POOL] Failed to parse POOL_SECRET_JSON:", e.message || e);
    }
  }

  if (POOL_SECRET_B58) {
    try {
      const raw = bs58.decode(POOL_SECRET_B58.trim());
      console.log("[POOL] Loaded from POOL_SECRET_B58");
      return Keypair.fromSecretKey(raw);
    } catch (e) {
      console.error("[POOL] Failed to parse POOL_SECRET_B58:", e.message || e);
    }
  }

  throw new Error("No valid POOL_SECRET_JSON or POOL_SECRET_B58 provided");
}

const POOL_KEYPAIR = loadPoolKeypair();
console.log("[POOL] Public key:", POOL_KEYPAIR.publicKey.toBase58());

// ---- Connection via Tatum --------------------------------------------------
const connection = new Connection(TATUM_RPC, {
  commitment: "confirmed",
  httpHeaders: TATUM_API_KEY ? { "x-api-key": TATUM_API_KEY } : undefined,
});

// Simple confirm by signature (NO blockheight expiry check)
async function confirmBySignature(
  signature,
  commitment = "confirmed",
  timeoutMs = 60000
) {
  const start = Date.now();
  for (;;) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Confirmation timeout");
    }
    const st = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const v = st && st.value && st.value[0];
    if (v) {
      if (v.err) {
        throw new Error("Transaction failed: " + JSON.stringify(v.err));
      }
      if (
        v.confirmationStatus === "confirmed" ||
        v.confirmationStatus === "finalized"
      ) {
        return v;
      }
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

const app = express();
app.use(express.json());

// ---- CORS ------------------------------------------------------------------
const ALLOWED_ORIGINS = [
  "https://dapp.zknon.com",
  "https://tnemyap.app",
  "http://localhost:4173",
  "http://localhost:5173",
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
  })
);

// ---- Healthcheck -----------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "up" });
});

// ---- Balance proxy (dipakai frontend utk Tatum key hidden) -----------------
app.get("/get-balance", async (req, res) => {
  try {
    const address = req.query.address;
    if (!address) {
      return res
        .status(400)
        .json({ ok: false, error: "address query param required" });
    }
    const pub = new PublicKey(address);
    const lamports = await connection.getBalance(pub, "confirmed");
    res.json({ ok: true, lamports });
  } catch (e) {
    console.error("[GET /get-balance] error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---- WITHDRAW: pool -> user ------------------------------------------------
app.post("/withdraw", async (req, res) => {
  try {
    const body = req.body || {};

    // Frontend kirim: to, amountSol, depositSignature (plus compat fields)
    const to = body.to || body.target;
    const rawLamports =
      body.lamports ||
      body.amountLamports ||
      (body.amountSol
        ? Math.round(Number(body.amountSol) * LAMPORTS_PER_SOL)
        : undefined) ||
      (body.amount
        ? Math.round(Number(body.amount) * LAMPORTS_PER_SOL)
        : undefined);

    if (!to) {
      return res
        .status(400)
        .json({ ok: false, error: "target address (to) required" });
    }
    if (
      !rawLamports ||
      !Number.isFinite(Number(rawLamports)) ||
      Number(rawLamports) <= 0
    ) {
      return res
        .status(400)
        .json({ ok: false, error: "valid lamports amount required" });
    }

    const lamports = Number(rawLamports);
    const toPub = new PublicKey(to);

    console.log("[WITHDRAW] Request", {
      to: toPub.toBase58(),
      lamports,
      depositSignature: body.depositSignature,
    });

    let lastError = null;

    // Auto retry beberapa kali kalau error-nya kayak blockhash/expired
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { blockhash } = await connection.getLatestBlockhash("finalized");

        const tx = new Transaction({
          feePayer: POOL_KEYPAIR.publicKey,
          recentBlockhash: blockhash,
        }).add(
          SystemProgram.transfer({
            fromPubkey: POOL_KEYPAIR.publicKey,
            toPubkey: toPub,
            lamports,
          })
        );

        tx.sign(POOL_KEYPAIR);

        const sig = await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });

        console.log(`[WITHDRAW] Attempt ${attempt} sent:`, sig);

        try {
          await confirmBySignature(sig, "confirmed");
          console.log("[WITHDRAW] Confirmed:", sig);
        } catch (e) {
          console.warn("[WITHDRAW] confirm warning:", e.message || e);
        }

        return res.json({ ok: true, withdrawSignature: sig, attempt });
      } catch (e) {
        const msg = e?.message || String(e);
        lastError = msg;
        console.error(`[WITHDRAW] Attempt ${attempt} failed:`, msg);

        // Retry hanya kalau error-nya kelihatan karena blockhash/expired
        if (
          !msg.includes("block height exceeded") &&
          !msg.includes("Signature") &&
          !msg.includes("Blockhash")
        ) {
          break;
        }
      }
    }

    return res.status(500).json({
      ok: false,
      error: lastError || "withdraw failed after retries",
    });
  } catch (e) {
    console.error("[WITHDRAW] fatal error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`ZKnon backend listening on :${PORT}`);
});
