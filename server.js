const express = require("express");
const cors = require("cors");
const bs58 = require("bs58");
const dotenv = require("dotenv");
dotenv.config();

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

// ------- Env & Setup -------
const PORT = process.env.PORT || 8080;
const RPC_URL = process.env.RPC_URL || "https://solana-mainnet.gateway.tatum.io";
const TATUM_API_KEY = process.env.TATUM_API_KEY || "";

const POOL_PUBLIC = process.env.POOL_PUBLIC;
const POOL_SECRET_B58 = process.env.POOL_SECRET_B58 || "";
const POOL_SECRET_JSON = process.env.POOL_SECRET_JSON || "";

if (!POOL_PUBLIC) {
  console.error("Missing POOL_PUBLIC in env.");
  process.exit(1);
}
const POOL_PUBKEY = new PublicKey(POOL_PUBLIC);

// Allowlist CORS
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = ALLOWED.some(a => origin === a || origin.startsWith(a));
    return cb(ok ? null : new Error("Not allowed by CORS"), ok);
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  credentials: false,
};

// Tatum connection with API key header
const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  httpHeaders: TATUM_API_KEY ? { "x-api-key": TATUM_API_KEY } : undefined,
});

// Load pool Keypair (supports base58 or JSON array)
function loadPoolKeypair() {
  try {
    if (POOL_SECRET_JSON) {
      const arr = JSON.parse(POOL_SECRET_JSON);
      const sk = Uint8Array.from(arr);
      return Keypair.fromSecretKey(sk);
    }
    if (POOL_SECRET_B58) {
      const sk = bs58.decode(POOL_SECRET_B58);
      return Keypair.fromSecretKey(sk);
    }
    throw new Error("No pool secret provided");
  } catch (e) {
    console.error("Failed to load pool secret:", e.message);
    process.exit(1);
  }
}
const POOL_KEYPAIR = loadPoolKeypair();
if (!POOL_KEYPAIR.publicKey.equals(POOL_PUBKEY)) {
  console.warn(
    `Warning: POOL_PUBLIC (${POOL_PUBKEY.toBase58()}) != keypair public (${POOL_KEYPAIR.publicKey.toBase58()})`
  );
}

// Confirm by signature polling (stable across nodes)
async function confirmBySignature(signature, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
    const v = st && st.value && st.value[0];
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
      return v;
    }
    await new Promise(r => setTimeout(r, 1200));
  }
  throw new Error("Confirmation timeout");
}

// ------- App -------
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.get("/health", async (req, res) => {
  try {
    const bh = await connection.getBlockHeight("confirmed");
    res.json({ ok: true, rpc: "ok", blockHeight: bh, pool: POOL_PUBKEY.toBase58() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Core handler
async function handleWithdraw(req, res) {
  try {
    const { to, amount, depositSignature } = req.body || {};
    if (!to || !amount) return res.status(400).json({ ok: false, error: "Missing 'to' or 'amount'." });

    let recipient;
    try {
      recipient = new PublicKey(to);
    } catch {
      return res.status(400).json({ ok: false, error: "Invalid recipient address." });
    }

    const lamports = Math.round(Number(amount) * LAMPORTS_PER_SOL);
    if (!Number.isFinite(lamports) || lamports <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid amount." });
    }

    // (Optional) You can validate depositSignature existence here if you want strict flow
    if (depositSignature && typeof depositSignature === "string") {
      // Just log, or fetch status if you want:
      // const st = await connection.getSignatureStatuses([depositSignature], { searchTransactionHistory: true });
      // console.log("Deposit status:", st.value?.[0]);
    }

    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash("finalized");

    // Build transfer from pool → recipient
    const ix = SystemProgram.transfer({
      fromPubkey: POOL_KEYPAIR.publicKey,
      toPubkey: recipient,
      lamports,
    });

    const tx = new Transaction({
      feePayer: POOL_KEYPAIR.publicKey,
      recentBlockhash: blockhash,
    }).add(ix);

    // Sign & send
    tx.sign(POOL_KEYPAIR);
    const raw = tx.serialize();
    const sig = await connection.sendRawTransaction(raw, { skipPreflight: false });

    // Confirm robustly
    const status = await confirmBySignature(sig);
    return res.json({
      ok: true,
      withdrawSignature: sig,
      slot: status?.slot,
      to: recipient.toBase58(),
      amountLamports: lamports,
    });
  } catch (e) {
    console.error("Withdraw error:", e);
    return res.status(500).send(typeof e === "string" ? e : e.message || "Server error");
  }
}

// Routes (both paths supported)
app.post("/withdraw", handleWithdraw);
app.post("/relay/withdraw", handleWithdraw);

// Fallback
app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));

app.listen(PORT, () => {
  console.log(`ZKNON backend listening on :${PORT}`);
});
