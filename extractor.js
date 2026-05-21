/**
 * Static HTML extractor.
 *
 * Pure JavaScript port of the original TypeScript implementation.
 * Algorithm:
 *   1. Fetch a page (direct, then ScraperAPI fallback if available)
 *   2. Parse <source>, <video>, and direct mp4/m3u8 URLs
 *   3. Resolve JS variable concatenation and template literals (`${var}`)
 *   4. Recursively follow iframe chains up to 3 levels deep
 *
 * Proxy support:
 *   If HTTPS_PROXY or HTTP_PROXY env var is set (e.g. socks5://127.0.0.1:40000
 *   for Cloudflare WARP), all requests go through it. This is how we bypass
 *   datacenter IP fingerprinting on Cloudflare-protected hosts.
 */

import nodeFetch from 'node-fetch';
import { SocksProxyAgent } from 'socks-proxy-agent';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PROXY_URL =
  process.env.EXTRACTOR_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.HTTP_PROXY ||
  '';
const proxyAgent = PROXY_URL ? new SocksProxyAgent(PROXY_URL) : null;

if (proxyAgent) {
  console.log(`[extractor] routing fetches through proxy: ${PROXY_URL}`);
} else {
  console.log('[extractor] no proxy configured, using direct connection');
}

// Wrapper: use node-fetch + agent when proxy is configured, otherwise
// use native fetch (lighter, no extra hops).
const httpFetch = (url, opts = {}) => {
  if (proxyAgent) {
    return nodeFetch(url, { ...opts, agent: proxyAgent });
  }
  return fetch(url, opts);
};

function resolveUrl(src, base) {
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  if (src.startsWith('//')) return `${base.protocol}${src}`;
  if (src.startsWith('/')) return `${base.origin}${src}`;
  return `${base.origin}/${src}`;
}

function isCloudflareChallenge(html) {
  if (!html || html.length < 1000) return false;
  const lower = html.toLowerCase();
  return (
    lower.includes('just a moment') ||
    lower.includes('cf-chl-bypass') ||
    lower.includes('__cf_chl_') ||
    lower.includes('cf_chl_opt') ||
    (lower.includes('challenge-platform') && lower.includes('cloudflare'))
  );
}

/**
 * Two-tier fetch: direct first, then ScraperAPI if Cloudflare blocks.
 * Returns HTML string or null.
 */
async function fetchHtml(pageUrl, depth, referer) {
  const baseUrl = new URL(pageUrl);
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: referer || `${baseUrl.origin}/`,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': depth === 0 ? 'document' : 'iframe',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': depth === 0 ? 'none' : 'same-origin',
  };

  // Tier 1: direct
  try {
    const response = await httpFetch(pageUrl, { headers, redirect: 'follow' });
    console.log(
      `[extractor] direct depth=${depth} ${pageUrl} -> ${response.status}`
    );

    const blocked =
      response.status === 403 || response.status === 429 || response.status === 503;
    if (response.ok) {
      const html = await response.text();
      if (!isCloudflareChallenge(html)) return html;
      console.log('[extractor] direct hit Cloudflare challenge, trying ScraperAPI');
    } else if (!blocked && response.status < 500) {
      return null;
    }
  } catch (e) {
    console.log('[extractor] direct fetch threw:', e.message);
  }

  // Tier 2: ScraperAPI
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) {
    console.log('[extractor] SCRAPERAPI_KEY not set, no fallback available');
    return null;
  }

  try {
    const looksLikeFile = /\.(mp4|webm|m3u8|mkv|jpg|jpeg|png|gif|pdf|zip)(\?|$)/i.test(
      pageUrl
    );
    const targetUrl = looksLikeFile
      ? pageUrl + (pageUrl.includes('?') ? '&' : '?') + '_h=1'
      : pageUrl;

    const proxyUrl = new URL('https://api.scraperapi.com/');
    proxyUrl.searchParams.set('api_key', key);
    proxyUrl.searchParams.set('url', targetUrl);
    proxyUrl.searchParams.set('render', 'true');
    proxyUrl.searchParams.set('keep_headers', 'true');
    if (referer) proxyUrl.searchParams.set('referer', referer);

    const response = await httpFetch(proxyUrl.toString(), { headers });
    console.log(
      `[extractor] scraperapi depth=${depth} ${pageUrl} -> ${response.status}`
    );

    if (!response.ok) {
      const snippet = await response.text().catch(() => '');
      console.log('[extractor] scraperapi error:', snippet.slice(0, 200));
      return null;
    }

    const html = await response.text();
    if (isCloudflareChallenge(html)) {
      console.log('[extractor] scraperapi response still looks like CF challenge');
      return null;
    }
    return html;
  } catch (e) {
    console.log('[extractor] scraperapi threw:', e.message);
    return null;
  }
}

/**
 * Recursively extract video URLs from a page.
 * Returns deduplicated array of absolute URLs.
 */
export async function extractVideos(pageUrl) {
  const videos = new Set();
  await extractRecursive(pageUrl, 0, undefined, videos);
  return Array.from(videos);
}

