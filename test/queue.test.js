/**
 * Tes antrean unggahan.
 *
 * Yang diuji di sini bukan jalur bahagianya, melainkan janji utamanya: sesi
 * yang sudah masuk antrean tidak boleh hilang. Karena itu tesnya membuat
 * kegagalan yang sesungguhnya sulit ditimbulkan di meja kerja — jaringan yang
 * mati di tengah unggahan, perangkat yang dinyalakan ulang, dan kunci API yang
 * dicabut — lalu memeriksa keadaan disk sesudahnya.
 *
 * Jalankan dengan:  node --test test/
 */

'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

// Modul api digantikan lewat cache require sebelum queue.js memuatnya, supaya
// tidak ada permintaan jaringan sungguhan dan kegagalannya bisa ditentukan.
const apiPath = require.resolve('../src/main/api');
const realApi = require(apiPath);

const calls = { sign: 0, put: 0, register: 0, fail: [], order: [] };
let behaviour = {};

function installFakeApi() {
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: {
      ApiError: realApi.ApiError,
      deviceApi: {
        async signUploads(code) {
          calls.sign += 1;
          if (behaviour.signFails) throw new realApi.ApiError('sign gagal', 503);
          return {
            uploads: FULL_CATALOG.flatMap((kind) =>
              ['original', 'preview'].map((variant) => ({
                kind,
                variant,
                url: `https://storage.example/${code}/${kind}.${variant}`,
                method: 'PUT',
                headers: { 'Content-Type': 'image/jpeg' },
              })),
            ),
          };
        },
        async registerAssets(_code, assets) {
          calls.register += 1;
          if (behaviour.registerFails) throw new realApi.ApiError('register gagal', 503);
          return { status: 'ready', registered: assets.length };
        },
        async failSession(code, reason) {
          calls.fail.push({ code, reason });
        },
      },
      async putObject(target) {
        calls.put += 1;
        calls.order.push(target.variant);
        if (behaviour.putFailsAfter && calls.put > behaviour.putFailsAfter) {
          throw new realApi.ApiError('jaringan mati', 0);
        }
        if (behaviour.putRejectsPermanently) {
          throw new realApi.ApiError('kunci dicabut', 401);
        }
        void target;
      },
    },
  };
}

const FULL_CATALOG = [
  'invitation',
  'invitation_bw',
  'invitation_pink',
  'framed',
  'framed_bw',
  'framed_pink',
  'raw_1',
  'raw_2',
  'gif',
];

const OBJECT_COUNT = FULL_CATALOG.length * 2;

const sampleObjects = () =>
  FULL_CATALOG.flatMap((kind) =>
    ['original', 'preview'].map((variant) => ({
      kind,
      variant,
      width: 100,
      height: 100,
      bytes: new Uint8Array([1, 2, 3, 4]).buffer,
    })),
  );

