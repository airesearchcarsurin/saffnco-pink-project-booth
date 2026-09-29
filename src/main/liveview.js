/**
 * Menyulih bingkai tunggal digiCamControl menjadi aliran MJPEG.
 *
 * `/liveview.jpg` hanya memberikan satu bingkai per permintaan. Kalau halaman
 * kiosk memintanya berulang-ulang sendiri, setiap bingkai menjadi satu
 * permintaan HTTP baru dan hasilnya terlihat tersendat — bukan pratinjau yang
 * membuat orang tahu sudah masuk bingkai atau belum.
 *
 * Server kecil ini menyatukan bingkai-bingkai itu menjadi satu respons
 * `multipart/x-mixed-replace`, bentuk yang bisa dirender elemen `<img>` secara
 * terus-menerus tanpa JavaScript sama sekali. Yang berjalan di localhost dan
 * hanya menerima sambungan dari localhost.
 *
 * Alasan tidak menyulihnya lewat IPC: mengirim ~15 bingkai JPEG per detik
 * lewat IPC menyalin setiap bingkai ke memori renderer dan membuat pengumpul
 * sampah bekerja tanpa henti selama sesi berjalan.
 */

'use strict';

const http = require('node:http');

const { logger } = require('./log');

const log = logger('liveview');

const BOUNDARY = 'saffncoframe';
/** ~12 bingkai per detik. Cukup mulus untuk membetulkan pose, dan ringan. */
const FRAME_INTERVAL_MS = 80;

class LiveViewRelay {
  #server = null;
  #port = 0;
  #camera;
  #clients = new Set();
  #timer = null;

  constructor(camera) {
    this.#camera = camera;
  }

  get url() {
    return this.#port ? `http://127.0.0.1:${this.#port}/stream.mjpg` : null;
  }

  async start() {
    if (this.#server) return this.url;

    this.#server = http.createServer((request, response) => {
      if (request.url !== '/stream.mjpg') {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, {
        'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
        // Tanpa ini, proxy atau cache mana pun di jalur akan menahan respons
        // yang memang tidak pernah berakhir.
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Connection: 'close',
        Pragma: 'no-cache',
      });

      this.#clients.add(response);
      request.on('close', () => {
        this.#clients.delete(response);
        if (this.#clients.size === 0) this.#stopPolling();
      });

      this.#startPolling();
    });

    await new Promise((resolve) => {
      // Hanya localhost. Perangkat booth berada di Wi-Fi mal, dan live view
      // kamera bukan hal yang boleh bisa dibuka siapa pun di jaringan itu.
      this.#server.listen(0, '127.0.0.1', resolve);
    });

    this.#port = this.#server.address().port;
    log.info('Relay live view siap', { url: this.url });
    return this.url;
  }

  #startPolling() {
    if (this.#timer) return;

    let inFlight = false;
    this.#timer = setInterval(async () => {
      // Bingkai dilewati, bukan ditumpuk. Kalau kamera sedang lambat, menunda
      // bingkai berikutnya hanya memperbesar keterlambatan yang terlihat.
      if (inFlight || this.#clients.size === 0) return;
      inFlight = true;
      try {
        const frame = await this.#camera.liveViewFrame();
        if (frame) this.#broadcast(frame);
      } finally {
        inFlight = false;
      }
    }, FRAME_INTERVAL_MS);
  }

  #stopPolling() {
    clearInterval(this.#timer);
    this.#timer = null;
  }

  #broadcast(frame) {
    const header = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
    );
    const tail = Buffer.from('\r\n');

    for (const client of this.#clients) {
      // `write` yang mengembalikan false berarti soket penuh. Membiarkannya
      // menumpuk membuat pemakaian memori tumbuh diam-diam sepanjang sesi,
      // jadi bingkai untuk klien itu dilewati saja.
      if (client.writableLength > frame.length * 3) continue;
      client.write(header);
      client.write(frame);
      client.write(tail);
    }
  }

  async stop() {
    this.#stopPolling();
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    await new Promise((resolve) => this.#server?.close(resolve));
    this.#server = null;
    this.#port = 0;
  }
}

module.exports = { LiveViewRelay };
