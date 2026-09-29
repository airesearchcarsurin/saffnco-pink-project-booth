/**
 * Proses utama perangkat booth.
 *
 * Tugasnya empat: membuka satu jendela kiosk, menyambung kamera lewat
 * digiCamControl, menjalankan antrean unggahan, dan berdenyut ke backend.
 * Seluruh alur photobooth-nya sendiri ada di halaman web yang dimuat — sama
 * dengan yang dipakai mode demo — sehingga memperbaiki alur tidak menuntut
 * memasang ulang aplikasi di tiga lokasi.
 */

'use strict';

const path = require('node:path');
const os = require('node:os');

const { app, BrowserWindow, ipcMain, screen, globalShortcut, dialog } = require('electron');

const log = require('./log');
const config = require('./config');
const ipc = require('./ipc');
const { DigiCam } = require('./digicam');
const { LiveViewRelay } = require('./liveview');
const { UploadQueue } = require('./queue');
const { Heartbeat } = require('./heartbeat');

/**
 * Satu perangkat, satu jendela.
 *
 * Instansi kedua akan berebut kamera yang sama lewat digiCamControl, dan
 * gejalanya berupa jepretan yang hilang di salah satu jendela — bukan pesan
 * galat. Lebih baik ditolak di sini.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let window = null;
let camera = null;
let relay = null;
let queue = null;
let heartbeat = null;
let logs = null;

function createWindow(settings) {
  const displays = screen.getAllDisplays();
  const display = displays[settings.displayIndex] ?? screen.getPrimaryDisplay();

  window = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    fullscreen: settings.kiosk,
    kiosk: settings.kiosk,
    frame: !settings.kiosk,
    backgroundColor: '#fdf0f4',
    // Layar hanya tampil setelah halamannya siap. Tanpa ini, pengunjung
    // sempat melihat kotak kosong saat perangkat baru dinyalakan.
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Halaman kiosk memanggil `getUserMedia` di mode web. Di perangkat ini
      // kameranya DSLR, jadi izin itu tidak diperlukan.
      backgroundThrottling: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  window.webContents.on('render-process-gone', (_event, details) => {
    logs.error('Renderer mati', details);
    // Halaman dimuat ulang sendiri. Perangkat berdiri tanpa penjaga, dan
    // layar putih yang menetap berarti titik itu hilang sampai ada yang
    // berjalan ke sana.
    window.reload();
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  loadKiosk(settings);
  return window;
}

function loadKiosk(settings) {
  window.loadURL(settings.kioskUrl).catch((error) => {
    logs.error('Halaman kiosk gagal dimuat', error);
    // Jaringan mal kadang baru siap beberapa detik setelah perangkat menyala.
    setTimeout(() => loadKiosk(config.get()), 5000);
  });
}

/**
 * Jalan keluar untuk operator.
 *
 * Mode kiosk menutup segalanya, termasuk Alt+F4. Tanpa kombinasi ini,
 * satu-satunya cara keluar adalah mencabut daya — yang juga berarti tidak ada
 * cara membuka layar diagnostik.
 */
function registerShortcuts(settings) {
  globalShortcut.register('Control+Shift+Q', () => app.quit());
  globalShortcut.register('Control+Shift+P', () => {
    window?.loadURL(new URL('/pair', settings.kioskUrl).toString());
  });
  globalShortcut.register('Control+Shift+R', () => window?.reload());
  globalShortcut.register('Control+Shift+I', () => window?.webContents.openDevTools());
}

async function start() {
  const userData = app.getPath('userData');
  log.init(path.join(userData, 'logs'));
  logs = log.logger('main');

  const settings = config.load(userData);
  logs.info('Perangkat mulai', {
    version: app.getVersion(),
    host: os.hostname(),
    device: settings.deviceCode || '(belum dipasangkan)',
    kioskUrl: settings.kioskUrl,
  });

  camera = new DigiCam({
    baseUrl: settings.digiCamUrl,
    captureFolder: settings.captureFolder || path.join(userData, 'captures'),
  });
  relay = new LiveViewRelay(camera);

  queue = new UploadQueue({
    root: path.join(userData, 'queue'),
    retrySeconds: settings.queueRetrySeconds,
  });
  await queue.init();

  heartbeat = new Heartbeat(async () => ({
    cameraConnected: camera.isConnected,
    cameraModel: camera.label,
    queueDepth: (await queue.list()).length,
  }));

  queue.onChange((event) => window?.webContents.send('queue:event', event));

  ipc.register(ipcMain, { camera, relay, queue, heartbeat });

  createWindow(settings);
  registerShortcuts(settings);
  heartbeat.start();

  if (!config.isPaired()) {
    logs.warn('Perangkat belum punya kunci API');
    dialog.showMessageBox(window, {
      type: 'info',
      title: 'Perangkat belum dipasangkan',
      message: 'Titik ini belum punya kunci API.',
      detail:
        'Tekan Ctrl+Shift+P untuk membuka layar pairing, lalu masukkan kode ' +
        'titik dan kunci API dari backend.',
    });
  }

  // Dua penyapu berkala. Keduanya membuang berkas perantara yang, kalau
  // dibiarkan, akan memenuhi disk perangkat di pertengahan acara.
  setInterval(() => {
    camera.sweep().catch((error) => logs.warn('Sapu tangkapan gagal', error));
    queue.sweep().catch((error) => logs.warn('Sapu antrean gagal', error));
  }, 30 * 60_000);

  // Antrean dari sesi sebelumnya dilanjutkan tanpa menunggu pemicu apa pun.
  queue.kick();
}

app.whenReady().then(start);

app.on('second-instance', () => {
  window?.focus();
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  heartbeat?.stop();
  queue?.stop();
  await relay?.stop();
  await camera?.disconnect();
  logs?.info('Perangkat berhenti');
});

process.on('unhandledRejection', (reason) => {
  logs?.error('Promise tanpa penangan', reason);
});
