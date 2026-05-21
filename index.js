/**
 * Doomsday Bot — pure Telegram interface.
 *
 * Flow: user pastes URL → bot extracts → bot replies with the raw video URLs
 * plus inline buttons (Watch / Download / Save).
 *
 * Save flow:
 *   - User taps 💾 Save on the status message → bot stores the source PAGE URL
 *     (not the extracted video URL) under their chat ID.
 *   - /list → numbered list of saved pages.
 *   - User types a number → bot re-runs extraction on the saved page so they
 *     always get fresh CDN URLs and fresh HMAC links.
 *   - /clear → wipes the saved list.
 *
 * Why save the page URL, not the video URL?
 *   CDN URLs typically embed signed tokens that expire in hours. Saving the
 *   page URL means the user always gets a working link, at the cost of one
 *   extra extraction round-trip when opening a saved entry.
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
  savePage,
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
// Telegram caps callback_data at 64 bytes. The page URL alone often exceeds
// that, so we mint a short token and stash the URL in memory; the callback
// looks it up. Bounded FIFO eviction stops the map from growing unbounded.
// ---------------------------------------------------------------------------

const PENDING = new Map();
const PENDING_MAX = 500;

function makePendingToken(sourceUrl) {
  const token = crypto.randomBytes(6).toString('base64url'); // 8 chars
  PENDING.set(token, { sourceUrl });
  if (PENDING.size > PENDING_MAX) {
    const oldest = PENDING.keys().next().value;
    PENDING.delete(oldest);
  }
  return token;
}

// ---------------------------------------------------------------------------
// Inline keyboards
// ---------------------------------------------------------------------------

/** Buttons for an individual extracted video URL. */
function buildVideoKeyboard(videoUrl, sourceUrl) {
  const playerUrl = buildPlayerUrl(videoUrl, sourceUrl);
  const downloadUrl = buildDownloadUrl(videoUrl, sourceUrl);

  const row = [];
  if (playerUrl) row.push({ text: '📺 Watch', url: playerUrl });
  if (downloadUrl) row.push({ text: '📥 Download', url: downloadUrl });

  return row.length > 0 ? { inline_keyboard: [row] } : null;
}

/**
 * Save button keyboard for the status/header message — saves the SOURCE PAGE
 * URL, not any individual extracted video.
 */
function buildSavePageKeyboard(sourceUrl, { saved = false } = {}) {
  if (saved) {
    return {
      inline_keyboard: [[{ text: '✓ Tersimpan', callback_data: 'noop' }]],
    };
  }
  const token = makePendingToken(sourceUrl);
  return {
    inline_keyboard: [[{ text: '💾 Simpan halaman ini', callback_data: `s:${token}` }]],
  };
}

// ---------------------------------------------------------------------------
// Shared extraction-and-reply pipeline.
//
// Used by:
//   - paste-URL flow (user typed a URL into chat)
//   - saved-list flow (user typed a number that maps to a saved page)
//
// Sends a status message, runs extraction, edits the status when done and
// posts one message per extracted video with Watch/Download buttons. The
// status message gets a 💾 Save button when `saveable` is true.
// ---------------------------------------------------------------------------

