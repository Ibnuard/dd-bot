/**
 * Doomsday Bot — pure Telegram interface.
 *
 * Flow: user pastes URL → bot extracts → bot replies with the raw video URL
 * plus inline buttons (Watch / Download / Save).
 *
 * Save flow:
 *   - User taps 💾 Save → bot writes the video to data/saved.json under their
 *     chat ID and edits the message buttons to show ✓ Saved.
 *   - /list → numbered list of saved videos for that chat.
 *   - User types a number (e.g. "2") → bot re-issues Watch/Download buttons
 *     for that saved entry.
 *   - /clear → wipes the saved list for the chat.
 *
 * Required env (see .env.example):
 *   TELEGRAM_BOT_TOKEN
 *
 * Optional:
 *   ALLOWED_CHAT_IDS  — comma-separated whitelist; empty = open to anyone
 *   SCRAPERAPI_KEY    — Cloudflare-bypass fallback
 *   PLAYER_BASE_URL   — Vercel player URL; enables Watch/Download buttons
 *   STREAM_SECRET     — shared HMAC secret with the player
 *   DATA_DIR          — where to persist saved.json (default ./data)
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import TelegramBot from 'node-telegram-bot-api';

import { extractVideos } from './extractor.js';
import {
  buildPlayerUrl,
  buildDownloadUrl,
  isConfigured as isPlayerConfigured,
} from './sign.js';
import {
  listSaved,
  getSavedAt,
  saveVideo,
  clearSaved,
} from './storage.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED = (process.env.ALLOWED_CHAT_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!TOKEN) {
  console.error('[bot] TELEGRAM_BOT_TOKEN not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

const isAllowed = (chatId) =>
  ALLOWED.length === 0 || ALLOWED.includes(String(chatId));

const escapeMd = (s) =>
  String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// Pending-save token map.
//
// Telegram caps callback_data at 64 bytes, which is nowhere near enough for
// raw video + source URLs. Instead we mint a short token, stash the URLs in
// memory, and resolve the token when the Save callback fires.
//
// The map is bounded so a long-running bot doesn't accumulate memory; oldest
// tokens are evicted FIFO. Pragmatic: even a chatty user is unlikely to leave
// hundreds of unsaved Watch/Download messages around.
// ---------------------------------------------------------------------------

const PENDING = new Map();
const PENDING_MAX = 500;

function makePendingToken(videoUrl, sourceUrl) {
  const token = crypto.randomBytes(6).toString('base64url'); // 8 chars
  PENDING.set(token, { videoUrl, sourceUrl });
  if (PENDING.size > PENDING_MAX) {
    // Drop the oldest entry. Map iteration is insertion-ordered.
    const oldest = PENDING.keys().next().value;
    PENDING.delete(oldest);
  }
  return token;
}

// ---------------------------------------------------------------------------
// Inline keyboard builder
// ---------------------------------------------------------------------------

function buildVideoKeyboard(videoUrl, sourceUrl, { saved = false } = {}) {
  const playerUrl = buildPlayerUrl(videoUrl, sourceUrl);
  const downloadUrl = buildDownloadUrl(videoUrl, sourceUrl);

  const row = [];
  if (playerUrl) row.push({ text: '📺 Watch', url: playerUrl });
  if (downloadUrl) row.push({ text: '📥 Download', url: downloadUrl });

  if (saved) {
    row.push({ text: '✓ Saved', callback_data: 'noop' });
  } else {
    const token = makePendingToken(videoUrl, sourceUrl);
    row.push({ text: '💾 Save', callback_data: `s:${token}` });
  }

  return row.length > 0 ? { inline_keyboard: [row] } : null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

bot.onText(/^\/start$/, (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  bot.sendMessage(
    msg.chat.id,
    [
      '👋 *Doomsday — Smart Opus*',
      '',
      'Kirim URL halaman video, saya balikin link video aslinya\\.',
      '',
      '*Quick actions:*',
      '• 📺 Watch — putar di browser',
      '• 📥 Download — simpan ke device',
      '• 💾 Save — simpan ke list, akses lagi pakai /list',
      '',
      '_Tip: kalau link diputar di browser ngambek, coba VLC \\(yang bisa set Referer header\\)\\._',
    ].join('\n'),
    { parse_mode: 'MarkdownV2' }
  );
});

bot.onText(/^\/help$/, (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  bot.sendMessage(
    msg.chat.id,
    [
      '*Cara pakai:*',
      '1\\. Kirim URL halaman video',
      '2\\. Tunggu beberapa detik',
      '3\\. Pilih Watch / Download / Save',
      '',
      '*Saved videos:*',
      '/list — lihat semua yang tersimpan',
      'kirim angka \\(misal `2`\\) untuk dapet link video ke\\-2 di list',
      '/clear — kosongkan list saved',
      '',
      '*Cleanup:*',
      '/clearchat — hapus pesan di chat ini \\(48 jam ke belakang\\)',
      '',
      '*Other:*',
      '/start — info',
      '/help — pesan ini',
      '/ping — cek bot',
    ].join('\n'),
    { parse_mode: 'MarkdownV2' }
  );
});

bot.onText(/^\/ping$/, (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  bot.sendMessage(msg.chat.id, '🏓 pong');
});

bot.onText(/^\/list$/, async (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  const list = await listSaved(msg.chat.id);
  if (list.length === 0) {
    return bot.sendMessage(
      msg.chat.id,
      'Belum ada video tersimpan\\. Tap 💾 Save di hasil ekstraksi untuk menyimpan\\.',
      { parse_mode: 'MarkdownV2' }
    );
  }

  const lines = list.map((entry, i) => {
    const date = entry.savedAt ? formatRelative(entry.savedAt) : '';
    const dateStr = date ? ` _\\(${escapeMd(date)}\\)_` : '';
    return `*${i + 1}\\.*${dateStr}\n   \`${escapeMd(entry.videoUrl)}\``;
  });

  await bot.sendMessage(
    msg.chat.id,
    [
      `💾 *${list.length} video tersimpan:*`,
      '',
      ...lines,
      '',
      '_Kirim angka \\(misal `1`\\) untuk dapet tombol Watch/Download\\._',
    ].join('\n'),
    { parse_mode: 'MarkdownV2', disable_web_page_preview: true }
  );
});

bot.onText(/^\/clear$/, async (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  const result = await clearSaved(msg.chat.id);
  bot.sendMessage(
    msg.chat.id,
    result.cleared ? '🧹 List dikosongkan\\.' : 'List sudah kosong\\.',
    { parse_mode: 'MarkdownV2' }
  );
});

/**
 * /clearchat — wipe recent chat history.
 *
 * Walks backward from the command message id, calling deleteMessage on each.
 * Telegram's 48-hour deletion window is the natural stopping point: once we
 * cross it, every call fails. We bail after a streak of failures rather than
 * iterating to message_id 0.
 */
