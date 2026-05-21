/**
 * Saved-videos storage backed by a single JSON file.
 *
 * Layout on disk:
 *   {
 *     "<chatId>": [
 *       { "videoUrl": "...", "sourceUrl": "...", "savedAt": "ISO-8601" },
 *       ...
 *     ]
 *   }
 *
 * Why a JSON file and not SQLite or a real DB?
 *   - Volume of data is tiny (videos saved by individual chat users).
 *   - One file fits in a docker named volume, easy to back up by copying.
 *   - We serialize writes through a single in-process queue so concurrent
 *     callbacks can't corrupt the file mid-rewrite.
 *
 * Atomicity: writes go to <file>.tmp first then rename(). Rename on the same
 * filesystem is atomic on POSIX, so a crash mid-write never leaves a partial
 * primary file behind.
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
    // Corrupt file: surface a warning but don't crash the bot. Returning
    // empty means subsequent saves will overwrite the bad file. We don't
    // auto-delete in case the user wants to recover manually.
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

/**
 * Run a mutator with the file's contents under a serialized lock.
 * Multiple concurrent saves get queued instead of racing.
 */
function enqueue(fn) {
  const next = writeQueue.then(fn);
  // Swallow rejection on the queue tail so one failure doesn't poison the queue.
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

export async function saveVideo(chatId, { videoUrl, sourceUrl }) {
  return enqueue(async () => {
    const all = await readAll();
    const key = String(chatId);
    const list = all[key] || [];

    // Dedup on videoUrl — saving the same link twice is almost always a misclick.
    if (list.some((e) => e.videoUrl === videoUrl)) {
      return { added: false, count: list.length };
    }

    list.push({
      videoUrl,
      sourceUrl: sourceUrl || '',
      savedAt: new Date().toISOString(),
    });
    all[key] = list;
    await writeAll(all);
    return { added: true, count: list.length };
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
