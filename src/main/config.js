/**
 * Setelan perangkat, tersimpan di `config.json` milik pengguna.
 *
 * Kunci API device TIDAK ikut dibundel. Tiga titik memakai kunci yang berbeda
 * supaya satu perangkat yang hilang bisa dicabut sendiri tanpa mematikan dua
 * titik lainnya, jadi kunci itu harus berupa setelan per perangkat — dan
 * apa pun yang dibundel akan sama di ketiganya.
 *
 * Nilai dari variabel lingkungan menang atas isi berkas. Itu memudahkan
 * mencoba satu perangkat terhadap backend uji tanpa menyunting apa pun.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  /** Alamat backend FastAPI. */
  apiBaseUrl: 'https://api.pinksociety.saffnco.id',
  /** Alamat halaman kiosk yang sudah ter-deploy. */
  kioskUrl: 'https://pinksociety.saffnco.id/start',
  /** Kode titik seperti terdaftar di backend: titik-1, titik-2, titik-3. */
  deviceCode: '',
  /** Kunci API device. Hanya ada di perangkat ini. */
  apiKey: '',

  /** Web server bawaan digiCamControl. */
  digiCamUrl: 'http://localhost:5513',
  /**
   * Kamera menyimpan hasil jepretan ke folder ini sebelum dibaca.
   * Dikosongkan berarti memakai folder sementara milik aplikasi.
   */
  captureFolder: '',

  /** Layar penuh tanpa bingkai. Dimatikan saat memasang dan menguji. */
  kiosk: true,
  /** Indeks layar bila perangkat tersambung ke lebih dari satu monitor. */
  displayIndex: 0,

  /** Jeda antar percobaan unggah ulang saat jaringan mal sedang buruk. */
  queueRetrySeconds: 20,
};

let filePath = null;
let values = { ...DEFAULTS };

const ENV_KEYS = {
  BOOTH_API_BASE_URL: 'apiBaseUrl',
  BOOTH_KIOSK_URL: 'kioskUrl',
  BOOTH_DEVICE_CODE: 'deviceCode',
  BOOTH_API_KEY: 'apiKey',
  BOOTH_DIGICAM_URL: 'digiCamUrl',
  BOOTH_CAPTURE_FOLDER: 'captureFolder',
};

function load(userDataDir) {
  filePath = path.join(userDataDir, 'config.json');
  values = { ...DEFAULTS };

  try {
    Object.assign(values, JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    // Berkas belum ada pada pemasangan pertama. Operator mengisinya lewat
    // layar pairing, dan `save` yang akan membuatnya.
  }

  for (const [env, key] of Object.entries(ENV_KEYS)) {
    if (process.env[env]) values[key] = process.env[env];
  }

  if (process.argv.includes('--dev')) {
    values.kiosk = false;
    if (!process.env.BOOTH_KIOSK_URL) values.kioskUrl = 'http://localhost:5173/start';
    if (!process.env.BOOTH_API_BASE_URL) values.apiBaseUrl = 'http://127.0.0.1:8080';
  }

  return values;
}

/**
 * Menulis lewat berkas sementara lalu mengganti nama.
 *
 * Menyimpan setelan adalah satu-satunya saat perangkat menulis sesuatu yang
 * kalau rusak membuatnya tidak bisa dipakai sama sekali. Mati lampu di tengah
 * penulisan biasa akan meninggalkan `config.json` separuh jadi, dan perangkat
 * itu baru ketahuan mati keesokan paginya.
 */
function save(patch) {
  values = { ...values, ...patch };

  const stored = { ...values };
  for (const [env, key] of Object.entries(ENV_KEYS)) {
    // Nilai yang berasal dari lingkungan tidak ikut ditulis, supaya percobaan
    // sementara tidak diam-diam menjadi setelan tetap.
    if (process.env[env]) delete stored[key];
  }

  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(stored, null, 2));
  fs.renameSync(temp, filePath);
  return values;
}

const get = () => values;

/** Setelan yang aman ditampilkan di layar diagnostik — tanpa kunci API. */
const redacted = () => {
  const { apiKey, ...rest } = values;
  return { ...rest, hasApiKey: Boolean(apiKey) };
};

const isPaired = () => Boolean(values.apiKey && values.deviceCode);

module.exports = { DEFAULTS, load, save, get, redacted, isPaired, file: () => filePath };
