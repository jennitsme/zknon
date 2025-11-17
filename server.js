import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bs58 from 'bs58';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';

// ---------- CORS ----------
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / same origin
      if (allowed.includes(origin)) return cb(null, true);
      return cb(new Error('Origin not allowed'), false);
    },
    credentials: false,
  })
);

// ---------- RPC ----------
const RPC_URL = process.env.RPC_URL;
const TATUM_API_KEY = process.env.TATUM_API_KEY;
if (!RPC_URL || !TATUM_API_KEY) {
  console.error('Missing RPC_URL or TATUM_API_KEY');
  process.exit(1);
}

const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  httpHeaders: { 'x-api-key': TATUM_API_KEY },
});

// ---------- Pool Keypair Loader ----------
function loadPoolKeypair() {
  const b58 = process.env.POOL_SECRET_B58?.trim();
  const json = process.env.POOL_SECRET_JSON?.trim();

  if (b58) {
    try {
      const secret = bs58.decode(b58);
      if (secret.length !== 64 && secret.length !== 32) {
        throw new Error(`decoded length ${secret.length} (expected 32/64)`);
      }
      console.log('POOL key format: base58(64 bytes)');
      return Keypair.fromSecretKey(secret);
    } catch (e) {
      console.error('Failed decode POOL_SECRET_B58:', e.message);
      throw new Error('Invalid POOL_SECRET_B58');
    }
  }

  if (json) {
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error('POOL_SECRET_JSON bukan JSON valid (harus array 64 angka).');
      }
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch (e) {
      console.warn('Warning:', e.message);
      throw new Error('Invalid POOL_SECRET_JSON');
    }
  }

  throw new Error('Set POOL_SECRET_B58 atau POOL_SECRET_JSON');
}

let POOL_KP;
let POOL_PUB;
try {
  POOL_KP = loadPoolKeypair();
  POOL_PUB = new PublicKey(process.env.POOL_ADDRESS);
} catch (e) {
  console.error('Pool key init error:', e.message);
  process.exit(1);
}

const TX_RATELIMIT = Number(process.env.TX_RATELIMIT || 8);
let lastTxTs = 0;
function canSend() {
  const now = Date.now();
  if (now - lastTxTs < 1000 / TX_RATELIMIT) return false;
  lastTxTs = now;
  return true;
}

// ---------- Helpers ----------
async function getBalance(pubkeyStr) {
  const pub = new PublicKey(pubkeyStr);
  const lamports = await connection.getBalance(pub, 'confirmed');
  return lamports;
}

async function sendFromPool(targetStr, lamports) {
  if (!canSend()) throw new Error('Rate limited');

  const target = new PublicKey(targetStr);

  // fresh blockhash to avoid "expired block height"
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

  const ix = SystemProgram.transfer({
    fromPubkey: POOL_PUB,
    toPubkey: target,
    lamports: BigInt(lamports),
  });

  const msg = new TransactionMessage({
    payerKey: POOL_PUB,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([POOL_KP]);

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
    preflightCommitment: 'confirmed',
  });

  const res = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed'
  );

  if (res.value.err) {
    throw new Error(`Relay failed: ${JSON.stringify(res.value.err)}`);
  }
  return sig;
}

// ---------- Routes ----------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    pool: POOL_PUB.toBase58(),
    rpc: 'ok',
  });
});

app.get('/get-balance', async (req, res) => {
  try {
    const addr = req.query.address;
    if (!addr) return res.status(400).json({ ok: false, error: 'address required' });
    const lamports = await getBalance(addr);
    res.json({ ok: true, lamports });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Accept keduanya: /withdraw dan /relay-withdraw
async function handleWithdraw(req, res) {
  try {
    const { target, amountLamports } = req.body || {};
    if (!target || !amountLamports) {
      return res.status(400).json({ ok: false, error: 'target & amountLamports required' });
    }

    const sig = await sendFromPool(target, BigInt(amountLamports));
    res.json({ ok: true, signature: sig });
  } catch (e) {
    const msg = String(e.message || e);
    // Tangani kasus umum
    if (msg.includes('block height')) {
      return res.status(409).json({ ok: false, error: 'Blockhash expired, try again' });
    }
    res.status(500).json({ ok: false, error: msg });
  }
}

app.post('/withdraw', handleWithdraw);
app.post('/relay-withdraw', handleWithdraw);

// ---------- Start ----------
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log(`ZKnon backend listening on :${PORT}`);
  console.log('Allowed origins:', allowed);
  console.log('Pool address:', POOL_PUB.toBase58());
});