bot.onText(/^\/clearchat$/, async (msg) => {
  if (!isAllowed(msg.chat.id)) return;

  const chatId = msg.chat.id;
  const fromId = msg.message_id;
  const MAX_SCAN = 300;
  const FAIL_STREAK_LIMIT = 20;

  let deleted = 0;
  let streak = 0;

  for (let i = 0; i < MAX_SCAN; i++) {
    const target = fromId - i;
    if (target <= 0) break;
    try {
      await bot.deleteMessage(chatId, target);
      deleted++;
      streak = 0;
    } catch {
      streak++;
      if (streak >= FAIL_STREAK_LIMIT) break;
    }
    // Politeness: stay well under Telegram's per-chat rate limit (~1/s for
    // bursts, but deleteMessage is more forgiving). 50ms gives ~20/s.
    await new Promise((r) => setTimeout(r, 50));
  }

  bot.sendMessage(
    chatId,
    deleted === 0
      ? '🧹 Tidak ada pesan yang bisa dihapus \\(mungkin sudah lewat 48 jam\\)\\.'
      : `🧹 ${deleted} pesan dihapus\\.`,
    { parse_mode: 'MarkdownV2' }
  );
});

// ---------------------------------------------------------------------------
// Free-form text: numeric → fetch saved entry, otherwise treat as URL.
// ---------------------------------------------------------------------------

