import 'dotenv/config';
import crypto from 'node:crypto';
import { decryptSecret } from '../server/utils/cryptoVault.js';
import fs from 'node:fs';

const vault = JSON.parse(fs.readFileSync('./data/hft_vault.json', 'utf8'));
const apiKey = decryptSecret(vault.encryptedApiKey);
const apiSecret = decryptSecret(vault.encryptedApiSecret);

const insp = (label: string, v: string) => {
  console.log(
    `${label.padEnd(12)} len=${v.length} trimmedLen=${v.trim().length}` +
      ` charsetOk=${/^[A-Za-z0-9]+$/.test(v)} head=${v.slice(0, 4)} tail=${v.slice(-4)}`
  );
};

console.log('=== 1. VAULT DECRYPT & CREDENTIAL SHAPE ===');
if (!apiKey || !apiSecret) {
  console.log('DECRYPT FAILED — HFT_VAULT_SECRET in .env may differ from when keys were saved.');
  process.exit(1);
}
insp('apiKey', apiKey);
insp('apiSecret', apiSecret);
console.log('(Binance keys/secrets are normally 64 alphanumeric chars)');

const serverTime = await fetch('https://api.binance.com/api/v3/time')
  .then((r) => r.json() as Promise<{ serverTime: number }>)
  .then((j) => j.serverTime);
const clockOffset = serverTime - Date.now();
console.log(`\nBinance clock offset: ${clockOffset}ms`);

async function signedGet(base: string, path: string, extra = '') {
  const qs = `${extra ? extra + '&' : ''}timestamp=${Date.now() + clockOffset}&recvWindow=10000`;
  const sig = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
  const res = await fetch(`${base}${path}?${qs}&signature=${sig}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
  });
  return { status: res.status, body: await res.text() };
}

console.log('\n=== 2. SPOT API-KEY RESTRICTIONS (authoritative permission readout) ===');
try {
  const r = await signedGet('https://api.binance.com', '/sapi/v1/account/apiRestrictions');
  console.log('HTTP', r.status, r.body.slice(0, 600));
} catch (e) {
  console.log('request failed:', (e as Error).message);
}

console.log('\n=== 3. FUTURES BALANCE (the call that is returning -2015) ===');
try {
  const r = await signedGet('https://fapi.binance.com', '/fapi/v2/balance');
  console.log('HTTP', r.status, r.body.slice(0, 400));
} catch (e) {
  console.log('request failed:', (e as Error).message);
}

console.log('\n=== 4. ACCOUNT STATE (read-only permission is enabled, so these work) ===');
const probes: [string, string, string, string][] = [
  ['account status', 'https://api.binance.com', '/sapi/v1/account/status', ''],
  ['api trading status', 'https://api.binance.com', '/sapi/v1/account/apiTradingStatus', ''],
  [
    'futures wallet exists?',
    'https://api.binance.com',
    '/sapi/v1/futures/transfer',
    'startTime=1704067200000',
  ],
  ['futures account', 'https://fapi.binance.com', '/fapi/v2/account', ''],
  ['PM account (papi)', 'https://papi.binance.com', '/papi/v1/account', ''],
  ['PM um account', 'https://papi.binance.com', '/papi/v1/um/account', ''],
  ['PM balance', 'https://papi.binance.com', '/papi/v1/balance', ''],
];
for (const [label, base, path, extra] of probes) {
  try {
    const r = await signedGet(base, path, extra);
    console.log(`${label.padEnd(22)} HTTP ${r.status} ${r.body.slice(0, 260)}`);
  } catch (e) {
    console.log(`${label.padEnd(22)} failed: ${(e as Error).message}`);
  }
}
