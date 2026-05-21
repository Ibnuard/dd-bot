/**
 * Smoke test: ensure the bot's HMAC signer (Node crypto) produces a token
 * that the player's verifier (Web Crypto subtle) accepts, and vice-versa.
 *
 * Any divergence here will silently break every player link in production.
 *
 * Run: node scripts/test-sign.mjs
 */

import crypto from 'node:crypto';

const SECRET = 'test-secret-not-for-production';
const VIDEO = 'https://videccdn.xyz/abc.mp4';
const REF = 'https://situs-streaming.com/watch/x';
const EXP = Math.floor(Date.now() / 1000) + 3600;

// ---- bot side (mirrors sign.js) -------------------------------------------
function botSign(secret, { url, ref, exp }) {
  const payload = `u=${url}&r=${ref ?? ''}&e=${exp}`;
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ---- player side (mirrors app/lib/sign.ts using Web Crypto) ---------------
async function playerSign(secret, { url, ref, exp }) {
  const enc = new TextEncoder();
  const payload = `u=${url}&r=${ref ?? ''}&e=${exp}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const bytes = new Uint8Array(sig);
  let str = '';
  for (let i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
  return Buffer.from(str, 'binary')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const params = { url: VIDEO, ref: REF, exp: EXP };

const botToken = botSign(SECRET, params);
const playerToken = await playerSign(SECRET, params);

console.log('bot   :', botToken);
console.log('player:', playerToken);
console.log('match :', botToken === playerToken);

if (botToken !== playerToken) {
  console.error('MISMATCH — signing implementations have diverged');
  process.exit(1);
}

// Edge case: ref omitted (direct stream).
const direct = { url: VIDEO, ref: null, exp: EXP };
const botDirect = botSign(SECRET, direct);
const playerDirect = await playerSign(SECRET, direct);
console.log('\n[direct]');
console.log('bot   :', botDirect);
console.log('player:', playerDirect);
if (botDirect !== playerDirect) {
  console.error('MISMATCH on direct (ref=null)');
  process.exit(1);
}

console.log('\nOK');
