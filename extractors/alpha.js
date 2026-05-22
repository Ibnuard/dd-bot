/**
 * Site handler: alpha.
 *
 * Pages from this provider never embed the real CDN URL. The player JS reads
 * a 32-char hex hash from the page (`EP.video.player.hash`), reshuffles it
 * via a base36 transform, and calls /xhr/video/<id> with that as a query
 * param. The JSON response carries the actual signed mp4/hls URLs.
 *
 * Hash transform (reverse-engineered from the player bundle):
 *
 *   encoded =
 *     parseInt(h.substr(0,8), 16).toString(36) +
 *     parseInt(h.substr(8,16), 16).toString(36) +
 *     parseInt(h.substr(16,24), 16).toString(36) +
 *     parseInt(h.substr(24,32), 16).toString(36)
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HOST_PATTERN = /(^|\.)eporner\.com$/i;

export function matchesAlpha(pageUrl) {
  try {
    const u = new URL(pageUrl);
    return HOST_PATTERN.test(u.hostname);
  } catch {
    return false;
  }
}

export async function extractAlpha(pageUrl, fetchImpl) {
  const id = parseId(pageUrl);
  if (!id) return [];

  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };

  // 1. Fetch the page to grab cookies + the per-video hash.
  const pageRes = await fetchImpl(pageUrl, { headers, redirect: 'follow' });
  console.log(`[extractor.alpha] page ${pageUrl} -> ${pageRes.status}`);
  if (!pageRes.ok) return [];

  const html = await pageRes.text();

  const hashMatch = html.match(
    /EP\.video\.player\.hash\s*=\s*['"]([0-9a-f]{32})['"]/i
  );
  if (!hashMatch) {
    console.log('[extractor.alpha] no player hash on page (may be 18+ gated)');
    return [];
  }

  const encoded = encodeHash(hashMatch[1]);
  if (!encoded) return [];

  // Pluck Set-Cookie pairs (Node fetch and node-fetch differ on the API).
  const setCookie =
    pageRes.headers.getSetCookie?.() ||
    (pageRes.headers.raw?.()['set-cookie']) ||
    [pageRes.headers.get('set-cookie')].filter(Boolean);
  const cookieHeader = setCookie
    .filter(Boolean)
    .map((c) => c.split(';')[0])
    .join('; ');

  // 2. Call the internal XHR endpoint with the encoded hash.
  const params = new URLSearchParams({
    hash: encoded,
    domain: 'www.eporner.com',
    pixelRatio: '1',
    playerWidth: '1280',
    playerHeight: '720',
    fallback: 'false',
    embed: 'false',
    supportedFormats: 'dash,hls,mp4',
    _: String(Date.now()),
  });
  const xhrUrl = `https://www.eporner.com/xhr/video/${id}?${params}`;

  const xhrRes = await fetchImpl(xhrUrl, {
    headers: {
      ...headers,
      Accept: '*/*',
      Referer: pageUrl,
      Origin: 'https://www.eporner.com',
      'X-Requested-With': 'XMLHttpRequest',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });
  console.log(`[extractor.alpha] xhr ${id} -> ${xhrRes.status}`);
  if (!xhrRes.ok) return [];

  let json;
  try {
    json = await xhrRes.json();
  } catch {
    return [];
  }

  if (!json?.available) {
    console.log(`[extractor.alpha] not available (code=${json?.code} msg=${json?.message})`);
    return [];
  }

  const out = [];

  // Pick the highest-quality mp4 first; users want the best by default.
  const mp4 = json.sources?.mp4 || {};
  const mp4Entries = Object.entries(mp4)
    .map(([label, value]) => ({
      label,
      src: value?.src,
      heightHint: parseInt(label, 10) || 0,
    }))
    .filter((e) => e.src)
    .sort((a, b) => b.heightHint - a.heightHint);

  if (mp4Entries.length > 0) {
    out.push(mp4Entries[0].src);
  }

  // HLS as a secondary source — useful for adaptive players.
  const hls = json.sources?.hls || {};
  for (const v of Object.values(hls)) {
    if (v?.src) {
      out.push(v.src);
      break;
    }
  }

  return out;
}

function parseId(pageUrl) {
  try {
    const u = new URL(pageUrl);
    let m = u.pathname.match(/\/video-([A-Za-z0-9]+)\//);
    if (m) return m[1];
    m = u.pathname.match(/\/embed\/([A-Za-z0-9]+)\//);
    if (m) return m[1];
    m = u.pathname.match(/\/hd-porn\/([A-Za-z0-9]+)\//);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}

function encodeHash(h) {
  if (!h || h.length !== 32) return null;
  return (
    parseInt(h.substring(0, 8), 16).toString(36) +
    parseInt(h.substring(8, 16), 16).toString(36) +
    parseInt(h.substring(16, 24), 16).toString(36) +
    parseInt(h.substring(24, 32), 16).toString(36)
  );
}
