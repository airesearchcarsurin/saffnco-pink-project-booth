/**
 * Tes relay live view.
 *
 * Yang diperiksa adalah bentuk kabelnya. Kerangka `multipart/x-mixed-replace`
 * harus tepat — batas, `Content-Type`, `Content-Length`, dan CRLF di tempatnya
 * — karena kalau salah, Chromium tidak mengeluh sama sekali. Yang terlihat di
 * kiosk hanya kotak hitam, dan tidak ada apa pun di konsol yang menunjuk ke
 * sini.
 *
 * Jalankan dengan:  node --test test/
 */

'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { describe, it } = require('node:test');

const { LiveViewRelay } = require('../src/main/liveview');

/** Kamera tiruan yang menghasilkan bingkai bernomor. */
function fakeCamera() {
  let n = 0;
  return {
    frames: () => n,
    async liveViewFrame() {
      n += 1;
      return Buffer.from(`frame-${n}`);
    },
  };
}

/** Membaca respons mentah sampai terkumpul cukup banyak, lalu memutus. */
function readRaw(url, { minBytes = 200, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks = [];
      let total = 0;

      const finish = () => {
        request.destroy();
        resolve({ headers: response.headers, body: Buffer.concat(chunks).toString() });
      };

      response.on('data', (chunk) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= minBytes) finish();
      });
      // Aliran ini tidak pernah berakhir sendiri, jadi harus ada batas waktu.
      setTimeout(finish, timeoutMs);
    });
    request.on('error', reject);
  });
}

describe('LiveViewRelay', () => {
  it('menyajikan bingkai sebagai MJPEG yang bisa dirender <img>', async () => {
    const camera = fakeCamera();
    const relay = new LiveViewRelay(camera);
    const url = await relay.start();

    try {
      const { headers, body } = await readRaw(url);

      assert.match(headers['content-type'], /^multipart\/x-mixed-replace; boundary=/);
      // Tanpa no-store, apa pun di jalur yang menahan respons akan menahan
      // aliran yang memang tidak pernah berakhir.
      assert.match(headers['cache-control'], /no-store/);

      assert.match(body, /--saffncoframe\r\nContent-Type: image\/jpeg\r\nContent-Length: 7\r\n\r\nframe-1\r\n/);
      // Lebih dari satu bingkai berarti relay benar-benar mendorong terus,
      // bukan mengirim satu lalu menggantung.
      assert.ok(body.split('--saffncoframe').length - 1 >= 2);
    } finally {
      await relay.stop();
    }
  });

  it('berhenti menanyai kamera begitu tidak ada yang menonton', async () => {
    const camera = fakeCamera();
    const relay = new LiveViewRelay(camera);
    const url = await relay.start();

    try {
      await readRaw(url, { minBytes: 60 });
      const afterDisconnect = camera.frames();

      // Polling yang terus berjalan tanpa penonton membuat kamera sibuk
      // sepanjang hari acara tanpa ada yang melihat hasilnya.
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(camera.frames(), afterDisconnect);
    } finally {
      await relay.stop();
    }
  });

  it('hanya menerima /stream.mjpg', async () => {
    const relay = new LiveViewRelay(fakeCamera());
    const url = await relay.start();

    try {
      const status = await new Promise((resolve, reject) => {
        http.get(url.replace('/stream.mjpg', '/'), (response) => {
          response.resume();
          resolve(response.statusCode);
        }).on('error', reject);
      });
      assert.equal(status, 404);
    } finally {
      await relay.stop();
    }
  });
});
