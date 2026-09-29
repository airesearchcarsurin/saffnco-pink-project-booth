/**
 * Mengabari backend bahwa titik ini masih hidup.
 *
 * Dijalankan dari proses utama, bukan dari halaman, supaya perangkat yang
 * kameranya terputus atau layarnya tersangkut di satu halaman tetap
 * melaporkan diri. Denyut yang ikut mati bersama halaman justru menghilangkan
 * satu-satunya keterangan tepat ketika keterangan itu paling dibutuhkan.
 *
 * Dashboard menganggap titik mati bila lewat lima menit tanpa denyut.
 */

'use strict';

const { app } = require('electron');

const { logger } = require('./log');
const config = require('./config');
const { deviceApi } = require('./api');

const log = logger('heart');

const INTERVAL_MS = 30_000;

class Heartbeat {
  #timer = null;
  #collect;
  #lastOk = null;
  #lastError = null;

  constructor(collect) {
    this.#collect = collect;
  }

  get status() {
    return { lastOk: this.#lastOk, lastError: this.#lastError };
  }

  async #tick() {
    if (!config.isPaired()) return;
    try {
      await deviceApi.heartbeat({
        appVersion: app.getVersion(),
        ...(await this.#collect()),
      });
      this.#lastOk = new Date().toISOString();
      this.#lastError = null;
    } catch (error) {
      // Denyut yang gagal tidak boleh mengganggu sesi yang sedang berjalan.
      // Kegagalannya hanya dicatat, dan dashboard yang akan menampilkannya
      // sebagai titik yang tidak terlihat.
      this.#lastError = error.message;
      log.warn('Denyut gagal', { error: error.message });
    }
  }

  start() {
    this.stop();
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), INTERVAL_MS);
  }

  restart() {
    this.start();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

module.exports = { Heartbeat };
