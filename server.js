import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fetch from 'node-fetch';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / local
      if (ALLOWED.includes(origin)) return cb(null, true);
      cb(new Error('CORS blocked'));
    },
    credentials: true
  })
);

// ---------- ENV ----------
const POOL_ADDRESS =
  process.env.POOL_ADDRESS || process.env.POOL_PUBLIC || '';

const RPC_URL = process.env.RPC_URL;
const TATUM_API_KEY = process.env.TATUM_API_KEY;
const TX_RATELIMIT = Number(process.env.TX_RATELIMIT || 8);

if (!POOL_ADDRESS) {
  console.error('Missing POOL_ADDRESS (or POOL_PUBLIC) in env.');
  process.exit(1);
}
if (!RPC_URL || !TATUM_API_KEY) {
  console.error('Missing RPC_URL or TATUM_API_KEY in env.');
  process.exit(1);
}

// ---------- helpers ----------
async function tatumRpc(body) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': TATUM_API_KEY,
      accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch (e) {
    throw new Error(`RPC parse error: ${txt.slice(0, 200)}`);
  }
  if (!res.ok || json.error) {
    const msg = json?.error?.message || res.statusText;
    const code = json?.error?.code || res.status;
    const err = new Error(msg);
    err.code = code;
    err.raw = json;
    throw err;
  }
  return json;
}

// very tiny rate-limit per instance
let calls = 0;
let windowStart = Date.now();
function guard() {
  const now = Date.now();
  if (now - windowStart > 1000) {
    windowStart = now;
    calls = 0;
  }
  if (calls++ > TX_RATELIMIT) throw new Error('Rate limit');
}

// ---------- routes ----------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    pool: POOL_ADDRESS,
    rpc: !!RPC_URL,
    cors: ALLOWED
  });
});

app.post('/rpc-proxy', async (req, res) => {
  try {
    guard();
    const { method, params, id } = req.body || {};
    if (!method) return res.status(400).json({ ok: false, error: 'method required' });
    const out = await tatumRpc({
      jsonrpc: '2.0',
      id: id ?? 1,
      method,
      params: params ?? []
    });
    res.json({ ok: true, result: out.result });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

// alias /relay  (dipanggil UI kamu)
app.post('/relay', async (req, res) => handleRelay(req, res));
// alias lama /relay-withdraw (biar kompatibel)
app.post('/relay-withdraw', async (req, res) => handleRelay(req, res));

async function handleRelay(req, res) {
  // Ini placeholder aman. Agar benar-benar menarik dari pool,
  // kamu harus menambahkan RELAYER_PRIVATE_KEY dan logika penarikan.
  // Untuk saat ini kita balas 501 supaya UI bisa handle dengan jelas.
  const { recipient, amountLamports } = req.body || {};
  return res
    .status(501)
    .json({
      ok: false,
      error: 'relay_not_configured',
      hint:
        'Set RELAYER_PRIVATE_KEY dan implementasikan penarikan dari pool pada backend.'
    });
}

// ---------- start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`ZKnon backend up on :${PORT}`);
  console.log('POOL_ADDRESS:', POOL_ADDRESS);
  console.log('CORS:', ALLOWED.join(', '));
});
