# Panduan operator — memasang dan menjaga satu titik

Untuk yang memasang perangkat di lokasi, bukan untuk yang menulis kodenya.

Tiga titik dipasang dengan langkah yang sama. Yang **berbeda di tiap titik**
hanya dua hal: kode titik dan kunci API.

---

## Memasang satu titik

### 1. Siapkan kunci API di backend

Dilakukan sekali per titik, dari VM backend:

```bash
python -m app.cli create-device --code titik-1 --name "Titik 1 — Plaza 2" \
    --location "Pasaraya Blok M" --camera "Nikon D5100"
```

Kunci yang ditampilkan **hanya muncul sekali.** Basis data menyimpan hash-nya,
jadi kunci yang hilang tidak bisa dibaca ulang — satu-satunya jalan adalah
`rotate-key`. Catat dulu sebelum menutup jendela terminal.

### 2. Pasang digiCamControl

Ikuti [`DIGICAMCONTROL.md`](DIGICAMCONTROL.md). Jangan lewati bagian
**Save to PC** dan **fokus manual**; keduanya adalah dua kesalahan yang paling
sering dan paling membingungkan.

### 3. Pasang aplikasi booth

Jalankan `SAFF-Photobooth-Setup-1.0.0.exe`. SmartScreen akan memperingatkan
karena installer-nya tidak ditandatangani — pilih **More info → Run anyway**.

### 4. Pasangkan perangkat

Aplikasi akan memberi tahu kalau belum punya kunci. Tekan `Ctrl+Shift+P`, lalu
isi:

- **Kode titik** — `titik-1`, `titik-2`, atau `titik-3`
- **Kunci API** — dari langkah 1

Kuncinya diperiksa ke backend sebelum disimpan. Kalau ditolak, setelan
sebelumnya dipulihkan dan tidak ada yang tersimpan — menyimpan kunci yang salah
menghasilkan perangkat yang terlihat normal sampai sesi pertama dibuat, dan
pada saat itu yang bisa dilakukan hanya menebak.

### 5. Jalankan otomatis saat Windows menyala

`Win+R` → `shell:startup`, lalu taruh pintasan ke **digiCamControl** dan
**SAFF Photobooth** di folder itu.

### 6. Matikan hal-hal yang mengganggu kiosk

| Setelan Windows | Nilai |
| --- | --- |
| Sleep dan hibernasi | **Never** |
| Layar mati setelah | **Never** |
| Pembaruan otomatis di jam acara | **Jeda** sampai 28 Oktober |
| Notifikasi | **Mati** (Focus Assist) |

Pembaruan Windows yang memulai ulang perangkat di tengah acara adalah satu-
satunya hal di daftar ini yang pernah benar-benar mematikan sebuah titik.
Sesi yang sudah masuk antrean tetap selamat, tetapi titik itu kosong sampai
ada yang menyadarinya.

### 7. Uji satu sesi penuh

Jalankan satu sesi dari awal sampai memindai QR dengan HP, lalu unduh satu
hasil. Periksa di dashboard `/admin` bahwa titik itu muncul dengan status
hidup dan sesinya tercatat.

---

## Selama acara

### Kombinasi tombol

| Tombol | Kegunaan |
| --- | --- |
| `Ctrl+Shift+P` | Layar pairing dan diagnostik — keadaan kamera, isi antrean |
| `Ctrl+Shift+R` | Muat ulang halaman, kalau tampilan tersangkut |
| `Ctrl+Shift+Q` | Keluar |

### Kalau ada yang salah

Urutan yang hampir selalu cukup:

1. `Ctrl+Shift+R` — muat ulang halaman
2. Kalau pesannya tentang kamera: periksa kabel USB, lalu tekan Refresh di
   digiCamControl
3. Kalau masih gagal: `Ctrl+Shift+Q`, buka lagi aplikasinya

**Tidak perlu panik soal sesi yang sedang berjalan.** Begitu layar preview
muncul, hasilnya sudah tersimpan di disk perangkat. Aplikasi boleh ditutup,
perangkat boleh dimatikan, jaringan boleh hilang — unggahannya dilanjutkan
sendiri saat aplikasi hidup lagi.

### Membaca layar diagnostik

`Ctrl+Shift+P` menampilkan:

- **Kamera** — nama model, atau kosong kalau belum tersambung
- **Antrean** — sesi yang belum selesai diunggah, beserta galat terakhirnya

Antrean yang berisi satu-dua sesi selama beberapa menit adalah hal wajar saat
Wi-Fi mal sedang penuh. Antrean yang **tidak berkurang sama sekali** selama
lebih dari sepuluh menit berarti ada yang salah — lihat galat terakhirnya.

### Kalau perangkat dipindahkan atau diganti

Kunci API terikat ke titiknya, bukan ke perangkatnya. Perangkat pengganti
dipasangkan dengan kode dan kunci yang sama, dan datanya tetap menyatu di
dashboard sebagai satu titik.

Kalau perangkatnya **hilang**, cabut kuncinya dari VM:

```bash
python -m app.cli rotate-key --code titik-1
```

Dua titik lainnya tidak terpengaruh — itulah alasan tiap titik punya kunci
sendiri.

---

## Di akhir tiap hari acara

Tidak ada yang perlu dilakukan di lokasi. Ekspor harian berjalan sendiri lewat
cron di VM dini hari: ZIP per titik per hari, tersimpan di GCS dan didorong ke
Google Drive SAFF.

Yang perlu diperiksa dari dashboard `/admin`, panel **Ekspor harian**: setiap
hari acara harus punya satu baris per titik. Kalau ada yang kosong, tombol
**Jalankan ulang ekspor** di panel itu memulainya lagi.
