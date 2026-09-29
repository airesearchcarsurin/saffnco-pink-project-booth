/**
 * Kendali kamera DSLR lewat web server bawaan digiCamControl.
 *
 * Nikon D5100 dan Sony A6400 sama-sama dikendalikan dari sini. Keduanya
 * berbeda jauh di tingkat protokol — yang satu PTP klasik, yang satu lagi
 * memerlukan mode kendali khusus — dan digiCamControl sudah menyelesaikan
 * perbedaan itu. Menuliskannya sendiri berarti menulis dua penangan berbeda
 * dan menguji keduanya terhadap perangkat keras yang baru tersedia menjelang
 * acara.
 *
 * Yang dipakai adalah antarmuka "single line command" pada port 5513:
 *
 *   /?slc=list&param1=cameras          daftar kamera yang terhubung
 *   /?slc=set&param1=<properti>&param2=<nilai>
 *   /?slc=get&param1=lastcaptured      nama berkas jepretan terakhir
 *   /?slc=capture                      memicu rana
 *   /?slc=LiveViewWnd_Show             membuka jendela live view
 *   /liveview.jpg                      satu bingkai live view saat ini
 *
 * Jawabannya teks biasa, biasanya "OK" atau nilai yang diminta.
 */

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { logger } = require('./log');

const log = logger('digicam');

/** Rana ditunggu paling lama selama ini sebelum dianggap gagal. */
const CAPTURE_TIMEOUT_MS = 15_000;
/** Jeda antar pemeriksaan berkas baru. */
const POLL_MS = 150;
/**
 * Berkas dianggap selesai ditulis setelah ukurannya tidak berubah selama ini.
 *
 * digiCamControl mendaftarkan nama berkas begitu transfer dimulai, bukan
 * setelah selesai. Membaca terlalu cepat menghasilkan JPEG terpotong yang
 * tetap bisa di-decode sebagian — separuh gambar abu-abu, tanpa galat apa pun.
 */
const SETTLE_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class DigiCamError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'DigiCamError';
    this.hint = hint;
  }
}

class DigiCam {
  #baseUrl;
  #captureFolder;
  #connected = false;
  #cameraLabel = null;

  constructor({ baseUrl, captureFolder }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#captureFolder = captureFolder;
  }

  get label() {
    return this.#cameraLabel;
  }

  get isConnected() {
    return this.#connected;
  }

  get liveViewFrameUrl() {
    return `${this.#baseUrl}/liveview.jpg`;
  }

