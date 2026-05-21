/**
 * Saved-pages storage backed by a single JSON file.
 *
 * What we store: just the source page URL (the URL the user originally pasted).
 * Re-extraction happens on demand when the user opens the saved entry, so
 * every playback gets fresh CDN URLs and fresh HMAC signatures.
 *
 * Why not cache extracted video URLs?
 *   - CDN URLs typically carry signed tokens that expire in hours.
 *   - The page URL itself rarely changes; re-extracting is cheap and reliable.
 *   - Smaller, simpler storage.
 *
 * Layout on disk:
 *   {
 *     "<chatId>": [
 *       { "sourceUrl": "...", "savedAt": "ISO-8601" },
 *       ...
 *     ]
 *   }
 *
 * Atomicity: writes go to <file>.tmp then rename(). Atomic on POSIX.
 * Concurrency: a single in-process queue serializes mutations.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const SAVED_FILE = path.join(DATA_DIR, 'saved.json');

let writeQueue = Promise.resolve();

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readAll() {
  try {
    const text = await fs.readFile(SAVED_FILE, 'utf8');
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    console.warn('[storage] saved.json unreadable, treating as empty:', e.message);
    return {};
  }
}

async function writeAll(data) {
  await ensureDir();
  const tmp = SAVED_FILE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, SAVED_FILE);
}

function enqueue(fn) {
  const next = writeQueue.then(fn);
  writeQueue = next.catch(() => {});
  return next;
}

export async function listSaved(chatId) {
  const all = await readAll();
  return all[String(chatId)] || [];
}

export async function getSavedAt(chatId, index) {
  const list = await listSaved(chatId);
  if (index < 0 || index >= list.length) return null;
  return list[index];
}

/**
 * Save a source page URL for a chat.
 * Dedup is based on sourceUrl — saving the same page twice is a no-op.
 */
export async function savePage(chatId, sourceUrl) {
  return enqueue(async () => {
    const all = await readAll();
    const key = String(chatId);
    const list = all[key] || [];

    if (list.some((e) => e.sourceUrl === sourceUrl)) {
      return { added: false, count: list.length };
    }

    list.push({
      sourceUrl,
      savedAt: new Date().toISOString(),
    });
    all[key] = list;
    await writeAll(all);
    return { added: true, count: list.length };
  });
}

export async function removeSavedAt(chatId, index) {
  return enqueue(async () => {
    const all = await readAll();
    const key = String(chatId);
    const list = all[key] || [];
    if (index < 0 || index >= list.length) {
      return { removed: false, count: list.length };
    }
    list.splice(index, 1);
    if (list.length === 0) {
      delete all[key];
    } else {
      all[key] = list;
    }
    await writeAll(all);
    return { removed: true, count: list.length };
  });
}

export async function clearSaved(chatId) {
  return enqueue(async () => {
    const all = await readAll();
    const key = String(chatId);
    const had = Array.isArray(all[key]) && all[key].length > 0;
    delete all[key];
    await writeAll(all);
    return { cleared: had };
  });
}
