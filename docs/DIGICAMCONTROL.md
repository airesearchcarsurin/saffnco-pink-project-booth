# digiCamControl — pemasangan dan setelan

Aplikasi booth tidak berbicara langsung ke kamera. Ia berbicara ke
digiCamControl, dan digiCamControl yang berbicara ke kamera.

Alasannya: Nikon D5100 dan Sony A6400 berbeda jauh di tingkat protokol — yang
satu PTP klasik, yang satu lagi memerlukan mode kendali khusus.
digiCamControl sudah menyelesaikan perbedaan itu untuk ratusan model. Menulis
penangannya sendiri berarti dua implementasi berbeda yang harus diuji terhadap
perangkat keras yang baru tersedia menjelang acara.

Konsekuensinya juga harus jelas: **digiCamControl menjadi satu titik kegagalan
tambahan.** Kalau ia tertutup atau menggantung, titik itu berhenti memotret.
Karena itu ia dijalankan otomatis saat Windows menyala, dan kegagalannya
muncul di layar kiosk sebagai pesan berpetunjuk, bukan sebagai galat mentah.

## 1. Pasang

Unduh dari <https://digicamcontrol.com> dan pasang dengan pilihan bawaan.
Versi 2.1.x sudah cukup.

## 2. Aktifkan web server

`File → Settings → Webserver`

- centang **Enable**
- **Port**: `5513`

Tanpa langkah ini, semua perintah kamera gagal dengan pesan
"digiCamControl tidak menjawab".

Untuk memastikan, buka di browser perangkat itu:

```
http://localhost:5513/?slc=list&param1=cameras
```

Harus muncul nama kameranya.

## 3. Setel kamera agar mengirim ke PC

Aplikasi booth memaksa setelan ini setiap kali menyambung
(`set transfer Save_to_PC`), tetapi ada baiknya juga benar dari sisi kamera.

Kalau kamera disetel menyimpan ke kartu memori, **rana tetap berbunyi dan
tidak ada berkas yang pernah muncul.** Gejalanya sama persis seperti kamera
yang menggantung, dan inilah kesalahan yang paling lama membingungkan kalau
tidak diketahui sebelumnya.

## 4. Setelan kamera yang disarankan

| Setelan | Nilai | Alasan |
| --- | --- | --- |
| Mode | **M** (manual) | Pencahayaan mal berubah sepanjang hari; otomatis membuat sembilan hasil dari dua sesi berbeda tidak cocok warnanya |
| Fokus | **Manual**, dipatok ke jarak pengunjung | Fokus otomatis yang gagal mengunci membuat rana tidak berbunyi sama sekali |
| Kualitas | **JPEG Fine**, bukan RAW | RAW menambah beberapa detik transfer per jepretan, dan hasil akhirnya tetap JPEG |
| ISO | Tetap, secukupnya | ISO otomatis menghasilkan derau yang berbeda-beda antar sesi |
| Peredam mata merah / lampu bantu AF | **Mati** | Kedipannya membuat pengunjung berkedip tepat saat rana terbuka |

Fokus manual bukan sekadar saran. Di aplikasi ini, jepretan yang tidak
menghasilkan berkas baru dalam 15 detik dianggap gagal, dan penyebab paling
sering adalah fokus otomatis yang tidak menemukan kontras — hal yang mudah
terjadi pada latar bertekstur rata.

## 5. Live view

digiCamControl hanya menyajikan `/liveview.jpg`, satu bingkai per permintaan,
dan hanya kalau jendela live view-nya terbuka. Aplikasi booth membukanya
sendiri saat menyambung (`LiveViewWnd_Show`).

Bingkai-bingkai itu lalu disatukan menjadi satu aliran MJPEG oleh
`src/main/liveview.js`, karena meminta bingkai satu per satu dari halaman
menghasilkan pratinjau tersendat — bukan pratinjau yang membuat orang tahu
sudah masuk bingkai atau belum.

Aliran itu hanya terikat ke `127.0.0.1`. Perangkat booth berada di Wi-Fi mal,
dan live view kamera bukan hal yang boleh dibuka siapa pun di jaringan itu.

Sebagian kamera baru mengizinkan live view setelah lensanya aktif. Kalau gagal
dibuka, sesi tetap bisa berjalan — yang hilang hanya pratinjaunya, dan
kegagalannya tercatat di berkas log.

## 6. Jalan otomatis saat Windows menyala

digiCamControl harus sudah berjalan sebelum aplikasi booth menyambung.

Tekan `Win+R`, buka `shell:startup`, lalu taruh pintasan ke:

```
C:\Program Files (x86)\digiCamControl\CameraControl.exe
```

Aplikasi booth juga ditaruh di folder yang sama. Urutannya tidak perlu
dipastikan: aplikasi booth baru menyambung kamera ketika halaman sesi dibuka,
dan sampai saat itu digiCamControl sudah siap.

## Perintah yang dipakai

Semuanya lewat antarmuka "single line command" pada port 5513, dan jawabannya
teks biasa.

| Perintah | Kegunaan |
| --- | --- |
| `?slc=list&param1=cameras` | Daftar kamera yang terhubung |
| `?slc=set&param1=transfer&param2=Save_to_PC` | Paksa kirim ke PC |
| `?slc=set&param1=session.folder&param2=<path>` | Folder perantara |
| `?slc=get&param1=lastcaptured` | Nama berkas jepretan terakhir |
| `?slc=capture` | Picu rana |
| `?slc=LiveViewWnd_Show` | Buka jendela live view |
| `/liveview.jpg` | Satu bingkai live view |

Dua sifat yang perlu diketahui saat membaca `src/main/digicam.js`:

1. **Web server-nya membalas `200` meskipun perintahnya ditolak.** Status HTTP
   tidak bisa dipakai sendirian; isi teksnya juga harus diperiksa.
2. **`lastcaptured` terisi begitu transfer dimulai, bukan setelah selesai.**
   Membaca berkasnya saat itu menghasilkan JPEG terpotong yang tetap bisa
   di-decode sebagian — separuh gambar abu-abu, tanpa galat apa pun. Karena
   itu driver menunggu sampai ukuran berkasnya berhenti bertambah.

Dan satu hal yang tidak disediakan digiCamControl: **tidak ada cara mengetahui
jepretan mana yang baru.** Driver mencatat `lastcaptured` sebelum menjepret dan
membandingkannya sesudah. Tanpa perbandingan itu, jepretan kedua akan
mengembalikan foto pertama — tepatnya yang terjadi saat pengunjung menekan
ulangi.

## Kalau macet di lokasi

| Gejala | Kemungkinan | Tindakan |
| --- | --- | --- |
| "digiCamControl tidak menjawab" | Aplikasinya tertutup atau web server mati | Buka digiCamControl, periksa `File → Settings → Webserver` |
| "Tidak ada kamera yang terdeteksi" | Kabel USB, kamera mati, atau kamera sedang di mode pemutaran | Periksa kabel, putar ke mode foto, tekan Refresh di digiCamControl |
| "Kamera tidak menghasilkan foto baru" | Fokus otomatis gagal mengunci | Setel lensa ke fokus manual, atau naikkan cahaya |
| Rana berbunyi tapi tidak ada foto | Kamera menyimpan ke kartu memori | Setel `Save to PC` di digiCamControl |
| Pratinjau kotak hitam | Live view belum terbuka | `Ctrl+Shift+R` untuk muat ulang halaman |
| Semua normal tapi hasil tidak muncul di HP | Unggahan tertahan di antrean | `Ctrl+Shift+P`, lihat daftar antrean |
