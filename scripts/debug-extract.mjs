/**
 * Extractor debug helper.
 *
 * Fetches a page through the same proxy/headers the real extractor uses,
 * dumps the HTML to /tmp, and surfaces the most likely-relevant snippets:
 *   - <video> / <source> / <iframe> tags
 *   - Strings containing ".mp4", ".m3u8", ".webm"
 *   - JS config blobs (EP.config, videojs(), playerConfig, etc.)
 *   - Common video URL key names (file, src, hlsUrl, videoUrl, ...)
 *
 * Usage (run inside the running container so WARP proxy works):
 *   docker compose exec bot node scripts/debug-extract.mjs <URL>
 *
 * Or on the host, with EXTRACTOR_PROXY pointed at your proxy:
 *   EXTRACTOR_PROXY=socks5://127.0.0.1:40001 node scripts/debug-extract.mjs <URL>
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nodeFetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';

const URL_ARG = process.argv[2];
if (!URL_ARG) {
  console.error('usage: node scripts/debug-extract.mjs <url>');
  process.exit(1);
}

const PROXY_URL =
  process.env.EXTRACTOR_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  '';
const proxyAgent = PROXY_URL ? new SocksProxyAgent(PROXY_URL) : null;

console.log('proxy:', PROXY_URL || '(none)');
console.log('url:  ', URL_ARG);
console.log();

const headers = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: new URL(URL_ARG).origin + '/',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
};

const fetcher = proxyAgent
  ? (u, o) => nodeFetch(u, { ...o, agent: proxyAgent })
  : (u, o) => fetch(u, o);

const res = await fetcher(URL_ARG, { headers, redirect: 'follow' });
console.log(`status: ${res.status} ${res.statusText}`);
console.log(`content-type: ${res.headers.get('content-type')}`);
console.log(`length: ${res.headers.get('content-length') || '(stream)'}`);

const html = await res.text();
console.log(`html length: ${html.length}\n`);

const dump = path.join(os.tmpdir(), `dd-debug-${Date.now()}.html`);
await fs.writeFile(dump, html, 'utf8');
console.log(`saved full html to: ${dump}\n`);

// --- title / cf-challenge sanity check -------------------------------------
const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
console.log(`<title>: ${title.trim().slice(0, 100)}`);

if (/just a moment|attention required/i.test(title)) {
  console.log('!! this looks like a Cloudflare challenge, not the real page');
  process.exit(0);
}
console.log();

// --- video-related tags ----------------------------------------------------
function showMatches(label, regex, max = 10) {
  const seen = new Set();
  let m;
  let count = 0;
  while ((m = regex.exec(html)) !== null) {
    const s = m[0].length > 250 ? m[0].slice(0, 250) + '…' : m[0];
    if (seen.has(s)) continue;
    seen.add(s);
    if (count === 0) console.log(`---- ${label} ----`);
    console.log(s);
    count++;
    if (count >= max) {
      console.log(`(... ${label}: stopped after ${max})`);
      break;
    }
  }
  if (count > 0) console.log();
}

showMatches('<video> tags', /<video[^>]*>/gi);
showMatches('<source> tags', /<source[^>]*>/gi);
showMatches('<iframe> tags', /<iframe[^>]*>/gi);

// --- direct media URLs -----------------------------------------------------
showMatches(
  'mp4/m3u8/webm URLs',
  /https?:\/\/[^\s"'<>]+\.(?:mp4|m3u8|webm|mkv)(?:\?[^\s"'<>]*)?/gi,
  20
);

// --- common JS config keys -------------------------------------------------
showMatches(
  'JS config keys',
  /(?:file|src|url|hlsUrl|videoUrl|video_url|playerPath|fullURL|sources|setup)\s*[:=]\s*['"`][^'"`\n]{8,200}['"`]/gi,
  20
);

// --- JSON-like config blocks (eporner often has hash + redirect logic) ----
showMatches(
  'config-ish JSON',
  /(?:EP[A-Za-z]*|player[A-Za-z]*|config)\s*[:=]\s*\{[^{}]{0,300}\}/g,
  8
);

// --- script srcs (player libs sometimes hint at framework) -----------------
showMatches('script srcs', /<script[^>]+src=["'][^"']+["']/gi, 6);

console.log('\nDone. Inspect the dump if nothing above matches:');
console.log(`  less ${dump}`);
console.log('Look for the player init block (often near the bottom).');
