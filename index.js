/**
 * Doomsday Bot — pure Telegram interface.
 *
 * Flow: user pastes URL → bot extracts → bot replies with the raw video URL.
 * User's device fetches the video directly from the source CDN.
 *
 * Required env (see .env.example):
 *   TELEGRAM_BOT_TOKEN
 *
 * Optional:
 *   ALLOWED_CHAT_IDS  — comma-separated whitelist; empty = open to anyone
 *   SCRAPERAPI_KEY    — Cloudflare-bypass fallback for Cloudflare-protected sites
 */

import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';

import { extractVideos } from './extractor.js';
import { buildPlayerUrl, isConfigured as isPlayerConfigured } from './sign.js';

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

/**
 * Build a single video block in MarkdownV2.
 *
 * Layout:
 *   *N.* 📺 [Tonton di browser](player_url)
 *   `raw_cdn_url`
 *
 * If the player isn't configured (no PLAYER_BASE_URL/STREAM_SECRET), we drop
 * the player line and just show the raw URL.
 */
function formatVideoBlock(number, videoUrl, sourceUrl) {
  const lines = [`*${number}\\.* \`${escapeMd(videoUrl)}\``];
  const playerUrl = buildPlayerUrl(videoUrl, sourceUrl);
  if (playerUrl) {
    // The (url) part of inline links must escape `)` and `\`; we keep our
    // generated URLs simple enough that this isn't an issue, but escape just
    // in case someone passes a weird upstream.
    const safeUrl = playerUrl.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
    lines.unshift(`*${number}\\.* 📺 [Tonton di browser](${safeUrl})`);
    // Drop the duplicated number on the second line.
    lines[1] = `   \`${escapeMd(videoUrl)}\``;
  }
  return lines.join('\n');
}

bot.onText(/^\/start$/, (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  bot.sendMessage(
    msg.chat.id,
    [
      '👋 *Doomsday — Smart Opus*',
      '',
      'Kirim URL halaman video, saya balikin link video aslinya \\(langsung dari CDN sumbernya\\)\\.',
      '',
      'Contoh URL yang didukung: vidvf, videccdn, dan situs streaming lainnya yang pakai static HTML\\.',
      '',
      '_Tip: kalau link tidak bisa diputar langsung di browser, coba buka pakai IDM atau VLC \\(yang bisa set Referer header\\)\\._',
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
      '3\\. Saya kirim balik link video aslinya',
      '',
      '*Commands:*',
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

// Non-command text → treat as URL to extract
bot.on('message', async (msg) => {
  if (!isAllowed(msg.chat.id)) return;
  const text = msg.text?.trim();
  if (!text || text.startsWith('/')) return;

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

    // Reply: one block per video. When the player is configured, surface
    // a 📺 link that goes through our proxy (handles Referer + HLS rewrite),
    // and keep the raw CDN URL below for IDM/VLC users.
    const header = `\u2705 Ditemukan *${videos.length}* video\n`;
    const blocks = videos
      .map((videoUrl, i) => formatVideoBlock(i + 1, videoUrl, url.toString()))
      .join('\n\n');

    await bot.editMessageText([header, blocks].join('\n'), {
      chat_id: msg.chat.id,
      message_id: status.message_id,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
    });
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

bot.on('polling_error', (e) => console.error('[bot] polling error:', e.message));

console.log(`[bot] running.`);
console.log(
  `[bot] allowlist: ${ALLOWED.length === 0 ? 'OPEN (anyone can use)' : ALLOWED.join(', ')}`
);
console.log(
  `[bot] player links: ${isPlayerConfigured() ? 'ENABLED' : 'disabled (set PLAYER_BASE_URL + STREAM_SECRET)'}`
);

// Graceful shutdown
const shutdown = () => {
  console.log('[bot] shutting down...');
  bot.stopPolling().catch(() => {});
  setTimeout(() => process.exit(0), 2000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
