/**
 * Storage smoke test. Run: node scripts/test-storage.mjs
 *
 * Exercises save/list/dedup/clear and concurrent writes against a tmp dir.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dd-bot-storage-'));
process.env.DATA_DIR = tmp;

const { listSaved, getSavedAt, saveVideo, clearSaved } = await import(
  '../storage.js'
);

const CHAT = 12345;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exit(1);
  }
}

// 1. Empty initial list.
let list = await listSaved(CHAT);
assert(list.length === 0, 'initial list should be empty');

// 2. Save one entry.
let r = await saveVideo(CHAT, {
  videoUrl: 'https://cdn.example.com/a.mp4',
  sourceUrl: 'https://example.com/page1',
});
assert(r.added === true && r.count === 1, 'first save should add');

// 3. Dedup on same videoUrl.
r = await saveVideo(CHAT, {
  videoUrl: 'https://cdn.example.com/a.mp4',
  sourceUrl: 'https://example.com/page1',
});
assert(r.added === false && r.count === 1, 'duplicate save should be rejected');

// 4. Save second.
r = await saveVideo(CHAT, {
  videoUrl: 'https://cdn.example.com/b.mp4',
  sourceUrl: 'https://example.com/page2',
});
assert(r.added === true && r.count === 2, 'second save should add');

// 5. listSaved + getSavedAt indexing.
list = await listSaved(CHAT);
assert(list.length === 2, 'list should have 2');
const second = await getSavedAt(CHAT, 1);
assert(
  second && second.videoUrl === 'https://cdn.example.com/b.mp4',
  'index 1 should be the second saved'
);
const oob = await getSavedAt(CHAT, 99);
assert(oob === null, 'out-of-bounds index returns null');

// 6. Concurrent writes shouldn't corrupt.
const concurrent = await Promise.all(
  Array.from({ length: 10 }, (_, i) =>
    saveVideo(CHAT, {
      videoUrl: `https://cdn.example.com/c${i}.mp4`,
      sourceUrl: 'https://example.com/burst',
    })
  )
);
assert(
  concurrent.every((c) => c.added === true),
  'all concurrent unique saves should add'
);
list = await listSaved(CHAT);
assert(list.length === 12, `after burst should be 12, got ${list.length}`);

// 7. Per-chat isolation.
const OTHER = 99999;
await saveVideo(OTHER, { videoUrl: 'https://other.example.com/x.mp4', sourceUrl: '' });
assert((await listSaved(OTHER)).length === 1, 'other chat has 1');
assert((await listSaved(CHAT)).length === 12, 'main chat unchanged');

// 8. Clear.
const c = await clearSaved(CHAT);
assert(c.cleared === true, 'clear should report cleared=true');
assert((await listSaved(CHAT)).length === 0, 'after clear should be empty');
const c2 = await clearSaved(CHAT);
assert(c2.cleared === false, 'second clear reports cleared=false');

await fs.rm(tmp, { recursive: true, force: true });
console.log('OK');
