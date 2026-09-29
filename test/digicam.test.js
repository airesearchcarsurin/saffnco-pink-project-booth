/**
 * Tes driver kamera terhadap tiruan web server digiCamControl.
 *
 * Kamera sungguhannya baru tersedia menjelang acara, sedangkan bagian yang
 * paling mudah salah justru ada di serah-terima ini: digiCamControl
 * mendaftarkan nama berkas begitu transfer dimulai, bukan setelah selesai, dan
 * tidak memberi tahu jepretan mana yang baru. Kedua sifat itu ditirukan di
 * sini, sebab keduanya menghasilkan kerusakan yang tidak melempar galat —
 * JPEG terpotong, dan foto lama yang terbaca dua kali.
 *
 * Jalankan dengan:  node --test test/
 */

'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const { DigiCam, DigiCamError } = require('../src/main/digicam');

/** Tiruan server. Perilakunya diatur lewat `state`. */
function createFakeServer(state) {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');

    if (url.pathname === '/liveview.jpg') {
      if (!state.liveViewOpen) {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(Buffer.from([0xff, 0xd8]));
      return;
    }

    const slc = url.searchParams.get('slc');
    const param1 = url.searchParams.get('param1') ?? '';
    const param2 = url.searchParams.get('param2') ?? '';
    state.commands.push([slc, param1, param2].filter(Boolean).join(' '));

    const reply = (text) => response.writeHead(200, { 'Content-Type': 'text/plain' }).end(text);

    if (slc === 'list' && param1 === 'cameras') return reply(state.cameras.join('\n'));
    if (slc === 'get' && param1 === 'lastcaptured') return reply(state.lastCaptured ?? '-');
    if (slc === 'capture') {
      state.onCapture?.();
      return reply('OK');
    }
    if (slc === 'LiveViewWnd_Show') {
      state.liveViewOpen = true;
      return reply('OK');
    }
    if (slc === 'set' || slc === 'LiveViewWnd_Hide') return reply('OK');
    return reply('error: perintah tidak dikenal');
  });
}

describe('DigiCam', () => {
  let server;
  let baseUrl;
  let captureFolder;
  let state;

  beforeEach(async () => {
    captureFolder = await fsp.mkdtemp(path.join(os.tmpdir(), 'booth-capture-'));
    state = { cameras: ['Nikon D5100'], lastCaptured: null, commands: [], liveViewOpen: false };
    server = createFakeServer(state);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(captureFolder, { recursive: true, force: true });
  });

  const makeCamera = () => new DigiCam({ baseUrl, captureFolder });

  it('menyetel kamera agar mengirim berkas ke PC saat menyambung', async () => {
    const camera = makeCamera();
    const info = await camera.connect();

    assert.equal(info.camera, 'Nikon D5100');
    assert.equal(camera.isConnected, true);
    // Bila kamera disetel menyimpan ke kartu memori, rana tetap berbunyi dan
    // tidak ada berkas yang pernah muncul — gejalanya sama persis seperti
    // kamera yang menggantung, jadi setelan ini harus dipaksa.
    assert.ok(state.commands.includes('set transfer Save_to_PC'));
    assert.ok(state.commands.some((line) => line.startsWith('set session.folder')));
  });

  it('menolak dengan petunjuk kalau tidak ada kamera', async () => {
    state.cameras = [];
    const camera = makeCamera();

    await assert.rejects(() => camera.connect(), (error) => {
      assert.ok(error instanceof DigiCamError);
      assert.match(error.hint, /kabel USB/);
      return true;
    });
  });

  it('menolak dengan petunjuk kalau digiCamControl tidak berjalan', async () => {
    await new Promise((resolve) => server.close(resolve));
    server = http.createServer(); // supaya afterEach tetap aman

    const camera = new DigiCam({ baseUrl, captureFolder });
    await assert.rejects(() => camera.connect(), (error) => {
      assert.match(error.message, /tidak menjawab/);
      assert.match(error.hint, /Webserver/);
      return true;
    });
  });

  it('menunggu berkas selesai ditulis sebelum membacanya', async () => {
    const camera = makeCamera();
    await camera.connect();

    const file = path.join(captureFolder, 'booth_1.jpg');
    state.onCapture = () => {
      // Transfer bertahap: nama berkas terdaftar lebih dulu, isinya menyusul.
      // Membaca terlalu cepat menghasilkan JPEG terpotong yang tetap bisa
      // di-decode sebagian — separuh gambar abu-abu, tanpa galat apa pun.
      fsp.writeFile(file, Buffer.alloc(1000, 1));
      state.lastCaptured = 'booth_1.jpg';
      setTimeout(() => fsp.writeFile(file, Buffer.alloc(9000, 1)), 120);
    };

    const photo = await camera.capture();
    assert.equal(photo.buffer.length, 9000);
  });

  it('tidak mengembalikan foto yang sama dua kali', async () => {
    const camera = makeCamera();
    await camera.connect();

    await fsp.writeFile(path.join(captureFolder, 'booth_1.jpg'), Buffer.alloc(500, 1));
    state.lastCaptured = 'booth_1.jpg';

    state.onCapture = () => {
      setTimeout(async () => {
        await fsp.writeFile(path.join(captureFolder, 'booth_2.jpg'), Buffer.alloc(700, 2));
        state.lastCaptured = 'booth_2.jpg';
      }, 80);
    };

    const photo = await camera.capture();
    // Kalau nama berkas sebelumnya tidak dibandingkan, jepretan kedua akan
    // mengembalikan foto pertama — tepatnya yang terjadi saat pengunjung
    // menekan ulangi.
    assert.equal(path.basename(photo.file), 'booth_2.jpg');
    assert.equal(photo.buffer.length, 700);
  });

  it('menolak dengan petunjuk kalau rana tidak menghasilkan foto', async () => {
    const camera = makeCamera();
    await camera.connect();
    state.onCapture = () => {}; // fokus gagal mengunci: tidak ada berkas baru

    await assert.rejects(() => camera.capture(), (error) => {
      assert.match(error.message, /tidak menghasilkan foto baru/);
      assert.match(error.hint, /fokus/);
      return true;
    });
  });

  it('membuang jepretan lama tapi menyisakan yang baru', async () => {
    const camera = makeCamera();
    await camera.connect();

    const old = path.join(captureFolder, 'lama.jpg');
    const fresh = path.join(captureFolder, 'baru.jpg');
    await fsp.writeFile(old, 'x');
    await fsp.writeFile(fresh, 'y');
    const longAgo = new Date(Date.now() - 4 * 3_600_000);
    await fsp.utimes(old, longAgo, longAgo);

    assert.equal(await camera.sweep({ olderThanMinutes: 60 }), 1);
    assert.deepEqual(await fsp.readdir(captureFolder), ['baru.jpg']);
  });

  it('mengembalikan null untuk live view yang belum terbuka', async () => {
    const camera = makeCamera();
    state.liveViewOpen = false;
    assert.equal(await camera.liveViewFrame(), null);

    state.liveViewOpen = true;
    assert.ok((await camera.liveViewFrame()).length > 0);
  });
});
