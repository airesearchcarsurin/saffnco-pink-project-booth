/**
 * Catatan kejadian ke berkas, satu berkas per hari.
 *
 * Perangkat booth berjalan tanpa penjaga di tiga lokasi berbeda. Kalau ada
 * yang aneh pada hari ketiga, satu-satunya keterangan yang tersisa adalah
 * berkas ini — DevTools tidak akan terbuka dan tidak ada yang mengawasi
 * konsol. Karena itu yang dicatat adalah keputusan dan kegagalan, bukan
 * setiap langkah.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

let logDir = null;
let stream = null;
let streamDay = null;

/** Berapa lama catatan disimpan. Acaranya 12 hari; 30 memberi ruang lebih. */
const KEEP_DAYS = 30;

const today = () => new Date().toISOString().slice(0, 10);

function rotate() {
  const day = today();
  if (stream && streamDay === day) return stream;

  stream?.end();
  streamDay = day;
  stream = fs.createWriteStream(path.join(logDir, `booth-${day}.log`), {
    flags: 'a',
  });
  return stream;
}

function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of fs.readdirSync(logDir)) {
    if (!name.startsWith('booth-') || !name.endsWith('.log')) continue;
    const file = path.join(logDir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      // Berkas yang sedang dipakai atau sudah hilang tidak perlu diributkan.
    }
  }
}

function init(directory) {
  logDir = directory;
  fs.mkdirSync(logDir, { recursive: true });
  prune();
  rotate();
}

function write(level, scope, message, extra) {
  const line = [
    new Date().toISOString(),
    level.toUpperCase().padEnd(5),
    scope.padEnd(8),
    message,
    extra === undefined ? '' : safeJson(extra),
  ]
    .join(' ')
    .trimEnd();

  // Konsol tetap diisi supaya `npm run dev` berguna tanpa membuka berkas.
  (level === 'error' ? console.error : console.log)(line);
  if (stream) rotate().write(`${line}\n`);
}

function safeJson(value) {
  if (value instanceof Error) {
    return JSON.stringify({ error: value.message, stack: value.stack });
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const logger = (scope) => ({
  info: (message, extra) => write('info', scope, message, extra),
  warn: (message, extra) => write('warn', scope, message, extra),
  error: (message, extra) => write('error', scope, message, extra),
});

module.exports = { init, logger, currentFile: () => path.join(logDir, `booth-${today()}.log`) };
