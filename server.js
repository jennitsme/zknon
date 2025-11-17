import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage
} from '@solana/web3.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

/* ---------------- CORS ---------------- */
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    cb(new Error('CORS blocked'), false);
  },
  credentials: true
}));

/* ---------------- Env & RPC ---------------- */
const RPC_URL = process.env.RPC_URL;
const TATUM_API_KEY = process.env.TATUM_API_KEY;
const TX_RATELIMIT = Number(process.env.TX_RATELIMIT || 8);
if (!RPC_URL || !TATUM_API_KEY) {
  console.error('Missing RPC_URL or TATUM_API_KEY');
  process.exit(1);
}

function loadPoolKeypair() {
  // 1) Coba base58 (hapus semua whitespace)
  const rawB58 = (process.env.POOL_SECRET_B58 || '').replace(/\s+/g, '').trim();

  if (rawB58) {
    try {
      const raw = bs58.decode(rawB58);
      if (raw.length === 64) {
        console.log('POOL key format: base58(64 bytes)');
        return Keypair.fromSecretKey(new Uint8Array(raw));
      }
      if (raw.length === 32) {
        console.log('POOL key format: base58(32-bytes seed)');
        return Keypair.fromSeed(new Uint8Array(raw));
      }
      throw new Error(`decoded length = ${raw.length} (expected 32 or 64)`);
    } catch (e) {
      console.error('Failed decode POOL_SECRET_B58:', e.message);
    }
  }

  // 2) Coba JSON array (solana-keygen)
  const rawJson = (process.env.POOL_SECRET_JSON || '').trim();
  if (rawJson) {
    try {
      const arr = JSON.parse(rawJson);
      if (!Array.isArray(arr)) throw new Error('not array');
      const u8 = new Uint8Array(arr);
      if (u8.length !== 64) throw new Error(`length ${u8.length}, expected 64`);
      console.log('POOL key format: JSON array (64 bytes)');
      return Keypair.fromSecretKey(u8);
    } catch (e) {
      console.error('Failed parse POOL_SECRET_JSON:', e.message);
    }
  }

  throw new Error(
    'Invalid pool key. Set POOL_SECRET_B58 (base58 32/64 bytes) ' +
    'atau POOL_SECRET_JSON (JSON array 64 bytes).'
  );
}

let POOL_KEYPAIR;
try {
  POOL_KEYPAIR = loadPoolKeypair();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const POOL_PUBKEY =
  new PublicKey(process.env.POOL_ADDRESS || POOL_KEYPAIR.publicKey.toBase58());

/* ---------------- Tatum RPC helper ---------------- */
async function tatumRpc(body) {
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-api-key': TATUM_API_KEY
    },
    body: JSON.stringify(body)
  });

  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`RPC parse error: ${text.slice(0, 180)}`);
  }
  if (!r.ok || json.error) {
    const msg = json?.error?.message || r.statusText;
    const code = json?.error?.code || r.status;
    const err = new Error(msg);
    err.code = code;
    err.raw = json;
    throw err;
  }
  return json.result;
}

/* ---------------- Simple rate limiter ---------------- */
let calls = 0, t0 = Date.now();
function guard() {
  const now = Date.now();
  if (now - t0 > 1000) { t0 = now; calls = 0; }
  if (++calls > TX_RATELIMIT) throw new Error('Rate limit');
}

/* ---------------- Utils ---------------- */
const lamports = (sol) => Math.round(Number(sol) * 1e9);
const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, error) => res.status(code).json({ ok: false, error });

/* ---------------- Health ---------------- */
app.get('/health', (_req, res) => {
  ok(res, { service: 'zknon-backend', pool: POOL_PUBKEY.toBase58(), cors: ALLOWED });
});

/* ---------------- RPC proxy (opsional) ---------------- */
app.post('/rpc-proxy', async (req, res) => {
  try {
    guard();
    const { method, params, id } = req.body || {};
    if (!method) return fail(res, 400, 'method required');
    const result = await tatumRpc({ jsonrpc: '2.0', id: id ?? 1, method, params: params ?? [] });
    ok(res, { result });
  } catch (e) {
    fail(res, 502, e.message || String(e));
  }
});

/* ---------------- Withdraw/Relay nyata ---------------- */
async function doWithdraw(recipientStr, amountLamports) {
  const recipient = new PublicKey(recipientStr);

  const { value: { blockhash, lastValidBlockHeight } } =
    await tatumRpc({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] });

  const ix = SystemProgram.transfer({
    fromPubkey: POOL_PUBKEY,
    toPubkey: recipient,
    lamports: Number(amountLamports)
  });

  const msg = new TransactionMessage({
    payerKey: POOL_PUBKEY,
    recentBlockhash: blockhash,
    instructions: [ix]
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msg);
  vtx.sign([POOL_KEYPAIR]);

  const rawB64 = Buffer.from(vtx.serialize()).toString('base64');

  const sig = await tatumRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'sendRawTransaction',
    params: [rawB64, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]
  });

  return { signature: sig, lastValidBlockHeight };
}

async function relayHandler(req, res) {
  try {
    guard();
    const { recipient, amountLamports } = req.body || {};
    if (!recipient) return fail(res, 400, 'recipient required');
    if (!amountLamports || amountLamports <= 0) return fail(res, 400, 'amountLamports must be > 0');

    const { signature, lastValidBlockHeight } = await doWithdraw(recipient, amountLamports);
    ok(res, {
      signature,
      explorer: `https://solscan.io/tx/${signature}`,
      lastValidBlockHeight
    });
  } catch (e) {
    const msg = String(e?.message || e);
    if (/block height exceeded|Blockhash not found|expired/i.test(msg)) {
      try {
        const { signature, lastValidBlockHeight } = await doWithdraw(req.body.recipient, req.body.amountLamports);
        return ok(res, {
          signature,
          explorer: `https://solscan.io/tx/${signature}`,
          lastValidBlockHeight,
          retry: 1
        });
      } catch (e2) {
        return fail(res, 502, String(e2?.message || e2));
      }
    }
    return fail(res, 502, msg);
  }
}

app.post('/withdraw', relayHandler);
app.post('/relay', relayHandler);
app.post('/relay-withdraw', relayHandler);

/* ---------------- Start ---------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`ZKnon backend listening on :${PORT}`);
  console.log('POOL_ADDRESS:', POOL_PUBKEY.toBase58());
  console.log('CORS:', ALLOWED.join(', '));
});