/** Menunggu sampai `check` benar, atau menyerah. Antreannya asinkron. */
async function until(check, { timeoutMs = 4000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Keadaan yang ditunggu tidak pernah tercapai.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('UploadQueue', () => {
  let root;
  let UploadQueue;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'booth-queue-'));
    calls.sign = 0;
    calls.put = 0;
    calls.register = 0;
    calls.fail = [];
    calls.order = [];
    behaviour = {};

    installFakeApi();
    delete require.cache[require.resolve('../src/main/queue')];
    ({ UploadQueue } = require('../src/main/queue'));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const makeQueue = () => new UploadQueue({ root, retrySeconds: 0.05 });

  it('mengunggah, mendaftarkan, lalu menghapus foldernya', async () => {
    const queue = makeQueue();
    await queue.init();
    await queue.enqueue({ code: 'AAA111', clientSessionId: 'c1', objects: sampleObjects() });

    await until(async () => (await queue.list()).length === 0);
    queue.stop();

    assert.equal(calls.put, OBJECT_COUNT);
    assert.equal(calls.register, 1);
    // Folder pekerjaan hilang berarti tidak ada berkas hasil yang tertinggal
    // di disk perangkat.
    assert.deepEqual(await fsp.readdir(root), []);
  });

  it('mendahulukan preview sebelum berkas asli', async () => {
    const queue = makeQueue();
    await queue.init();

    await queue.enqueue({ code: 'AAA222', clientSessionId: 'c2', objects: sampleObjects() });
    await until(async () => (await queue.list()).length === 0);
    queue.stop();

    // Halaman hasil hanya butuh preview. Sembilan preview harus naik lebih
    // dulu supaya pengunjung yang langsung memindai QR tidak melihat kotak
    // kosong.
    assert.deepEqual(calls.order.slice(0, 9), Array(9).fill('preview'));
    assert.deepEqual(calls.order.slice(9), Array(9).fill('original'));
  });

  it('menahan pekerjaan di disk saat jaringan mati di tengah unggahan', async () => {
    behaviour.putFailsAfter = 5;

    const queue = makeQueue();
    await queue.init();
    await queue.enqueue({ code: 'AAA333', clientSessionId: 'c3', objects: sampleObjects() });

    const job = await until(async () => {
      const [first] = await queue.list();
      return first?.lastError ? first : null;
    });
    queue.stop();

    assert.equal(job.code, 'AAA333');
    assert.equal(job.registered, false);
    // Lima objek pertama sudah naik dan tidak boleh diunggah ulang.
    assert.equal(job.remaining, OBJECT_COUNT - 5);
    assert.equal(job.total, OBJECT_COUNT);
  });

  it('melanjutkan dari titik terakhir setelah perangkat dinyalakan ulang', async () => {
    behaviour.putFailsAfter = 5;

    const first = makeQueue();
    await first.init();
    await first.enqueue({ code: 'AAA444', clientSessionId: 'c4', objects: sampleObjects() });
    await until(async () => (await first.list())[0]?.lastError);
    first.stop();

    // Antrean baru di atas folder yang sama meniru aplikasi yang baru hidup
    // lagi setelah mati lampu.
    behaviour = {};
    const uploadsBefore = calls.put;
    const second = makeQueue();
    const pending = await second.init();
    assert.equal(pending.length, 1, 'pekerjaan tertunda harus terbaca saat mulai');

    second.kick();
    await until(async () => (await second.list()).length === 0);
    second.stop();

    // Tepat objek yang belum naik yang dikerjakan — bukan mengulang semuanya.
    assert.equal(calls.put - uploadsBefore, OBJECT_COUNT - 5);
    assert.equal(calls.register, 1);
  });

  it('membuang pekerjaan yang ditolak permanen dan menandai sesinya gagal', async () => {
    behaviour.putRejectsPermanently = true;

    const queue = makeQueue();
    await queue.init();
    await queue.enqueue({ code: 'AAA555', clientSessionId: 'c5', objects: sampleObjects() });

    await until(async () => calls.fail.length > 0);
    await until(async () => (await queue.list()).length === 0);
    queue.stop();

    // Kunci yang dicabut tidak akan berubah dengan dicoba ulang. Sesinya
    // ditandai gagal supaya terlihat di dashboard alih-alih menggantung di
    // status `processing`, dan foldernya dibuang agar tidak menahan antrean.
    assert.equal(calls.fail[0].code, 'AAA555');
    assert.match(calls.fail[0].reason, /kunci dicabut/);
    assert.deepEqual(await fsp.readdir(root), []);
  });

  it('tidak pernah membaca manifest yang separuh jadi', async () => {
    const queue = makeQueue();
    await queue.init();

    // Folder tanpa `job.json` adalah bentuk penulisan yang terputus di tengah.
    await fsp.mkdir(path.join(root, 'BBB111'), { recursive: true });
    await fsp.writeFile(path.join(root, 'BBB111', 'raw_1.original.bin'), 'x');

    assert.deepEqual(await queue.list(), []);
    queue.stop();
  });

  it('menyapu pekerjaan yang sudah terlalu lama', async () => {
    const queue = makeQueue();
    await queue.init();

    const stale = path.join(root, 'CCC111');
    await fsp.mkdir(stale, { recursive: true });
    await fsp.writeFile(
      path.join(stale, 'job.json'),
      JSON.stringify({
        code: 'CCC111',
        entries: [],
        registered: false,
        attempts: 9,
        createdAt: new Date(Date.now() - 100 * 3_600_000).toISOString(),
      }),
    );

    assert.equal(await queue.sweep(), 1);
    assert.deepEqual(await fsp.readdir(root), []);
    queue.stop();
  });
});
