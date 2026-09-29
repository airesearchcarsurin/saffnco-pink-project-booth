/**
 * Antrean unggahan yang selamat dari mati lampu.
 *
 * Bentuknya satu folder per sesi di disk: delapan belas berkas hasil ditambah
 * `job.json`. Setelah folder itu utuh, sesinya aman — perangkat boleh mati,
 * jaringan boleh hilang, dan unggahannya dilanjutkan saat aplikasi hidup lagi.
 *
 * Mengapa berkas, bukan SQLite
 * ----------------------------
 * Rencana awalnya SQLite. Tetapi `better-sqlite3` adalah modul native yang
 * harus dikompilasi ulang untuk setiap versi Electron, dan kegagalannya
 * berbentuk aplikasi yang tidak mau start sama sekali dengan pesan ABI —
 * persis jenis kerusakan yang muncul setelah pembaruan dan tidak bisa
 * diperbaiki dari lokasi acara. Yang diminta dari penyimpanan ini hanyalah
 * "simpan belasan pekerjaan, lanjutkan yang belum selesai", dan untuk itu
 * folder di disk memberi jaminan daya tahan yang sama tanpa satu pun
 * dependensi native.
 *
 * Nilai tambahnya: operator bisa membuka foldernya dan melihat sendiri sesi
 * mana yang tertahan, tanpa alat apa pun.
 *
 * Penulisannya selalu lewat berkas sementara lalu ganti nama, sehingga
 * `job.json` tidak pernah dibaca dalam keadaan separuh jadi.
 */

'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');

const { logger } = require('./log');
const { deviceApi, putObject, ApiError } = require('./api');

const log = logger('queue');

const MANIFEST = 'job.json';
/** Berapa lama pekerjaan gagal ditahan sebelum dibuang. */
const KEEP_FAILED_HOURS = 72;

/**
 * Preview diunggah lebih dulu.
 *
 * Pengunjung yang memindai QR hanya memerlukan preview untuk melihat
 * kesembilan hasil. Mendahulukannya berarti halaman hasilnya sudah terisi
 * beberapa detik sebelum berkas aslinya selesai naik.
 */
const variantOrder = (variant) => (variant === 'preview' ? 0 : 1);

async function writeJson(file, value) {
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2));
  await fsp.rename(temp, file);
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

class UploadQueue {
  #root;
  #retryMs;
  #running = false;
  #timer = null;
  #listeners = new Set();
  /** Sesi yang sedang dikerjakan, supaya dua pemicu tidak berebut. */
  #active = null;