bot.on('message', async (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

  // Numeric input → look up saved video by 1-based index.
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    const entry = await getSavedAt(msg.chat.id, num - 1);
    if (!entry) {
      const list = await listSaved(msg.chat.id);
      if (list.length === 0) {
        return bot.sendMessage(
          msg.chat.id,
          'Belum ada video tersimpan\\. Pakai 💾 Save dulu\\.',
          { parse_mode: 'MarkdownV2' }
        );
      }
      return bot.sendMessage(
        msg.chat.id,
        `Index tidak valid\\. Pakai angka 1\\-${list.length}\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    }
    const keyboard = buildVideoKeyboard(entry.videoUrl, entry.sourceUrl, {
      saved: true,
    });
    return bot.sendMessage(
      msg.chat.id,
      [
        `*Saved \\#${num}*`,
        `\`${escapeMd(entry.videoUrl)}\``,
      ].join('\n'),
      {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      }
    );
  }

  // URL input → extract.
  let url;
  try {
    url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    return bot.sendMessage(msg.chat.id, '❌ Itu bukan URL yang valid.');
  }

  const status = await bot.sendMessage(
    msg.chat.id,
    `🔍 Sedang ekstrak\\.\\.\\.\n\`${escapeMd(url.toString())}\``,
    { parse_mode: 'MarkdownV2' }
  );

  try {
    const videos = await extractVideos(url.toString());

    if (videos.length === 0) {
      return bot.editMessageText(
        '❌ Tidak ditemukan video pada halaman ini\\.',
        {
          chat_id: msg.chat.id,
          message_id: status.message_id,
          parse_mode: 'MarkdownV2',
        }
      );
    }

    await bot.editMessageText(
      `✅ Ditemukan *${videos.length}* video\\.`,
      {
        chat_id: msg.chat.id,
        message_id: status.message_id,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      }
    );

    for (let i = 0; i < videos.length; i++) {
      const videoUrl = videos[i];
      const keyboard = buildVideoKeyboard(videoUrl, url.toString());

      const body = [
        `*Video ${i + 1}*`,
        `\`${escapeMd(videoUrl)}\``,
      ].join('\n');

      await bot.sendMessage(msg.chat.id, body, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    }
  } catch (e) {
    console.error('[bot] extract error:', e);
    await bot
      .editMessageText(`❌ Error: ${escapeMd(e.message || String(e))}`, {
        chat_id: msg.chat.id,
        message_id: status.message_id,
        parse_mode: 'MarkdownV2',
      })
      .catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Callback queries (Save button)
// ---------------------------------------------------------------------------

bot.on('callback_query', async (cb) => {
  try {
    if (!isAllowed(cb.message?.chat?.id)) {
      return bot.answerCallbackQuery(cb.id, { text: 'Not allowed' });
    }

    const data = cb.data || '';

    if (data === 'noop') {
      return bot.answerCallbackQuery(cb.id);
    }

    if (data.startsWith('s:')) {
      const token = data.slice(2);
      const pending = PENDING.get(token);
      if (!pending) {
        return bot.answerCallbackQuery(cb.id, {
          text: 'Link sudah kedaluwarsa. Ekstrak ulang ya.',
          show_alert: true,
        });
      }

      const { added, count } = await saveVideo(cb.message.chat.id, pending);
      PENDING.delete(token);

      // Replace the keyboard so the Save button becomes ✓ Saved (idempotent).
      const newKeyboard = buildVideoKeyboard(
        pending.videoUrl,
        pending.sourceUrl,
        { saved: true }
      );
      await bot
        .editMessageReplyMarkup(newKeyboard || { inline_keyboard: [] }, {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
        })
        .catch(() => {
          // Editing fails if the message is too old or already changed — fine.
        });

      return bot.answerCallbackQuery(cb.id, {
        text: added
          ? `Disimpan. Total: ${count}. Pakai /list buat liat.`
          : 'Sudah ada di list.',
      });
    }

    return bot.answerCallbackQuery(cb.id);
  } catch (e) {
    console.error('[bot] callback error:', e);
    bot.answerCallbackQuery(cb.id, { text: 'Error' }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelative(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return 'baru aja';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m lalu`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h lalu`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d lalu`;
}

bot.on('polling_error', (e) => console.error('[bot] polling error:', e.message));

console.log('[bot] running.');
console.log(
  `[bot] allowlist: ${ALLOWED.length === 0 ? 'OPEN (anyone can use)' : ALLOWED.join(', ')}`
);
console.log(
  `[bot] player links: ${isPlayerConfigured() ? 'ENABLED' : 'disabled (set PLAYER_BASE_URL + STREAM_SECRET)'}`
);

const shutdown = () => {
  console.log('[bot] shutting down...');
  bot.stopPolling().catch(() => {});
  setTimeout(() => process.exit(0), 2000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
