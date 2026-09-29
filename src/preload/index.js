/**
 * `window.photobooth` — satu-satunya hal yang membedakan mode desktop.
 *
 * Halaman kiosk memilih driver lewat deteksi kapabilitas, bukan lewat
 * pertanyaan "apakah ini Electron". Berkas ini menyediakan objek yang
 * dicarinya: `camera`, `queue`, dan `deviceInfo`. Tidak ada `imaging` — lihat
 * catatan di bawah.
 *
 * Mengapa pengolahan gambar TIDAK dipindah ke proses utama
 * --------------------------------------------------------
 * Rencana awalnya `SharpImaging` di proses utama. Yang membatalkannya: seluruh
 * geometri sembilan hasil — kotak foto pada undangan, tambalan tombol,
 * penempatan strip, tiga filter, GIF dua bingkai — sudah ada dan sudah
 * terbukti di `CanvasImaging`. Menuliskannya ulang dengan Sharp berarti dua
 * salinan aturan yang sama, dan perbedaan sekecil satu piksel pada posisi
 * kotak foto hanya akan ketahuan dengan membandingkan gambar jadi.
 *
 * Renderer Electron adalah Chromium penuh, jadi `CanvasImaging` berjalan di
 * sini dengan pipeline yang sama persis seperti mode web. Yang benar-benar
 * tidak bisa dilakukan browser hanya dua hal, dan keduanya ada di sini:
 * mengendalikan DSLR, dan antrean yang selamat dari mati lampu.
 *
 * Konsekuensinya: hasil olahan ada di memori renderer. Karena itu
 * `queue.publish` mengirimkannya ke proses utama untuk ditulis ke disk sebelum
 * layar preview berakhir. Titik aman sesungguhnya ada di situ — setelah
 * delapan belas berkas tersimpan, sesi itu selamat apa pun yang terjadi.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Kamera DSLR lewat proses utama, memenuhi antarmuka `CameraDriver` yang sama
 * dengan `WebcamDriver`.
 */
class DigiCamDriver {
  #capabilities = { liveView: 'url', resolution: null, deviceLabel: null, mirrored: false };
  #connected = false;
  #liveViewUrl = null;

  get name() {
    return 'digicamcontrol';
  }

  get capabilities() {
    return { ...this.#capabilities };
  }

  get isConnected() {
    return this.#connected;
  }

  async connect() {
    const info = await ipcRenderer.invoke('camera:connect');
    this.#connected = true;
    this.#liveViewUrl = info.liveViewUrl;
    this.#capabilities = {
      liveView: 'url',
      resolution: info.resolution ?? null,
      deviceLabel: info.camera ?? null,
      // Kamera menghadap pengunjung dari depan, bukan seperti cermin, jadi
      // hasilnya tidak boleh dicerminkan. Webcam menyetel ini true.
      mirrored: false,
    };
    return info;
  }

  async getLiveView() {
    if (!this.#connected) await this.connect();
    // Aliran MJPEG dari relay di proses utama. Harus dirender elemen `<img>`;
    // `<video>` di Chromium tidak bisa memutar multipart JPEG.
    return { kind: 'url', url: this.#liveViewUrl, element: 'img' };
  }

  async capture() {
    const { bytes } = await ipcRenderer.invoke('camera:capture');
    // Dikembalikan sebagai ImageBitmap supaya pipeline gambar tidak perlu tahu
    // dari mana fotonya datang.
    return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  }

  async disconnect() {
    this.#connected = false;
    await ipcRenderer.invoke('camera:disconnect');
  }
}

/** Antrean unggahan di proses utama. */
const queue = {
  /**
   * Menyerahkan sembilan hasil beserta preview-nya untuk diunggah.
   *
   * Kembali begitu berkasnya tersimpan, bukan setelah unggahannya selesai.
   * Layar preview hanya 40 detik, sedangkan Wi-Fi mal bisa membuat unggahan
   * 8 MB memakan waktu jauh lebih lama — dan pengunjung tidak perlu
   * menunggunya, karena kode QR-nya sudah ada sejak sebelum foto pertama.
   */
  async publish({ code, clientSessionId, retakesUsed, results }) {
    const objects = [];
    for (const result of results) {
      for (const variant of ['original', 'preview']) {
        const entry = result[variant];
        objects.push({
          kind: result.kind,
          variant,
          width: entry.width,
          height: entry.height,
          bytes: await entry.blob.arrayBuffer(),
        });
      }
    }

    return ipcRenderer.invoke('queue:enqueue', {
      code,
      clientSessionId,
      retakesUsed,
      objects,
    });
  },

  list: () => ipcRenderer.invoke('queue:list'),
  retry: () => ipcRenderer.invoke('queue:kick'),

  /** Memberi tahu halaman diagnostik saat keadaan antrean berubah. */
  subscribe(listener) {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('queue:event', handler);
    return () => ipcRenderer.off('queue:event', handler);
  },
};

const deviceInfo = {
  read: () => ipcRenderer.invoke('device:info'),
  pair: (settings) => ipcRenderer.invoke('device:pair', settings),
  // Pelepasan pairing tidak bisa lewat `pair` dengan kunci kosong: `pair`
  // memeriksanya ke backend lebih dulu, dan kunci kosong selalu ditolak —
  // sehingga setelan lama justru dipulihkan.
  unpair: () => ipcRenderer.invoke('device:unpair'),
  verify: () => ipcRenderer.invoke('device:verify'),
  openLog: () => ipcRenderer.invoke('device:open-log'),
};

contextBridge.exposeInMainWorld('photobooth', {
  runtime: 'desktop',
  camera: new DigiCamDriver(),
  queue,
  deviceInfo,
});
