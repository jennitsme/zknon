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
  Transaction,
  VersionedTransaction,
  TransactionMessage
} from '@solana/web3.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

/* ---------- CORS ---------- */
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'), false);
  },
  credentials: true
}));

/* ---------- ENV & KEYS ---------- */
const RPC_URL = process.env.RPC_URL;
const TATUM_API_KEY = process.env.TATUM_API_KEY;
const TX_RATELIMIT = Number(process.env.TX_RATELIMIT || 8);

if (!RPC_URL || !TATUM_API_KEY) {
  console.error('Missing RPC_URL or TATUM_API_KEY');
  process.exit(1);
}

let POOL_KEYPAIR;
try {
  const sk = bs58.decode(process.env.POOL_SECRET_B58 || '');
  if (!sk || (sk.length !== 64 && sk.length !== 32)) {
    throw new Error('POOL_SECRET_B58 must be base58 of 64 or 32 bytes');
  }
  // Jika 32-byte seed, Solana akan derive pair; jika 64-byte secretKey langsung
  POOL_KEYPAIR = (sk.length === 64)
    ? Keypair.fromSecretKey(new Uint8Array(sk))
    : Keypair.fromSeed(new Uint8Array(sk));
} catch (e) {
  console.error('Invalid POOL_SECRET_B58:', e.message);
  process.exit(1);
}

const POOL_PUBKEY = new PublicKey(process.env.POOL_ADDRESS || POOL_KEYPAIR.publicKey.toBase58());

/* ---------- RPC helper (Tatum) ---------- */
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
    const err = new Error(`${msg}`);
    err.code = code;
    err.raw = json;
    throw err;
  }
  return json.result;
}

/* ---------- Rate limiter super sederhana ---------- */
let calls = 0, windowStart = Date.now();
function guard() {
  const now = Date.now();
  if (now - windowStart > 1000) { windowStart = now; calls = 0; }
  if (++calls > TX_RATELIMIT) throw new Error('Rate limit');
}

/* ---------- Utils ---------- */
const lamports = (sol) => Math.round(Number(sol) * 1e9);
const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code = 400, error = 'error') => res.status(code).json({ ok: false, error });

/* ---------- Health ---------- */
app.get('/health', (_req, res) => {
  ok(res, {
    service: 'zknon-backend',
    pool: POOL_PUBKEY.toBase58(),
    cors: ALLOWED,
  });
});

/* ---------- RPC proxy (opsional) ---------- */
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

/* ---------- Withdraw/Relay nyata ---------- */
/**
 * Body:
 *   { recipient: string(Pubkey), amountLamports: number }
 * Kirim lamports dari POOL_KEYPAIR ke recipient.
 */
async function doWithdraw(recipientStr, amountLamports) {
  const recipient = new PublicKey(recipientStr);

  // 1) Ambil blockhash terbaru
  const { value: { blockhash, lastValidBlockHeight } } =
    await tatumRpc({ jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [] });

  // 2) Buat instruksi transfer
  const ix = SystemProgram.transfer({
    fromPubkey: POOL_PUBKEY,
    toPubkey: recipient,
    lamports: Number(amountLamports)
  });

  // 3) Bangun v0 tx agar size kecil & modern
  const messageV0 = new TransactionMessage({
    payerKey: POOL_PUBKEY,
    recentBlockhash: blockhash,
    instructions: [ix]
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([POOL_KEYPAIR]);

  const raw = Buffer.from(tx.serialize()).toString('base64');

  // 4) Kirim raw tx via Tatum
  const sig = await tatumRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'sendRawTransaction',
    params: [raw, { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 }]
  });

  return { signature: sig, lastValidBlockHeight };
}

async function handleRelay(req, res) {
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
    // Retry sekali kalau blockhash expired
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

/* Routes: kompatibel dengan UI */
app.post('/relay', handleRelay);
app.post('/relay-withdraw', handleRelay);
app.post('/withdraw', handleRelay); // alias agar UI lama tidak 404

/* ---------- Start ---------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`ZKnon backend listening on :${PORT}`);
  console.log('POOL_ADDRESS:', POOL_PUBKEY.toBase58());
  console.log('CORS:', ALLOWED.join(', '));
});