async function extractRecursive(pageUrl, depth, referer, videos) {
  if (depth > 3) return;

  let baseUrl;
  try {
    baseUrl = new URL(pageUrl);
  } catch {
    return;
  }

  const html = await fetchHtml(pageUrl, depth, referer);
  if (html === null) return;

  // Build JS variable map: var/let/const NAME = "VALUE"
  const varMap = {};
  const varRegex = /(?:var|let|const)\s+(\w+)\s*=\s*["'`]([^"'`]+)["'`]/g;
  let match;
  while ((match = varRegex.exec(html)) !== null) {
    varMap[match[1]] = match[2];
  }

  const resolveTemplate = (template) => {
    let resolved = template;
    const interpRegex = /\$\{(\w+)\}/g;
    let interp;
    while ((interp = interpRegex.exec(template)) !== null) {
      const varName = interp[1];
      if (!varMap[varName]) return null;
      resolved = resolved.replace(interp[0], varMap[varName]);
    }
    return resolved;
  };

  // <source src="..." type="video/...">
  const sourceRegex =
    /<source[^>]+src=["']([^"']+)["'][^>]*type=["']video\/[^"']+["']/gi;
  while ((match = sourceRegex.exec(html)) !== null) {
    videos.add(resolveUrl(match[1], baseUrl));
  }

  // <video src="...">
  const videoSrcRegex = /<video[^>]+src=["']([^"']+)["']/gi;
  while ((match = videoSrcRegex.exec(html)) !== null) {
    const src = match[1];
    if (!src.startsWith('blob:')) videos.add(resolveUrl(src, baseUrl));
  }

  // Direct video URLs in literal strings (skip unresolved templates with ${...})
  const directVideoRegex =
    /["'`](https?:\/\/[^"'`\s${}]+\.(?:mp4|webm|m3u8|mkv)(?:\?[^"'`\s${}]*)?)["'`]/gi;
  while ((match = directVideoRegex.exec(html)) !== null) {
    videos.add(match[1]);
  }

  // Resolve template literals: `https://.../${var}.mp4`
  const iframeSrcs = [];
  const templateRegex = /`([^`]*\$\{[^`]*)`/g;
  while ((match = templateRegex.exec(html)) !== null) {
    const template = match[1];
    if (!template.includes('/') && !template.includes('http')) continue;

    const resolved = resolveTemplate(template);
    if (!resolved) continue;

    if (/\.(mp4|webm|m3u8|mkv)(\?|$)/i.test(resolved)) {
      videos.add(
        resolved.startsWith('http') ? resolved : resolveUrl(resolved, baseUrl)
      );
    } else if (resolved.startsWith('/') || resolved.startsWith('http')) {
      iframeSrcs.push(resolveUrl(resolved, baseUrl));
    }
  }

  if (videos.size > 0) return;

  // <iframe src="...">
  const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
  while ((match = iframeRegex.exec(html)) !== null) {
    iframeSrcs.push(resolveUrl(match[1], baseUrl));
  }

  // 'path' + varName  (e.g. iframe.src = '/ip129jk?id=' + iframeId)
  const concatRegex = /["']([^"']*\/[^"']*)["']\s*\+\s*(\w+)/g;
  while ((match = concatRegex.exec(html)) !== null) {
    const path = match[1];
    const varName = match[2];
    if (varMap[varName]) {
      const resolved = path + varMap[varName];
      if (resolved.startsWith('/') || resolved.startsWith('http')) {
        iframeSrcs.push(resolveUrl(resolved, baseUrl));
      }
    }
  }

  // varName + 'path' (reversed)
  const concatRegex2 = /(\w+)\s*\+\s*["']([^"']*\/[^"']*)["']/g;
  while ((match = concatRegex2.exec(html)) !== null) {
    const varName = match[1];
    const path = match[2];
    if (varMap[varName]) {
      const resolved = varMap[varName] + path;
      if (resolved.startsWith('/') || resolved.startsWith('http')) {
        iframeSrcs.push(resolveUrl(resolved, baseUrl));
      }
    }
  }

  // iframe.src = '...' literal
  const jsSrcRegex = /(?:iframe\.src|\.src)\s*=\s*['"]([^'"]+)['"]/gi;
  while ((match = jsSrcRegex.exec(html)) !== null) {
    const src = match[1];
    if (src.startsWith('/') || src.startsWith('http')) {
      iframeSrcs.push(resolveUrl(src, baseUrl));
    }
  }

  // Embed/player URLs in JS strings
  const embedRegex =
    /["']((?:https?:\/\/[^"']*)?\/embed[^"']*(?:\?[^"']*)?)["']/gi;
  while ((match = embedRegex.exec(html)) !== null) {
    iframeSrcs.push(resolveUrl(match[1], baseUrl));
  }

  // playerPath / fullURL / videoUrl / file = "..." patterns
  const playerPathRegex =
    /(?:playerPath|fullURL|videoUrl|video_url|file)\s*[:=]\s*["']([^"']+)["']/gi;
  while ((match = playerPathRegex.exec(html)) !== null) {
    const src = match[1];
    if (src.includes('embed') || src.includes('video') || src.includes('player')) {
      iframeSrcs.push(resolveUrl(src, baseUrl));
    }
  }

  // Filter ad/tracking domains
  const filtered = [...new Set(iframeSrcs)].filter(
    (src) =>
      !src.includes('googlesyndication') &&
      !src.includes('googletagmanager') &&
      !src.includes('cloudflareinsights') &&
      !src.includes('adsbygoogle') &&
      !src.includes('pinderecphory') &&
      !src.includes('wpadmngr')
  );

  for (const iframeSrc of filtered) {
    await extractRecursive(iframeSrc, depth + 1, pageUrl, videos);
    if (videos.size > 0) break;
  }
}