  constructor({ root, retrySeconds = 20 }) {
    this.#root = root;
    this.#retryMs = retrySeconds * 1000;
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn('Pendengar antrean melempar galat', error);
      }
    }
  }

  async init() {
    await fsp.mkdir(this.#root, { recursive: true });
    const pending = await this.list();
    if (pending.length > 0) {
      log.info('Pekerjaan tertunda ditemukan saat mulai', {
        jobs: pending.map((job) => job.code),
      });
    }
    return pending;
  }

  #dir(code) {
    return path.join(this.#root, code);
  }

  /**
   * Menyimpan hasil satu sesi ke disk dan mengantrekannya.
   *
   * Dipanggil renderer setelah pengolahan gambar selesai. Berkasnya ditulis
   * lebih dulu, `job.json` paling akhir — urutan itulah yang membuat folder
   * separuh jadi tidak pernah terlihat seperti pekerjaan yang siap dikerjakan.
   */
  async enqueue({ code, clientSessionId, retakesUsed = 0, objects }) {
    const dir = this.#dir(code);
    await fsp.mkdir(dir, { recursive: true });

    const entries = [];
    for (const object of objects) {
      const name = `${object.kind}.${object.variant}.bin`;
      await fsp.writeFile(path.join(dir, name), Buffer.from(object.bytes));
      entries.push({
        kind: object.kind,
        variant: object.variant,
        file: name,
        width: object.width,
        height: object.height,
        bytes: object.bytes.byteLength ?? object.bytes.length,
        uploaded: false,
      });
    }

    entries.sort(
      (a, b) => variantOrder(a.variant) - variantOrder(b.variant) || a.kind.localeCompare(b.kind),
    );

    await writeJson(path.join(dir, MANIFEST), {
      code,
      clientSessionId,
      retakesUsed,
      entries,
      registered: false,
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
    });

    log.info('Sesi diantrekan', { code, objects: entries.length });
    this.#emit({ type: 'enqueued', code });
    this.kick();
    return { code, objects: entries.length };
  }

  /** Daftar pekerjaan yang masih ada di disk. */
  async list() {
    let names;
    try {
      names = await fsp.readdir(this.#root);
    } catch {
      return [];
    }

    const jobs = [];
    for (const name of names) {
      try {
        const job = await readJson(path.join(this.#dir(name), MANIFEST));
        jobs.push({
          code: job.code,
          createdAt: job.createdAt,
          attempts: job.attempts,
          lastError: job.lastError,
          registered: job.registered,
          remaining: job.entries.filter((entry) => !entry.uploaded).length,
          total: job.entries.length,
        });
      } catch {
        // Folder tanpa manifest yang sah adalah sisa penulisan yang terputus.
        // Dibiarkan, dan akan terbuang oleh `sweep`.
      }
    }
    return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Memicu pemrosesan tanpa menunggu hasilnya. */
  kick() {
    if (this.#running) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#drain(), 0);
  }

  async #drain() {
    if (this.#running) return;
    this.#running = true;

    try {
      for (;;) {
        const jobs = await this.list();
        const next = jobs.find((job) => job.code !== this.#active);
        if (!next) break;

        this.#active = next.code;
        const done = await this.#process(next.code);
        this.#active = null;

        // Pekerjaan yang gagal tidak dicoba lagi segera. Penyebab paling
        // sering adalah Wi-Fi mal yang sedang penuh, dan mencoba terus hanya
        // memperburuk keadaan sambil menghabiskan baterai.
        if (!done) {
          this.#timer = setTimeout(() => this.#drain(), this.#retryMs);
          break;
        }
      }
    } catch (error) {
      log.error('Antrean berhenti tak terduga', error);
      this.#timer = setTimeout(() => this.#drain(), this.#retryMs);
    } finally {
      this.#running = false;
    }
  }

  /** Mengembalikan true bila pekerjaan itu selesai dan foldernya dihapus. */
  async #process(code) {
    const dir = this.#dir(code);
    const manifestFile = path.join(dir, MANIFEST);

    let job;
    try {
      job = await readJson(manifestFile);
    } catch (error) {
      log.warn('Manifest tidak terbaca, pekerjaan dilewati', { code, error: error.message });
      return true;
    }

    const save = () => writeJson(manifestFile, job);

    try {
      const remaining = job.entries.filter((entry) => !entry.uploaded);

      if (remaining.length > 0) {
        // Signed URL berumur pendek, jadi selalu diminta baru saat pekerjaan
        // dijalankan — bukan disimpan di manifest. Pekerjaan yang tertahan
        // semalam akan memakai tanda tangan yang sudah kedaluwarsa.
        const { uploads } = await deviceApi.signUploads(code);
        const targets = new Map(
          uploads.map((target) => [`${target.kind}:${target.variant}`, target]),
        );

        for (const entry of remaining) {
          const target = targets.get(`${entry.kind}:${entry.variant}`);
          if (!target) {
            throw new Error(`Backend tidak memberi URL untuk ${entry.kind} (${entry.variant}).`);
          }
          const buffer = await fsp.readFile(path.join(dir, entry.file));
          await putObject(target, buffer);
          entry.uploaded = true;
          await save();
          this.#emit({
            type: 'progress',
            code,
            done: job.entries.filter((item) => item.uploaded).length,
            total: job.entries.length,
          });
        }
      }

      if (!job.registered) {
        const result = await deviceApi.registerAssets(
          code,
          job.entries.map((entry) => ({
            kind: entry.kind,
            variant: entry.variant,
            width: entry.width,
            height: entry.height,
            bytes: entry.bytes,
          })),
          job.retakesUsed,
        );
        job.registered = true;
        await save();
        log.info('Sesi terdaftar', { code, status: result.status, objects: result.registered });
      }

      await fsp.rm(dir, { recursive: true, force: true });
      log.info('Sesi selesai diunggah', { code });
      this.#emit({ type: 'done', code });
      return true;
    } catch (error) {
      job.attempts = (job.attempts ?? 0) + 1;
      job.lastError = error.message;
      await save().catch(() => {});

      const permanent = error instanceof ApiError && !error.retryable;
      log.error('Pekerjaan antrean gagal', {
        code,
        attempts: job.attempts,
        permanent,
        error: error.message,
      });
      this.#emit({ type: 'failed', code, error: error.message, permanent });

      if (permanent) {
        // Backend menolaknya untuk selamanya — kunci dicabut, atau sesinya
        // sudah ditutup. Sesi ditandai gagal supaya terlihat di dashboard
        // alih-alih menggantung di status `processing`.
        await deviceApi.failSession(code, error.message).catch(() => {});
        await fsp.rm(dir, { recursive: true, force: true });
        return true;
      }
      return false;
    }
  }

  /** Membuang pekerjaan yang sudah terlalu lama gagal dan sisa folder rusak. */
  async sweep() {
    const cutoff = Date.now() - KEEP_FAILED_HOURS * 3_600_000;
    let names;
    try {
      names = await fsp.readdir(this.#root);
    } catch {
      return 0;
    }

    let removed = 0;
    for (const name of names) {
      const dir = this.#dir(name);
      let job = null;
      try {
        job = await readJson(path.join(dir, MANIFEST));
      } catch {
        // Tanpa manifest, umurnya dinilai dari folder itu sendiri.
      }

      const created = job ? Date.parse(job.createdAt) : (await fsp.stat(dir)).mtimeMs;
      if (created < cutoff) {
        await fsp.rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    }
    if (removed) log.info('Antrean dibersihkan', { removed });
    return removed;
  }

  stop() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }
}

module.exports = { UploadQueue };
