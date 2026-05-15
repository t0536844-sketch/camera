---
title: Camera Stream
emoji: 📸
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# 📸 Camera Stream v3

Real-time camera monitoring with **WebRTC + Socket.IO** — Client-Admin architecture.

## ✨ Features

- **Live Streaming** — Camera streams in real-time to admin dashboard via WebRTC
- **Client-Admin Model** — Camera devices auto-register, admin picks which to monitor
- **Remote Control** — Admin can request photos, recording, camera switch, and flash
- **Persistent Gallery** — IndexedDB storage (survives page refresh)
- **Dark Glassmorphism UI** — Modern responsive design

## 🚀 Cara Pakai

### 1. Landing Page
Buka `https://timsupport-camera.hf.space/` — pilih mode:
- **📷 Camera Device** → halaman untuk membuka kamera
- **🎬 Admin Monitor** → dashboard monitoring

### 2. Camera Device
1. Buka halaman Camera Device
2. Masukkan nama device
3. Klik **Mulai Broadcast**
4. Izinkan akses kamera

### 3. Admin Monitor
1. Buka halaman Admin Monitor
2. Lihat daftar device yang terhubung
3. Klik **Monitor** untuk mulai melihat stream
4. Gunakan remote control: 📷 foto, ⏺️ rekam, 🔄 ganti kamera, 🔦 flash

## 🛠️ Tech Stack

- **Backend:** Node.js + Express + Socket.IO
- **Frontend:** Vanilla JS + WebRTC + IndexedDB
- **UI:** Dark glassmorphism CSS

## 📝 License

MIT
