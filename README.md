# SAFF Photobooth — aplikasi perangkat booth

Cangkang Electron untuk tiga titik photobooth **The Pink Society** di Pasaraya
Blok M, 16–27 Oktober 2026.

Aplikasi ini **bukan** tempat alur photobooth-nya. Alurnya ada di halaman web
yang sama dengan mode demo, dimuat dari URL yang ter-deploy. Yang dikerjakan
aplikasi ini hanya empat hal yang tidak bisa dilakukan browser:

| Tugas | Berkas |
| --- | --- |
| Mengendalikan DSLR lewat digiCamControl | `src/main/digicam.js` |
| Menyulih live view menjadi MJPEG | `src/main/liveview.js` |
| Antrean unggahan yang selamat dari mati lampu | `src/main/queue.js` |
| Denyut ke backend, jendela kiosk, catatan | `src/main/index.js` |

Akibatnya, memperbaiki alur atau tampilan **tidak** menuntut memasang ulang
aplikasi di tiga lokasi — cukup deploy frontend.

## Yang harus terpasang di perangkat

1. **Windows 10/11 x64**
2. **digiCamControl** — <https://digicamcontrol.com>, dengan web server aktif
   (`File → Settings → Webserver → Enable`, port `5513`)
3. Aplikasi ini

Rinciannya di [`docs/DIGICAMCONTROL.md`](docs/DIGICAMCONTROL.md). Langkah
pemasangan per titik di [`docs/OPERATOR.md`](docs/OPERATOR.md).

## Menjalankan saat pengembangan

```bash
npm install
npm run dev        # kiosk mati, memuat http://localhost:5173/start
```

`--dev` mematikan mode kiosk dan mengarahkan kiosk serta backend ke localhost,
sehingga jendelanya bisa dipindah dan DevTools bisa dibuka.

Tanpa kamera yang tersambung, layar sesi akan menampilkan galat dari
digiCamControl. Itu wajar — sisa aplikasinya tetap bisa diperiksa.

## Tes

```bash
npm test
```

18 tes, tanpa Electron dan tanpa kamera. Yang diuji adalah bagian yang paling
mudah salah dan paling sulit dicoba di meja kerja:

```
test/queue.test.js     antrean: lanjut setelah mati lampu, urutan preview,
                       penolakan permanen, manifest separuh jadi
test/digicam.test.js   serah-terima dengan digiCamControl, terhadap tiruan
                       web server-nya
test/liveview.test.js  kerangka MJPEG
```

Tiga kerusakan yang ditirukan di sana semuanya **tidak melempar galat** di
lapangan, dan itulah alasan tesnya ada:

- berkas foto dibaca sebelum transfernya selesai → JPEG terpotong yang tetap
  bisa di-decode sebagian, separuh gambar abu-abu
- nama berkas terakhir tidak dibandingkan → jepretan kedua mengembalikan foto
  pertama, tepatnya saat pengunjung menekan ulangi
- kerangka MJPEG salah → kiosk menampilkan kotak hitam, konsol bersih

## Setelan

Tersimpan di `config.json` di dalam folder data pengguna:

```
C:\Users\<nama>\AppData\Roaming\SAFF Photobooth\config.json
```

| Kunci | Arti |
| --- | --- |
| `apiBaseUrl` | Alamat backend FastAPI |
| `kioskUrl` | Halaman kiosk, biasanya `https://…/start` |
| `deviceCode` | `titik-1`, `titik-2`, atau `titik-3` |
| `apiKey` | Kunci API device — **berbeda di tiap titik** |
| `digiCamUrl` | Web server digiCamControl, bawaan `http://localhost:5513` |
| `captureFolder` | Folder perantara jepretan; kosong berarti folder aplikasi |
| `kiosk` | Layar penuh tanpa bingkai |
| `displayIndex` | Layar keberapa, bila ada lebih dari satu monitor |
| `queueRetrySeconds` | Jeda antar percobaan unggah ulang |

Kunci API **tidak ikut dibundel**. Tiga titik memakai kunci berbeda supaya satu
perangkat yang hilang bisa dicabut sendiri tanpa mematikan dua titik lainnya —
dan apa pun yang dibundel akan sama di ketiganya. Operator memasukkannya sekali
lewat layar pairing.

Variabel lingkungan `BOOTH_*` menimpa isi berkas tanpa ikut tersimpan, sehingga
mencoba satu perangkat terhadap backend uji tidak diam-diam menjadi setelan
tetap:

```powershell
$env:BOOTH_API_BASE_URL = "http://127.0.0.1:8080"
$env:BOOTH_DEVICE_CODE  = "titik-1"
npm run dev
```

## Kombinasi tombol operator

Mode kiosk menutup segalanya, termasuk `Alt+F4`. Tanpa kombinasi ini,
satu-satunya cara keluar adalah mencabut daya.

| Tombol | Kegunaan |
| --- | --- |
| `Ctrl+Shift+P` | Layar pairing dan diagnostik |
| `Ctrl+Shift+R` | Muat ulang halaman |
| `Ctrl+Shift+I` | DevTools |
| `Ctrl+Shift+Q` | Keluar |

## Catatan kejadian

```
C:\Users\<nama>\AppData\Roaming\SAFF Photobooth\logs\booth-YYYY-MM-DD.log
```

Satu berkas per hari, disimpan 30 hari. Perangkat berjalan tanpa penjaga di
tiga lokasi; kalau ada yang aneh pada hari ketiga, berkas ini satu-satunya
keterangan yang tersisa. Yang dicatat adalah keputusan dan kegagalan, bukan
setiap langkah.

## Membangun installer

```bash
npm run build:win
```

Menghasilkan `dist/SAFF-Photobooth-Setup-1.0.0.exe`. Harus dijalankan di
Windows. Tanpa penandatanganan kode, jadi SmartScreen memperingatkan saat
pemasangan pertama di tiap perangkat.

## Dua keputusan yang berbeda dari rencana awal

Keduanya dicatat di sini karena sengaja menyimpang, bukan karena terlupa.

**Pengolahan gambar tetap di halaman, tidak dipindah ke Sharp.** Seluruh
geometri sembilan hasil — kotak foto pada undangan, tambalan tombol,
penempatan strip, tiga filter, GIF dua bingkai — sudah ada dan sudah terbukti
di `CanvasImaging` milik frontend. Renderer Electron adalah Chromium penuh,
jadi kode itu berjalan di sini dengan hasil yang sama persis. Menuliskannya
ulang dengan Sharp berarti dua salinan aturan yang sama, dan selisih satu
piksel pada posisi kotak foto hanya akan ketahuan dengan membandingkan gambar
jadi. Lihat catatan lengkap di `src/preload/index.js`.

**Antrean memakai folder di disk, bukan SQLite.** `better-sqlite3` adalah modul
native yang harus dikompilasi ulang untuk setiap versi Electron, dan
kegagalannya berbentuk aplikasi yang tidak mau start dengan pesan ABI — persis
jenis kerusakan yang muncul setelah pembaruan dan tidak bisa diperbaiki dari
lokasi acara. Yang diminta dari penyimpanan ini hanya "simpan belasan
pekerjaan, lanjutkan yang belum selesai". Folder di disk memberi daya tahan
yang sama tanpa dependensi native, dan operator bisa membuka foldernya untuk
melihat sesi mana yang tertahan. Lihat `src/main/queue.js`.
