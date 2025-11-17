import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import morgan from "morgan";

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const RPC_URL = process.env.RPC_URL || "https://solana-mainnet.gateway.tatum.io/";
const TATUM_API_KEY = process.env.TATUM_API_KEY || "";
const POOL_ADDRESS = process.env.POOL_ADDRESS || "";
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const TX_RATELIMIT = Number(process.env.TX_RATELIMIT || "8");

// ===== APP =====
const app = express();

// basic hardening
app.use(helmet({
  crossOriginResourcePolicy: false
}));

// CORS: whitelist hanya domain kamu
app.use(
  cors({
    origin(origin, cb) {
      // allow curl / server-to-server (tanpa origin)
      if (!origin) return cb(null, true);
      if (ALLOWED.includes(origin)) return cb(null, true);
      return cb(new Error("CORS: origin not allowed"), false);
    },
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["content-type"]
  })
);
app.options("*", cors());

// logging
app.use(morgan("tiny"));
app.use(express.json({ limit: "1mb" }));

// ===== helpers =====
async function rpc(method, params = []) {
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params
  };

  const headers = {
    accept: "application/json",
    "content-type": "application/json"
  };
  // Tatum butuh x-api-key
  if (TATUM_API_KEY) headers["x-api-key"] = TATUM_API_KEY;

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RPC HTTP ${res.status}: ${text || res.statusText}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

function maskAddr(addr = "") {
  if (addr.length < 10) return addr;
  return addr.slice(0, 4) + "..." + addr.slice(-4);
}

// ===== rate limit khusus kirim tx =====
const txLimiter = rateLimit({
  windowMs: 15 * 1000, // 15 detik
  max: TX_RATELIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests, slow down." }
});

// ===== routes =====
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "ZKnon backend",
    time: new Date().toISOString(),
    env: {
      rpc: RPC_URL,
      pool: maskAddr(POOL_ADDRESS),
      cors: ALLOWED
    },
    hasKey: Boolean(TATUM_API_KEY)
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    poolAddress: POOL_ADDRESS,
    rpc: RPC_URL,
    cors: ALLOWED
  });
});

// saldo pool vault
app.get("/api/pool/balance", async (req, res) => {
  try {
    if (!POOL_ADDRESS) throw new Error("POOL_ADDRESS not configured");
    const lamports = await rpc("getBalance", [POOL_ADDRESS, { commitment: "processed" }]);
    const value = typeof lamports === "number" ? lamports : lamports?.value ?? 0;
    res.json({
      ok: true,
      lamports: value,
      sol: value / 1_000_000_000
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// blockhash & blockheight opsional buat client
app.get("/api/rpc/latest-blockhash", async (req, res) => {
  try {
    const r = await rpc("getLatestBlockhash", [{ commitment: "finalized" }]);
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
app.get("/api/rpc/blockheight", async (req, res) => {
  try {
    const r = await rpc("getBlockHeight");
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// kirim transaksi base64 (sudah di-sign oleh wallet di frontend)
app.post("/api/send-tx", txLimiter, async (req, res) => {
  try {
    const { tx } = req.body || {};
    if (!tx || typeof tx !== "string") {
      return res.status(400).json({ ok: false, error: "Body {tx} (base64) is required" });
    }
    // validasi tipis base64
    if (!/^[A-Za-z0-9+/=]+$/.test(tx)) {
      return res.status(400).json({ ok: false, error: "Invalid base64" });
    }
    // forward ke RPC
    const sig = await rpc("sendTransaction", [tx, { encoding: "base64", skipPreflight: false }]);
    return res.json({ ok: true, signature: sig });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// not found
app.use((req, res) => res.status(404).json({ ok: false, error: "Not found" }));

// graceful
const server = app.listen(PORT, () => {
  console.log(`ZKnon backend listening on :${PORT}`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
