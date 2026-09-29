/**
 * Klien API device, dijalankan dari proses utama.
 *
 * Antreannya harus bisa melanjutkan unggahan setelah perangkat dinyalakan
 * ulang, saat tidak ada halaman yang terbuka. Karena itu panggilan API-nya
 * ada di sini, bukan di renderer.
 *
 * Kunci API tidak pernah menyeberang ke renderer. Halaman kiosk dimuat dari
 * URL Netlify, dan menaruh kunci device di sana berarti menitipkannya pada
 * konteks web.
 */

'use strict';

const { logger } = require('./log');
const config = require('./config');

const log = logger('api');

const MAX_ATTEMPTS = 4;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }

  /**
   * Kesalahan sementara layak dicoba ulang; penolakan permanen tidak.
   *
   * 409 termasuk permanen dengan sengaja: backend membalasnya ketika sesi
   * sudah selesai. Mencoba ulang tidak akan mengubah apa pun, dan
   * memperlakukannya sebagai kegagalan membuat antrean menahan pekerjaan yang
   * sebenarnya sudah beres.
   */
  get retryable() {
    return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

async function call(pathname, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
  const { apiBaseUrl, apiKey } = config.get();
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/api/v1${pathname}`;

  const options = {
    method,
    headers: { 'X-Device-Key': apiKey },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (cause) {
    throw new ApiError(`Tidak bisa menghubungi backend: ${cause.message}`, 0);
  }

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { detail: text };
  }

  if (!response.ok) {
    throw new ApiError(
      parsed?.detail ?? `${method} ${pathname} gagal dengan status ${response.status}`,
      response.status,
      parsed,
    );
  }

  return parsed;
}

async function withRetry(label, run) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const retryable = error instanceof ApiError ? error.retryable : true;
      if (attempt >= MAX_ATTEMPTS || !retryable) throw error;
      log.warn(`${label} gagal, mencoba ulang`, { attempt, error: error.message });
      await sleep(2 ** attempt * 250 + Math.random() * 300);
    }
  }
}

const deviceApi = {
  createSession: (payload) =>
    withRetry('createSession', () => call('/sessions', { method: 'POST', body: payload })),

  signUploads: (code) =>
    withRetry('signUploads', () => call(`/sessions/${code}/uploads`, { method: 'POST' })),

  registerAssets: (code, assets, retakesUsed) =>
    withRetry('registerAssets', () =>
      call(`/sessions/${code}/assets`, {
        method: 'POST',
        body: { assets, retakesUsed },
      }),
    ),

  failSession: (code, reason) =>
    call(`/sessions/${code}/fail`, { method: 'POST', body: { reason } }),

  heartbeat: (payload) => call('/devices/heartbeat', { method: 'POST', body: payload }),

  /**
   * Memeriksa kunci device dengan mengirim satu denyut.
   *
   * Tidak ada endpoint khusus untuk ini, dan memang tidak perlu: denyut sudah
   * menuntut kunci yang sah dan membalas dengan identitas titiknya. Sebagai
   * efek samping yang diinginkan, memasang perangkat langsung membuat titik
   * itu terlihat hidup di dashboard.
   *
   * Tanpa `withRetry` dengan sengaja. Ini dipanggil saat operator menekan
   * "Sambungkan", dan kunci yang salah harus ditolak seketika — bukan setelah
   * empat percobaan yang membuat layar menggantung beberapa detik.
   */
  async verify(appVersion) {
    const response = await call('/devices/heartbeat', {
      method: 'POST',
      body: { appVersion },
    });
    return {
      code: response.device,
      name: response.name,
      location: response.location,
      timezone: response.timezone,
    };
  },
};

/**
 * Mengunggah satu objek ke GCS memakai signed URL.
 *
 * Header-nya ikut ditandatangani. Menambah, menghapus, atau mengubah salah
 * satunya membuat GCS menolak dengan 403 — termasuk header yang biasanya tidak
 * disadari, jadi yang dikirim harus tepat sama dengan yang diberikan backend.
 */
async function putObject(target, buffer) {
  let response;
  try {
    response = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: buffer,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (cause) {
    throw new ApiError(`Jaringan gagal saat mengunggah ${target.kind}: ${cause.message}`, 0);
  }

  if (!response.ok) {
    throw new ApiError(
      `GCS menolak ${target.kind} (${target.variant}) dengan status ${response.status}`,
      response.status,
    );
  }
}

module.exports = { deviceApi, putObject, ApiError, withRetry };