async function extractAndReply(chatId, sourceUrl, { saveable = true } = {}) {
  const status = await bot.sendMessage(
    chatId,
    `🔍 Sedang ekstrak\\.\\.\\.\n\`${escapeMd(sourceUrl)}\``,
    { parse_mode: 'MarkdownV2' }
  );

  let videos;
  try {
    videos = await extractVideos(sourceUrl);
  } catch (e) {
    console.error('[bot] extract error:', e);
    return bot
      .editMessageText(`❌ Error: ${escapeMd(e.message || String(e))}`, {
        chat_id: chatId,
        message_id: status.message_id,
        parse_mode: 'MarkdownV2',
      })
      .catch(() => {});
  }

  if (videos.length === 0) {
    return bot.editMessageText('❌ Tidak ditemukan video pada halaman ini\\.', {
      chat_id: chatId,
      message_id: status.message_id,
      parse_mode: 'MarkdownV2',
    });
  }

  const headerText = [
    `✅ Ditemukan *${videos.length}* video dari:`,
    `\`${escapeMd(sourceUrl)}\``,
  ].join('\n');

  await bot.editMessageText(headerText, {
    chat_id: chatId,
    message_id: status.message_id,
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
    ...(saveable ? { reply_markup: buildSavePageKeyboard(sourceUrl) } : {}),
  });

  for (let i = 0; i < videos.length; i++) {
    const videoUrl = videos[i];
    const keyboard = buildVideoKeyboard(videoUrl, sourceUrl);

    const body = [`*Video ${i + 1}*`, `\`${escapeMd(videoUrl)}\``].join('\n');

    await bot.sendMessage(chatId, body, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }
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
      '*Quick actions per video:*',
      '• 📺 Watch — putar di browser',
      '• 📥 Download — simpan ke device',
      '',
      '*Save halaman:*',
      '• 💾 Simpan halaman ini — append ke /list',
      '• `/list` lalu kirim angka — re\\-extract halaman tersimpan dengan link fresh',
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
      '2\\. Pilih Watch / Download per video',
      '3\\. Atau tap 💾 Simpan halaman ini di header hasil',
      '',
      '*Saved pages:*',
      '/list — lihat halaman yang tersimpan',
      'kirim angka \\(misal `2`\\) — extract ulang halaman ke\\-2 dengan link fresh',
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
      'Belum ada halaman tersimpan\\. Tap 💾 Simpan halaman ini di hasil ekstraksi\\.',
      { parse_mode: 'MarkdownV2' }
    );
  }

  const lines = list.map((entry, i) => {
    const date = entry.savedAt ? formatRelative(entry.savedAt) : '';
    const dateStr = date ? ` _\\(${escapeMd(date)}\\)_` : '';
    return `*${i + 1}\\.*${dateStr}\n   \`${escapeMd(entry.sourceUrl)}\``;
  });

  await bot.sendMessage(
    msg.chat.id,
    [
      `💾 *${list.length} halaman tersimpan:*`,
      '',
      ...lines,
      '',
      '_Kirim angka \\(misal `1`\\) untuk extract ulang halaman tsb\\._',
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
 * Telegram's 48-hour deletion window is the natural stopping point.
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
// Free-form text: numeric → re-extract saved page; otherwise treat as URL.
// ---------------------------------------------------------------------------

bot.on('message', async (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

  // Numeric input → load saved entry and re-extract for fresh URLs.
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    const entry = await getSavedAt(msg.chat.id, num - 1);
    if (!entry) {
      const list = await listSaved(msg.chat.id);
      if (list.length === 0) {
        return bot.sendMessage(
          msg.chat.id,
          'Belum ada halaman tersimpan\\. Pakai 💾 Simpan dulu\\.',
          { parse_mode: 'MarkdownV2' }
        );
      }
      return bot.sendMessage(
        msg.chat.id,
        `Index tidak valid\\. Pakai angka 1\\-${list.length}\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    }

    // Re-run the same pipeline as a fresh paste, but skip the Save button
    // since it's already saved (typing the number means it came from /list).
    return extractAndReply(msg.chat.id, entry.sourceUrl, { saveable: false });
  }

  // URL input → extract.
  let url;
  try {
    url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    return bot.sendMessage(msg.chat.id, '❌ Itu bukan URL yang valid.');
  }

  return extractAndReply(msg.chat.id, url.toString(), { saveable: true });
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
          text: 'Tombol sudah kedaluwarsa. Ekstrak ulang ya.',
          show_alert: true,
        });
      }

      const { added, count } = await savePage(cb.message.chat.id, pending.sourceUrl);
      PENDING.delete(token);

      // Replace the keyboard so the Save button becomes ✓ Tersimpan.
      await bot
        .editMessageReplyMarkup(buildSavePageKeyboard(pending.sourceUrl, { saved: true }), {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
        })
        .catch(() => {});

      return bot.answerCallbackQuery(cb.id, {
        text: added
          ? `Disimpan. Total: ${count}. Kirim angka untuk akses /list.`
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
