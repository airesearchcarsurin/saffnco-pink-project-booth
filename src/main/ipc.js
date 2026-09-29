/**
 * Penangan IPC — satu-satunya pintu dari halaman kiosk ke kemampuan native.
 *
 * Setiap penangan menerjemahkan galat menjadi bentuk yang bisa ditampilkan
 * layar kiosk. Electron mengubah galat dari `invoke` menjadi teks yang diawali
 * "Error invoking remote method", dan teks itu muncul apa adanya di layar yang
 * dilihat pengunjung kalau dibiarkan.
 */

'use strict';

const { app, shell } = require('electron');

const config = require('./config');
const log = require('./log');
const { logger } = require('./log');
const { DigiCamError } = require('./digicam');
const { deviceApi } = require('./api');

const logs = logger('ipc');

/** Pesan yang layak dibaca pengunjung maupun operator. */
function present(error) {
  if (error instanceof DigiCamError) {
    return { message: error.message, hint: error.hint ?? null };
  }
  return { message: error.message ?? String(error), hint: null };
}

function register(ipcMain, { camera, relay, queue, heartbeat }) {
  const handle = (channel, run) => {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return await run(payload);
      } catch (error) {
        logs.error(`${channel} gagal`, error);
        const shaped = present(error);
        const wrapped = new Error(shaped.message);
        wrapped.hint = shaped.hint;
        throw wrapped;
      }
    });
  };

  // ── Kamera ──────────────────────────────────────────────────────────────

  handle('camera:connect', async () => {
    const info = await camera.connect();
    const liveViewUrl = await relay.start();
    return { ...info, liveViewUrl };
  });

  handle('camera:capture', async () => {
    const { buffer } = await camera.capture();
    // Buffer Node menyeberang sebagai Uint8Array; preload membungkusnya
    // menjadi Blob lalu ImageBitmap.
    return { bytes: buffer };
  });

  handle('camera:disconnect', async () => {
    await camera.disconnect();
    return { ok: true };
  });

  // ── Antrean ─────────────────────────────────────────────────────────────

  handle('queue:enqueue', (payload) => queue.enqueue(payload));
  handle('queue:list', () => queue.list());
  handle('queue:kick', () => {
    queue.kick();
    return { ok: true };
  });

  // ── Perangkat ───────────────────────────────────────────────────────────

  handle('device:info', async () => ({
    ...config.redacted(),
    appVersion: app.getVersion(),
    camera: camera.label,
    cameraConnected: camera.isConnected,
    queue: await queue.list(),
    logFile: log.currentFile(),
  }));

  /**
   * Menyimpan kunci API dan kode titik.
   *
   * Kuncinya diperiksa ke backend lebih dulu. Menyimpan kunci yang salah
   * menghasilkan perangkat yang terlihat normal sampai sesi pertama dibuat,
   * dan pada saat itu yang bisa dilakukan operator hanya menebak.
   */
  handle('device:pair', async (settings) => {
    const previous = config.get();
    config.save(settings);
    try {
      const verified = await deviceApi.verify(app.getVersion());
      logs.info('Perangkat dipasangkan', { device: verified.code });
      heartbeat.restart();
      return verified;
    } catch (error) {
      config.save({ apiKey: previous.apiKey, deviceCode: previous.deviceCode });
      throw error;
    }
  });

  handle('device:unpair', () => {
    config.save({ apiKey: '' });
    logs.info('Pairing dilepas');
    return { ok: true };
  });

  handle('device:verify', () => deviceApi.verify(app.getVersion()));

  handle('device:open-log', async () => {
    await shell.openPath(log.currentFile());
    return { ok: true };
  });
}

module.exports = { register };
