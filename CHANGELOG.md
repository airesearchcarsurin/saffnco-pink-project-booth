# Changelog

Catatan perubahan aplikasi perangkat booth SAFF & Co. Ditulis supaya keadaan
terkini dan alasan di baliknya bisa dibaca ulang tanpa menelusuri kode.

Format tanggal: YYYY-MM-DD.

---

## 2026-09-29 — Aplikasi perangkat booth pertama

Cangkang Electron untuk tiga titik photobooth. Berisi hanya apa yang tidak
bisa dilakukan browser; alur photobooth-nya tetap berupa halaman web yang sama
dengan mode demo, dimuat dari URL yang ter-deploy.

Pemisahan itu disengaja: memperbaiki alur atau tampilan tidak menuntut memasang
ulang aplikasi di tiga lokasi.

### Isinya

| Bagian | Berkas |
| --- | --- |
| Kendali DSLR lewat digiCamControl | `src/main/digicam.js` |
| Relay live view menjadi MJPEG | `src/main/liveview.js` |
| Antrean unggahan tahan mati lampu | `src/main/queue.js` |
| Klien API device | `src/main/api.js` |
| Denyut ke backend | `src/main/heartbeat.js` |
| Setelan per perangkat | `src/main/config.js` |
| Catatan kejadian harian | `src/main/log.js` |
| Jembatan `window.photobooth` | `src/preload/index.js` |

### Pengolahan gambar tetap di halaman, tidak dipindah ke Sharp

Rencana awalnya `SharpImaging` di proses utama. Yang membatalkannya: seluruh
geometri sembilan hasil — kotak foto pada undangan, tambalan tombol,
penempatan strip, tiga filter, GIF dua bingkai — sudah ada dan sudah terbukti
di `CanvasImaging` milik frontend.

Renderer Electron adalah Chromium penuh, jadi kode itu berjalan di perangkat
booth dengan hasil yang sama persis. Menuliskannya ulang dengan Sharp berarti
dua salinan aturan yang sama, dan selisih satu piksel pada posisi kotak foto
hanya akan ketahuan dengan membandingkan gambar jadi — bukan jenis kesalahan
yang ingin ditemukan saat acara sudah berjalan.

Konsekuensinya: hasil olahan ada di memori renderer, jadi `queue.publish`
mengirimkannya ke proses utama untuk ditulis ke disk sebelum layar preview
berakhir.

### Antrean memakai folder di disk, bukan SQLite

`better-sqlite3` adalah modul native yang harus dikompilasi ulang untuk setiap
versi Electron, dan kegagalannya berbentuk aplikasi yang tidak mau start dengan
pesan ABI — persis jenis kerusakan yang muncul setelah pembaruan dan tidak bisa
diperbaiki dari lokasi acara.

Yang diminta dari penyimpanan ini hanya "simpan belasan pekerjaan, lanjutkan
yang belum selesai". Satu folder per sesi berisi 18 berkas hasil dan `job.json`
memberi daya tahan yang sama tanpa satu pun dependensi native, dan operator
bisa membuka foldernya untuk melihat sesi mana yang tertahan.

`job.json` selalu ditulis lewat berkas sementara lalu diganti nama, dan
ditulis **setelah** berkas hasilnya. Urutan itulah yang membuat folder separuh
jadi tidak pernah terlihat seperti pekerjaan yang siap dikerjakan.

### Titik amannya di mana

Layar preview hanya 40 detik, sedangkan Wi-Fi mal bisa membuat unggahan 8 MB
memakan waktu jauh lebih lama. Karena itu `enqueue` kembali setelah berkasnya
tersimpan, bukan setelah unggahannya selesai — dan pengunjung tidak perlu
menunggu, karena kode QR-nya sudah ada sejak sebelum foto pertama.

Setelah 18 berkas tersimpan, sesi itu selamat apa pun yang terjadi.

### Preview diunggah lebih dulu

Halaman hasil hanya memerlukan preview untuk menampilkan kesembilan hasil.
Mendahulukannya berarti halaman itu sudah terisi beberapa detik sebelum berkas
aslinya selesai naik.

### 18 tes, tanpa Electron dan tanpa kamera

Kamera sungguhannya baru tersedia menjelang acara. Tesnya menirukan tiga
kerusakan yang di lapangan **tidak melempar galat apa pun**:

1. **Berkas foto dibaca sebelum transfernya selesai.** digiCamControl
   mendaftarkan nama berkas begitu transfer dimulai, bukan setelah selesai.
   Hasilnya JPEG terpotong yang tetap bisa di-decode sebagian — separuh gambar
   abu-abu. Driver menunggu sampai ukuran berkasnya berhenti bertambah.

2. **Nama berkas terakhir tidak dibandingkan.** digiCamControl tidak
   menyediakan cara mengetahui jepretan mana yang baru, jadi jepretan kedua
   akan mengembalikan foto pertama — tepatnya yang terjadi saat pengunjung
   menekan ulangi.

3. **Kerangka MJPEG salah.** Chromium tidak mengeluh sama sekali; yang terlihat
   di kiosk hanya kotak hitam, dengan konsol bersih.

Ditambah jalur pemulihan antrean: mati lampu di tengah unggahan harus
melanjutkan tepat dari objek yang belum naik, bukan mengulang kedelapan belas.

### Hal-hal kecil yang menentukan di lapangan

- **Satu instansi saja.** Instansi kedua berebut kamera yang sama lewat
  digiCamControl, dan gejalanya berupa jepretan yang hilang di salah satu
  jendela — bukan pesan galat.
- **Renderer yang mati memuat ulang halaman sendiri.** Perangkat berdiri tanpa
  penjaga, dan layar putih yang menetap berarti titik itu hilang sampai ada
  yang berjalan ke sana.
- **Halaman kiosk dicoba ulang kalau gagal dimuat.** Jaringan mal kadang baru
  siap beberapa detik setelah perangkat menyala.
- **Denyut berjalan dari proses utama**, bukan dari halaman. Denyut yang ikut
  mati bersama halaman justru menghilangkan satu-satunya keterangan tepat
  ketika keterangan itu paling dibutuhkan.
- **Relay live view hanya terikat ke `127.0.0.1`.** Perangkat booth berada di
  Wi-Fi mal, dan live view kamera bukan hal yang boleh dibuka siapa pun di
  jaringan itu.
- **Dua penyapu berkala** membuang jepretan perantara dan pekerjaan yang sudah
  terlalu lama gagal. Dibiarkan menumpuk, disk perangkat penuh di pertengahan
  acara.
- **Kunci API diperiksa ke backend sebelum disimpan.** Menyimpan kunci yang
  salah menghasilkan perangkat yang terlihat normal sampai sesi pertama dibuat.
- **Nilai dari variabel lingkungan tidak ikut tersimpan**, supaya percobaan
  sementara tidak diam-diam menjadi setelan tetap.