  async #slc(command, param1 = '', param2 = '', { timeoutMs = 5000 } = {}) {
    const url =
      `${this.#baseUrl}/?slc=${encodeURIComponent(command)}` +
      `&param1=${encodeURIComponent(param1)}&param2=${encodeURIComponent(param2)}`;

    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      const error = new DigiCamError('digiCamControl tidak menjawab.', {
        hint:
          'Pastikan digiCamControl sedang berjalan dan web server-nya aktif ' +
          '(File → Settings → Webserver → Enable, port 5513).',
      });
      // Sebab aslinya dibawa supaya catatan berkas bisa membedakan "port
      // tertutup" dari "waktu tunggu habis". Keduanya tampak sama di layar,
      // tetapi penanganannya berbeda jauh.
      error.cause = cause;
      throw error;
    }

    const text = (await response.text()).trim();

    // Web server-nya membalas 200 meskipun perintahnya ditolak, jadi status
    // HTTP tidak bisa dipakai sendirian untuk menilai keberhasilan.
    if (!response.ok || /^error/i.test(text)) {
      throw new DigiCamError(`Perintah "${command}" ditolak: ${text || response.status}`);
    }
    return text;
  }

  async listCameras() {
    const text = await this.#slc('list', 'cameras');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== '-');
  }

  async connect() {
    const cameras = await this.listCameras();
    if (cameras.length === 0) {
      throw new DigiCamError('Tidak ada kamera yang terdeteksi.', {
        hint:
          'Periksa kabel USB, pastikan kamera menyala dan tidak sedang dalam ' +
          'mode pemutaran, lalu tekan Refresh di digiCamControl.',
      });
    }

    this.#cameraLabel = cameras[0];

    await fsp.mkdir(this.#captureFolder, { recursive: true });

    // Kamera harus mengirim berkasnya ke PC. Bila disetel menyimpan ke kartu
    // memori, rana tetap berbunyi dan tidak ada berkas yang pernah muncul —
    // gejalanya persis seperti kamera yang menggantung.
    await this.#slc('set', 'transfer', 'Save_to_PC');
    await this.#slc('set', 'session.folder', this.#captureFolder);
    await this.#slc('set', 'session.filenametemplate', 'booth_$sequence');
    await this.#slc('set', 'session.counter', '1');

    // Live view harus terbuka sebelum /liveview.jpg memberikan apa pun.
    try {
      await this.#slc('LiveViewWnd_Show');
    } catch (error) {
      // Sebagian kamera baru mengizinkan live view setelah lensanya aktif.
      // Sesi tetap bisa berjalan tanpanya, hanya tanpa pratinjau.
      log.warn('Live view tidak bisa dibuka', error);
    }

    this.#connected = true;
    log.info('Kamera tersambung', { camera: this.#cameraLabel });
    return { camera: this.#cameraLabel, cameras };
  }

  async disconnect() {
    this.#connected = false;
    try {
      await this.#slc('LiveViewWnd_Hide');
    } catch {
      // Menutup live view bukan hal yang perlu dipastikan berhasil.
    }
  }

  async #lastCaptured() {
    const value = await this.#slc('get', 'lastcaptured');
    return value === '-' || value === '' ? null : value;
  }

  #resolve(name) {
    return path.isAbsolute(name) ? name : path.join(this.#captureFolder, name);
  }

  /** Menunggu sampai ukuran berkas berhenti bertambah. */
  async #waitUntilComplete(file, deadline) {
    let previous = -1;
    for (;;) {
      if (Date.now() > deadline) {
        throw new DigiCamError('Berkas foto tidak selesai ditransfer tepat waktu.');
      }
      let size;
      try {
        size = (await fsp.stat(file)).size;
      } catch {
        size = -1;
      }
      if (size > 0 && size === previous) return size;
      previous = size;
      await sleep(SETTLE_MS);
    }
  }

  /**
   * Menjepret satu foto dan mengembalikan isi JPEG-nya.
   *
   * Nama berkas sebelum menjepret dicatat lebih dulu dan dibandingkan sesudah,
   * karena digiCamControl tidak memberi tahu kapan jepretan tertentu selesai.
   * Tanpa perbandingan itu, dua jepretan yang berurutan akan mengembalikan
   * berkas yang sama — tepatnya apa yang terjadi saat pengunjung menekan
   * ulangi.
   */
  async capture() {
    if (!this.#connected) throw new DigiCamError('Kamera belum tersambung.');

    const before = await this.#lastCaptured();
    const deadline = Date.now() + CAPTURE_TIMEOUT_MS;

    await this.#slc('capture', '', '', { timeoutMs: CAPTURE_TIMEOUT_MS });

    let name = null;
    while (Date.now() < deadline) {
      const current = await this.#lastCaptured();
      if (current && current !== before) {
        name = current;
        break;
      }
      await sleep(POLL_MS);
    }

    if (!name) {
      throw new DigiCamError('Kamera tidak menghasilkan foto baru.', {
        hint:
          'Biasanya karena fokus otomatis gagal mengunci. Coba naikkan cahaya ' +
          'atau setel lensa ke fokus manual.',
      });
    }

    const file = this.#resolve(name);
    const bytes = await this.#waitUntilComplete(file, deadline);
    const buffer = await fsp.readFile(file);

    log.info('Foto diambil', { file: path.basename(file), bytes });
    return { buffer, file };
  }

  /** Satu bingkai live view, atau null bila belum tersedia. */
  async liveViewFrame() {
    try {
      const response = await fetch(this.liveViewFrameUrl, {
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      return buffer.length > 0 ? buffer : null;
    } catch {
      return null;
    }
  }

  /**
   * Membuang jepretan lama dari folder tangkapan.
   *
   * Satu hari acara menghasilkan ratusan berkas RAW/JPEG di sini, dan
   * satu-satunya gunanya adalah sebagai perantara beberapa detik. Dibiarkan
   * menumpuk, disk perangkat akan penuh di tengah acara.
   */
  async sweep({ olderThanMinutes = 60 } = {}) {
    const cutoff = Date.now() - olderThanMinutes * 60_000;
    let removed = 0;
    let entries;
    try {
      entries = await fsp.readdir(this.#captureFolder);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const file = path.join(this.#captureFolder, entry);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          await fsp.unlink(file);
          removed += 1;
        }
      } catch {
        // Berkas yang masih dipegang digiCamControl dicoba lagi nanti.
      }
    }
    if (removed) log.info('Folder tangkapan dibersihkan', { removed });
    return removed;
  }
}

module.exports = { DigiCam, DigiCamError };
