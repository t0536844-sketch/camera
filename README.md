# 📸 Camera Stream v2

Aplikasi streaming kamera real-time menggunakan **WebRTC + Socket.IO** dengan fitur remote control.

## ✨ Fitur

- **Live Streaming** — Kamera di-stream real-time ke viewer via WebRTC
- **Multi Viewer** — Banyak device bisa menonton stream yang sama
- **Remote Control** — Viewer bisa request foto & rekam dari jarak jauh
- **Foto & Rekam Video** — Capture langsung dari browser
- **Gallery Persisten** — Tersimpan di IndexedDB (tidak hilang saat refresh)
- **QR Code Share** — Bagikan link ke viewer via QR code
- **Dark Glassmorphism UI** — Tampilan modern & responsif

## 🛠️ Teknologi

- **Backend:** Node.js + Express + Socket.IO
- **Frontend:** Vanilla JS + WebRTC API + MediaDevices API + IndexedDB
- **UI:** Dark glassmorphism CSS + responsive design

## 🚀 Cara Menjalankan

```bash
# Install dependencies
npm install

# Jalankan server
npm start

# Atau mode development (auto-restart)
npm run dev
```

Server berjalan di `http://localhost:3000`

### Akses dari Device Lain

1. Cari IP lokal device Anda: `ip addr show` atau `ifconfig`
2. Buka dari device lain: `http://<IP_ANDA>:3000`
3. Atau gunakan **Localtonet** / **Cloudflare Tunnel** untuk akses dari internet

## 📱 Cara Menggunakan

### Sebagai Broadcaster (Pengirim Kamera)
1. Buka `http://<IP>:3000`
2. Masukkan kode room (auto generate) dan nama device
3. Klik **🔴 Mulai Broadcast**
4. Izinkan akses kamera & mikrofon
5. Bagikan link/QR code ke viewer

### Sebagai Viewer (Penonton)
1. Buka link yang dibagikan broadcaster
2. Atau buka `http://<IP>:3000/viewer.html` dan masukkan kode room
3. Klik **👁️ Lihat Stream**
4. Stream akan muncul otomatis

## 📁 Struktur File

```
camera/
├── server.js          # Express + Socket.IO signaling server
├── package.json
├── public/
│   ├── index.html     # Halaman broadcaster
│   ├── viewer.html    # Halaman viewer
│   ├── style.css      # Glassmorphism UI
│   ├── app.js         # Broadcaster logic
│   └── viewer.js      # Viewer logic
└── README.md
```

## 🌐 Deploy

### Hugging Face Spaces (Docker)
1. Buat Space baru, pilih **Docker**
2. Push file + Dockerfile ke repo Space
3. Space otomatis deploy

### VPS / Cloud
1. Upload ke server
2. `npm install && npm start`
3. Gunakan reverse proxy (nginx) + SSL

## 📝 Lisensi

MIT — Bebas pakai untuk belajar & eksperimen
