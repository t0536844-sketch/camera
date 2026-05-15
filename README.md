# 📸 Camera Stream v3

Aplikasi streaming kamera real-time menggunakan **WebRTC + Socket.IO** dengan arsitektur **Client-Admin Monitoring**.

## ✨ Fitur

- **Live Streaming** — Kamera di-stream real-time ke admin dashboard via WebRTC
- **Client-Admin Model** — Device camera terdaftar otomatis, admin pilih mana yang mau dimonitor
- **Remote Control** — Admin bisa request foto, rekam, ganti kamera, dan flash dari dashboard
- **Foto & Rekam Video** — Capture langsung dari browser, tersimpan di IndexedDB
- **Gallery Persisten** — Tersimpan di IndexedDB (tidak hilang saat refresh)
- **QR Code Share** — Bagikan link ke admin via QR code
- **Dark Glassmorphism UI** — Tampilan modern & responsif
- **TURN Server** — Support koneksi di balik NAT/firewall via openrelay.metered.ca

## 🏗️ Arsitektur

```
┌─────────────────────┐         ┌──────────────────┐
│   Camera Device     │         │  Admin Dashboard  │
│   /index.html       │◄───────►│   /viewer.html    │
│                     │ Socket  │                   │
│ • Buka kamera       │  .IO    │ • Lihat daftar    │
│ • Kirim WebRTC      │ relay   │   device online   │
│   offer             │         │ • Klik Monitor    │
│ • Terima command    │         │ • Terima stream   │
└─────────────────────┘         │ • Kirim command   │
                                └──────────────────┘
            ┌────────────────────────────────────┐
            │       server.js (Signaling)        │
            │  • client-register / client-ready  │
            │  • admin-monitor / admin-command   │
            │  • WebRTC offer/answer/ICE relay   │
            └────────────────────────────────────┘
```

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

## 📱 Cara Menggunakan

### 1. Landing Page
Buka `http://<IP>:3000/` — pilih mode:
- **📷 Camera Device** → buka `/index.html`
- **🎬 Admin Monitor** → buka `/viewer.html`

### 2. Sebagai Camera Device
1. Buka `http://<IP>:3000/index.html`
2. Masukkan nama device (opsional)
3. Klik **🔴 Mulai Broadcast**
4. Izinkan akses kamera
5. Device otomatis terdaftar di server

### 3. Sebagai Admin Monitor
1. Buka `http://<IP>:3000/viewer.html`
2. Lihat daftar device yang terhubung
3. Klik **📹 Monitor** pada device yang ingin dilihat
4. Stream muncul otomatis
5. Gunakan tombol remote control: 📷 foto, ⏺️ rekam, 🔄 ganti kamera, 🔦 flash

## 🌐 Akses dari Internet

### Localtonet
```bash
localtonet http localhost:3000
```
Gunakan URL tunnel dari Localtonet untuk akses dari internet.

### Hugging Face Spaces (Docker)
1. Buat Space baru, pilih **Docker**
2. Push file + Dockerfile ke repo Space
3. Space otomatis deploy di `https://<user>-<space>.hf.space/`

### VPS / Cloud
1. Upload ke server
2. `npm install && npm start`
3. Gunakan reverse proxy (nginx) + SSL

## 📁 Struktur File

```
camera/
├── server.js              # Express + Socket.IO signaling server
├── home.html              # Landing page (pilih mode)
├── Dockerfile             # Docker config untuk HF Spaces
├── package.json
├── README.md
└── public/
    ├── index.html         # Camera device page
    ├── viewer.html        # Admin monitoring dashboard
    ├── style.css          # Dark glassmorphism UI
    ├── app.js             # Camera device logic
    └── viewer.js          # Admin dashboard logic
```

## 🔌 Socket Events

| Event | Dari | Ke | Deskripsi |
|-------|------|-----|-----------|
| `client-register` | Client | Server | Device daftar dengan ID + nama |
| `client-ready` | Client | Server | Device siap stream |
| `client-offer` | Client | Server | WebRTC offer ke admin |
| `client-ice` | Client | Server | ICE candidate ke admin |
| `admin-monitor` | Admin | Server | Mulai monitor client |
| `admin-command` | Admin | Server | Kirim remote command |
| `admin-answer` | Server | Client | WebRTC answer dari admin |
| `webrtc-offer` | Server | Admin | Forward offer dari client |
| `webrtc-answer` | Server | Client | Forward answer dari admin |
| `client-screenshot` | Client | Server | Broadcast screenshot |

## 📝 Lisensi

MIT — Bebas pakai untuk belajar & eksperimen
