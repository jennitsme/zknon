/* ZKnon minimal backend — Express + Solana
 * Fitur:
 * - GET  /health            : status & pubkey pool
 * - GET  /address           : alamat pool signer
 * - GET  /balance?address=  : saldo SOL (lamports -> SOL)
 * - GET  /blockhash         : latest blockhash (finalized)
 * - POST /submit            : kirim tx base64 (frontend)
 * - POST /withdraw          : server-sign transfer dari pool -> to
 * - POST /rpc               : proxy JSON-RPC ke Tatum (optional)
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const bs58 = require('bs58');
const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');

const PORT = process.env.PORT || 8080;

// ====== ENV ======
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const TATUM_API_KEY = process.env.TATUM_API_KEY || '';
const TX_RATELIMIT = Number(process.env.TX_RATELIMIT || 8); // per menit

// Pool signer (private key) bisa dari salah satu env ini:
const POOL_SECRET_B58 = process.env.POOL_SECRET_B58 || '';
const POOL_SECRET_JSON = process.env.POOL_SECRET_JSON || ''; // JSON array 64 angka (satu baris)
const POOL_ADDRESS_HINT = process.env.POOL_ADDRESS || ''; // opsional: untuk sanity check

// ====== Koneksi RPC (dengan header x-api-key untuk Tatum) ======
const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  httpHeaders: TATUM_API_KEY ? { 'x-api-key': TATUM_API_KEY } : undefined,
});

// ====== Load pool signer ======
function loadPoolKeypair() {
  if (POOL_SECRET_B58) {
    const raw = bs58.decode(POOL_SECRET_B58.trim());
    if (raw.length !== 64) {
      throw new Error(
        `POOL_SECRET_B58 harus decode menjadi 64 bytes, sekarang ${raw.length}`
      );
    }
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  if (POOL_SECRET_JSON) {
    let arr;
    try {
      arr = JSON.parse(POOL_SECRET_JSON);
    } catch (e) {
      throw new Error('POOL_SECRET_JSON bukan JSON valid (harus array 64 angka).');
    }
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new Error('POOL_SECRET_JSON harus array 64 angka.');
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  throw new Error('Set salah satu: POOL_SECRET_B58 atau POOL_SECRET_JSON');
}

const poolKeypair = loadPoolKeypair();
const POOL_PUBKEY = poolKeypair.publicKey;
if (POOL_ADDRESS_HINT && POOL_ADDRESS_HINT !== POOL_PUBKEY.toBase58()) {
  console.warn(
    `[WARN] POOL_ADDRESS (${POOL_ADDRESS_HINT}) != signer pubkey (${POOL_PUBKEY.toBase58()})`
  );
}

// ====== Server ======
const app = express();

// CORS
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // tools seperti curl/postman
      const ok =
        ALLOWED_ORIGINS.includes(origin) ||
        /^(http:\/\/|https:\/\/)localhost(:\d+)?$/.test(origin);
      cb(ok ? null : new Error('CORS: origin not allowed'), ok);
    },
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

// ====== helper ======
const ipBucket = new Map(); // rate limit per-IP
function rateLimit(req, res, next) {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60_000;
    const entry = ipBucket.get(ip) || { ts: now, n: 0 };
    if (now - entry.ts > windowMs) {
      entry.ts = now;
      entry.n = 0;
    }
    entry.n++;
    ipBucket.set(ip, entry);
    if (entry.n > TX_RATELIMIT) {
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded' });
    }
    next();
  } catch {
    next();
  }
}

function toLamports(input) {
  if (typeof input === 'number') return Math.round(input);
  if (typeof input === 'string') return Math.round(Number(input));
  return NaN;
}

// ====== routes ======
app.get('/health', async (req, res) => {
  try {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
    res.json({
      ok: true,
      pool: POOL_PUBKEY.toBase58(),
      rpc: RPC_URL,
      blockhash,
      lastValidBlockHeight,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/address', (req, res) => {
  res.json({ ok: true, address: POOL_PUBKEY.toBase58() });
});

app.get('/balance', async (req, res) => {
  try {
    const target = new PublicKey(req.query.address || POOL_PUBKEY.toBase58());
    const lamports = await connection.getBalance(target, 'confirmed');
    res.json({
      ok: true,
      address: target.toBase58(),
      lamports,
      sol: lamports / LAMPORTS_PER_SOL,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.get('/blockhash', async (req, res) => {
  try {
    const info = await connection.getLatestBlockhash('finalized');
    res.json({ ok: true, ...info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Kirim tx base64 yang sudah ditandatangani di FE (mis. wallet user)
app.post('/submit', rateLimit, async (req, res) => {
  try {
    const { txBase64, skipPreflight } = req.body || {};
    if (!txBase64) return res.status(400).json({ ok: false, error: 'txBase64 required' });
    const sig = await connection.sendRawTransaction(
      Buffer.from(txBase64, 'base64'),
      { skipPreflight: !!skipPreflight, maxRetries: 3 }
    );
    res.json({ ok: true, signature: sig, explorer: `https://solscan.io/tx/${sig}` });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Server-sign withdraw dari pool signer → recipient
app.post('/withdraw', rateLimit, async (req, res) => {
  try {
    const { to, amountSol, amountLamports, memo } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: '"to" required' });

    const recipient = new PublicKey(to);
    let lamports;
    if (amountLamports != null) {
      lamports = toLamports(amountLamports);
    } else if (amountSol != null) {
      lamports = Math.round(Number(amountSol) * LAMPORTS_PER_SOL);
    }
    if (!Number.isFinite(lamports) || lamports <= 0) {
      return res.status(400).json({ ok: false, error: 'amount invalid' });
    }

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

    const tx = new Transaction({
      feePayer: POOL_PUBKEY,
      recentBlockhash: blockhash,
    }).add(
      SystemProgram.transfer({
        fromPubkey: POOL_PUBKEY,
        toPubkey: recipient,
        lamports,
      })
    );

    // (opsional) tambah memo
    if (memo && typeof memo === 'string' && memo.length <= 96) {
      const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
      tx.add({
        keys: [],
        programId: MEMO_PROGRAM_ID,
        data: Buffer.from(memo, 'utf8'),
      });
    }

    tx.sign(poolKeypair);

    const raw = tx.serialize();
    const sig = await connection.sendRawTransaction(raw, { maxRetries: 3 });
    const conf = await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    res.json({
      ok: true,
      signature: sig,
      confirmation: conf?.value,
      explorer: `https://solscan.io/tx/${sig}`,
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Proxy JSON-RPC (opsional; FE bisa post body JSON ke /rpc)
app.post('/rpc', rateLimit, async (req, res) => {
  try {
    const resp = await fetch(RPC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(TATUM_API_KEY ? { 'x-api-key': TATUM_API_KEY } : {}),
      },
      body: JSON.stringify(req.body || {}),
    });
    const data = await resp.text();
    res.status(resp.status).send(data);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`[ZKnon] up on :${PORT}`);
  console.log(`Pool signer: ${POOL_PUBKEY.toBase58()}`);
});
