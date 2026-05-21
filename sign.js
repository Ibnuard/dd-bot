/**
 * HMAC signer that mirrors the player's app/lib/sign.ts.
 *
 * Both implementations sign the canonical string "u=<url>&r=<ref>&e=<exp>"
 * with HMAC-SHA256 and base64url-encode the result. Any divergence here will
 * cause every player link to fail verification, so keep this in lock-step.
 */

import crypto from 'node:crypto';

const PLAYER_BASE_URL = (process.env.PLAYER_BASE_URL || '').replace(/\/+$/, '');
const STREAM_SECRET = process.env.STREAM_SECRET || '';

// How long player links stay valid. Long enough that the user can scroll
// back in chat history; short enough that abandoned links can't be reused
// indefinitely.
const LINK_TTL_SECONDS = 24 * 60 * 60;

export function isConfigured() {
  return Boolean(PLAYER_BASE_URL && STREAM_SECRET);
}

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function signPayload(payload) {
  const hmac = crypto.createHmac('sha256', STREAM_SECRET);
  hmac.update(payload);
  return base64UrlEncode(hmac.digest());
}

/**
 * Build a signed /play URL on the player deployment.
 *
 * @param {string} videoUrl - the upstream video URL (mp4, m3u8, etc.)
 * @param {string|null} referer - source page URL the bot extracted from.
 *   Pass null if no Referer is needed; the player will play the URL directly
 *   from the browser without going through the proxy.
 */
export function buildPlayerUrl(videoUrl, referer) {
  if (!isConfigured()) return null;

  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const ref = referer || '';
  const payload = `u=${videoUrl}&r=${ref}&e=${exp}`;
  const sig = signPayload(payload);

  const params = new URLSearchParams({
    u: videoUrl,
    e: String(exp),
    s: sig,
  });
  if (ref) params.set('r', ref);

  return `${PLAYER_BASE_URL}/play?${params.toString()}`;
}

/**
 * Build a signed /api/stream URL with download=1 set.
 *
 * Browsers/mobile clients hitting this URL will get a Content-Disposition:
 * attachment response, triggering their native download manager. Useful for
 * the Telegram "📥 Download" button.
 */
export function buildDownloadUrl(videoUrl, referer) {
  if (!isConfigured()) return null;

  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
  const ref = referer || '';
  const payload = `u=${videoUrl}&r=${ref}&e=${exp}`;
  const sig = signPayload(payload);

  const params = new URLSearchParams({
    url: videoUrl,
    exp: String(exp),
    sig,
    download: '1',
  });
  if (ref) params.set('ref', ref);

  return `${PLAYER_BASE_URL}/api/stream?${params.toString()}`;
}
