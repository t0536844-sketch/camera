'use strict';

// === DOM Elements ===
const videoPreview = document.getElementById('videoPreview');
const photoCanvas = document.getElementById('photoCanvas');
const recordedVideo = document.getElementById('recordedVideo');
const recordingIndicator = document.getElementById('recordingIndicator');
const recordingTimer = document.getElementById('recordingTimer');

const roomSetup = document.getElementById('roomSetup');
const cameraSection = document.getElementById('cameraSection');
const shareSection = document.getElementById('shareSection');
const gallerySection = document.getElementById('gallerySection');

const roomCodeInput = document.getElementById('roomCode');
const deviceNameInput = document.getElementById('deviceName');
const shareLinkInput = document.getElementById('shareLink');

const connectionStatus = document.getElementById('connectionStatus');
const viewerCountEl = document.getElementById('viewerCount');
const gallery = document.getElementById('gallery');

// === State ===
let socket = null;
let stream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingInterval = null;
let recordingSeconds = 0;
let currentFacingMode = 'user';
let flashActive = false;
let videoTrack = null;
let currentRoomCode = null;
let viewerCount = 0;

// === IndexedDB Gallery ===
const DB_NAME = 'CameraStreamGallery';
const DB_VERSION = 1;
const STORE_NAME = 'media';
let db = null;

async function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const database = e.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveToGallery(dataUrl, type) {
    if (!db) return;
    const item = {
        id: Date.now().toString(),
        data: dataUrl,
        type,
        createdAt: new Date().toISOString()
    };
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(item);
    return new Promise((resolve) => {
        tx.oncomplete = () => {
            loadGallery();
            resolve();
        };
    });
}

async function loadGallery() {
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    return new Promise((resolve) => {
        request.onsuccess = () => {
            const items = request.result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            renderGallery(items);
            resolve(items);
        };
    });
}

async function clearGalleryDB() {
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    return new Promise((resolve) => {
        tx.oncomplete = () => {
            renderGallery([]);
            resolve();
        };
    });
}

function renderGallery(items) {
    if (items.length === 0) {
        gallery.innerHTML = '<div class="gallery-empty"><p>Belum ada foto/video</p></div>';
        return;
    }

    gallery.innerHTML = items.map(item => {
        const tag = item.type === 'image' ? 'img' : 'video';
        const attrs = item.type === 'video' ? 'controls playsinline' : '';
        return `<${tag} src="${item.data}" ${attrs} data-id="${item.id}"></${tag}>`;
    }).join('');

    // Click to view full
    gallery.querySelectorAll('img, video').forEach(el => {
        el.addEventListener('click', () => openModal(el.src, el.tagName === 'video'));
    });
}

function openModal(src, isVideo) {
    const modal = document.getElementById('mediaModal');
    const modalMedia = document.getElementById('modalMedia');
    modal.classList.remove('hidden');

    if (isVideo) {
        modalMedia.innerHTML = `<video src="${src}" controls autoplay playsinline style="max-width:100%;max-height:80vh;border-radius:12px;"></video>`;
    } else {
        modalMedia.innerHTML = `<img src="${src}" style="max-width:100%;max-height:80vh;border-radius:12px;">`;
    }

    // Download button
    const existingBtn = modalMedia.querySelector('.dl-btn');
    if (!existingBtn) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-primary dl-btn';
        btn.textContent = '⬇️ Download';
        btn.style.cssText = 'margin-top:12px;width:100%;';
        btn.onclick = () => {
            const a = document.createElement('a');
            a.href = src;
            a.download = `capture-${Date.now()}.${isVideo ? 'webm' : 'png'}`;
            a.click();
        };
        modalMedia.appendChild(btn);
    }
}

document.getElementById('modalClose').addEventListener('click', () => {
    document.getElementById('mediaModal').classList.add('hidden');
});

// === Socket.IO Connection ===
function connectSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('[Socket] Connected');
        connectionStatus.classList.add('connected');
        connectionStatus.querySelector('.status-text').textContent = 'Connected';
    });

    socket.on('disconnect', () => {
        console.log('[Socket] Disconnected');
        connectionStatus.classList.remove('connected');
        connectionStatus.querySelector('.status-text').textContent = 'Disconnected';
    });

    socket.on('broadcast-started', ({ roomCode }) => {
        console.log('[Broadcast] Started:', roomCode);
        showShareSection(roomCode);
    });

    socket.on('broadcast-error', ({ message }) => {
        alert(message);
    });

    socket.on('viewer-joined', ({ viewerCount }) => {
        updateViewerCount(viewerCount);
    });

    socket.on('viewer-left', ({ viewerCount }) => {
        updateViewerCount(viewerCount);
    });
}

function updateViewerCount(count) {
    viewerCount = count;
    viewerCountEl.textContent = `👁️ ${count} viewer${count !== 1 ? 's' : ''}`;
}

// === Room Setup ===
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    roomCodeInput.value = code;
}

async function startBroadcast() {
    const roomCode = roomCodeInput.value.trim().toUpperCase() || generateCodeAndSet();
    const deviceName = deviceNameInput.value.trim() || 'Kamera';

    // Start camera FIRST — don't wait for server
    await startCamera();
    if (!stream) return; // Camera failed

    // Then tell server
    socket.emit('start-broadcast', {
        roomCode,
        deviceInfo: {
            name: deviceName,
            platform: navigator.platform,
            userAgent: navigator.userAgent.substring(0, 80)
        }
    });
}

function generateCodeAndSet() {
    generateCode();
    return roomCodeInput.value;
}

// === Show Share Section with QR Code ===
function showShareSection(roomCode) {
    currentRoomCode = roomCode;
    cameraSection.classList.remove('hidden');
    shareSection.classList.remove('hidden');

    // Build share URL
    const baseUrl = window.location.origin;
    const shareUrl = `${baseUrl}/viewer.html?room=${roomCode}`;
    shareLinkInput.value = shareUrl;

    // Generate QR code
    if (typeof QRCode !== 'undefined') {
        QRCode.toCanvas(document.getElementById('qrCode'), shareUrl, {
            width: 200,
            margin: 2,
            color: { dark: '#0f0f1a', light: '#ffffff' }
        }, (err) => {
            if (err) console.error('QR Error:', err);
        });
    }
}

// === Camera Functions ===
async function startCamera() {
    try {
        console.log('[Camera] Checking mediaDevices availability...');
        
        // Check if mediaDevices is available
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            // Try legacy API fallback
            const getUserMedia = navigator.getUserMedia 
                || navigator.webkitGetUserMedia 
                || navigator.mozGetUserMedia 
                || navigator.msGetUserMedia;
            
            if (getUserMedia) {
                console.log('[Camera] Using legacy getUserMedia API');
                return startCameraLegacy(getUserMedia);
            }
            
            throw new Error('Browser tidak mendukung akses kamera. Pastikan kamu membuka halaman via HTTPS (bukan HTTP).');
        }

        console.log('[Camera] Requesting camera access...');
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: currentFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });

        console.log('[Camera] Camera access granted, tracks:', stream.getTracks().length);
        videoPreview.srcObject = stream;

        // Force play for mobile browsers
        try {
            await videoPreview.play();
            console.log('[Camera] Video playback started');
        } catch (playErr) {
            console.warn('[Camera] Auto-play blocked:', playErr.message);
        }

        videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
            console.log('[Camera] Video track label:', videoTrack.label, 'enabled:', videoTrack.enabled);
        }

        // Check flash support
        const capabilities = videoTrack ? videoTrack.getCapabilities() : {};
        document.getElementById('flashBtn').disabled = !capabilities.torch;

        // Init media recorder (video only)
        initMediaRecorder();

    } catch (err) {
        console.error('[Camera] Error:', err.name, err.message);
        let errorMsg = 'Tidak dapat mengakses kamera.\n\n';
        
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            errorMsg += '⚠️ Browser tidak mendukung getUserMedia API.\n';
            errorMsg += '• Pastikan halaman dibuka via **HTTPS**\n';
            errorMsg += '• Coba buka langsung di browser (bukan iframe)\n';
            errorMsg += '• URL saat ini: ' + window.location.href;
        } else if (err.name === 'NotAllowedError') {
            errorMsg += '❌ Akses kamera ditolak. Mohon izinkan akses kamera di browser settings.';
        } else if (err.name === 'NotFoundError') {
            errorMsg += '❌ Tidak ditemukan kamera di device ini.';
        } else if (err.name === 'NotReadableError') {
            errorMsg += '❌ Kamera sedang digunakan oleh aplikasi lain.';
        } else if (err.name === 'OverconstrainedError') {
            errorMsg += '❌ Kamera tidak mendukung resolusi yang diminta. Mencoba fallback...';
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: currentFacingMode, width: { ideal: 640 }, height: { ideal: 480 } }
                });
                videoPreview.srcObject = stream;
                await videoPreview.play();
                videoTrack = stream.getVideoTracks()[0];
                initMediaRecorder();
                console.log('[Camera] Fallback camera started');
                return;
            } catch (fallbackErr) {
                errorMsg = 'Fallback juga gagal: ' + fallbackErr.message;
            }
        } else {
            errorMsg += err.message;
        }
        alert(errorMsg);
    }
}

function startCameraLegacy(getUserMedia) {
    return new Promise((resolve, reject) => {
        getUserMedia.call(navigator, {
            video: { facingMode: currentFacingMode },
            audio: false
        }, (localStream) => {
            stream = localStream;
            videoPreview.srcObject = stream;
            videoPreview.play();
            videoTrack = stream.getVideoTracks()[0];
            initMediaRecorder();
            resolve();
        }, (err) => {
            reject(err);
        });
    });
}

function stopCamera() {
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
        videoPreview.srcObject = null;
    }
    stopRecording();
}

function initMediaRecorder() {
    recordedChunks = [];
    const options = { mimeType: 'video/webm;codecs=vp9' };

    try {
        mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };
        mediaRecorder.onstop = async () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            const url = URL.createObjectURL(blob);
            await saveToGallery(url, 'video');
            clearInterval(recordingInterval);
            recordingSeconds = 0;
            recordingIndicator.classList.add('hidden');

            // Notify server
            socket.emit('broadcaster-status', { roomCode: currentRoomCode, isRecording: false });
        };
    } catch (e) {
        console.error('MediaRecorder error:', e);
    }
}

function capturePhoto() {
    photoCanvas.width = videoPreview.videoWidth;
    photoCanvas.height = videoPreview.videoHeight;
    const ctx = photoCanvas.getContext('2d');
    ctx.drawImage(videoPreview, 0, 0);

    const dataUrl = photoCanvas.toDataURL('image/png');
    saveToGallery(dataUrl, 'image');

    // Send screenshot to viewers
    socket.emit('broadcast-screenshot', { roomCode: currentRoomCode, imageData: dataUrl });
}

function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        stopRecording();
    } else if (mediaRecorder && mediaRecorder.state === 'inactive') {
        startRecording();
    }
}

function startRecording() {
    recordedChunks = [];
    mediaRecorder.start(100);
    recordingSeconds = 0;
    recordingIndicator.classList.remove('hidden');
    document.getElementById('recordBtn').classList.add('active');

    recordingInterval = setInterval(() => {
        recordingSeconds++;
        const min = Math.floor(recordingSeconds / 60).toString().padStart(2, '0');
        const sec = (recordingSeconds % 60).toString().padStart(2, '0');
        recordingTimer.textContent = `${min}:${sec}`;
    }, 1000);

    socket.emit('broadcaster-status', { roomCode: currentRoomCode, isRecording: true });
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        recordingIndicator.classList.add('hidden');
        document.getElementById('recordBtn').classList.remove('active');
    }
}

async function switchCamera() {
    if (!stream) return;
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    stopCamera();
    await startCamera();
}

async function toggleFlash() {
    if (!videoTrack) return;
    const capabilities = videoTrack.getCapabilities();
    if (!capabilities.torch) return;

    flashActive = !flashActive;
    await videoTrack.applyConstraints({ advanced: [{ torch: flashActive }] });
    document.getElementById('flashBtn').classList.toggle('active', flashActive);
}

function stopBroadcast() {
    stopCamera();
    socket.emit('stop-broadcast', { roomCode: currentRoomCode });
    currentRoomCode = null;
    cameraSection.classList.add('hidden');
    shareSection.classList.add('hidden');
    viewerCountEl.textContent = '👁️ 0 viewer';
    updateViewerCount(0);
}

// === QR Code Copy ===
function copyShareLink() {
    shareLinkInput.select();
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
        const btn = document.getElementById('copyLink');
        btn.textContent = '✅ Tersalin!';
        setTimeout(() => btn.textContent = '📋 Copy', 2000);
    });
}

// === Event Listeners ===
document.getElementById('generateCode').addEventListener('click', generateCode);
document.getElementById('startBroadcast').addEventListener('click', startBroadcast);
document.getElementById('captureBtn').addEventListener('click', capturePhoto);
document.getElementById('recordBtn').addEventListener('click', toggleRecording);
document.getElementById('switchBtn').addEventListener('click', switchCamera);
document.getElementById('flashBtn').addEventListener('click', toggleFlash);
document.getElementById('stopBroadcastBtn').addEventListener('click', stopBroadcast);
document.getElementById('copyLink').addEventListener('click', copyShareLink);
document.getElementById('clearGallery').addEventListener('click', async () => {
    if (confirm('Hapus semua gallery?')) {
        await clearGalleryDB();
    }
});

// === Remote Commands from Viewers ===
function initRemoteCommands() {
    socket.on('remote-command', ({ fromViewer, command }) => {
        console.log(`[Remote] Command from ${fromViewer}: ${command}`);
        switch (command) {
            case 'capture':
                capturePhoto();
                break;
            case 'record':
                if (mediaRecorder.state === 'inactive') {
                    startRecording();
                    setTimeout(() => stopRecording(), 5000); // Auto stop after 5s
                }
                break;
        }
    });
}

// === Initialize ===
async function init() {
    connectSocket();
    initRemoteCommands();
    await openDB();
    await loadGallery();
    generateCode();

    // Check secure context requirement
    if (!window.isSecureContext && window.location.protocol === 'http:') {
        console.warn('[Camera] ⚠️ Insecure context detected! getUserMedia requires HTTPS.');
        
        // Show warning banner
        const warning = document.createElement('div');
        warning.style.cssText = `
            background: linear-gradient(135deg, #ff6b6b, #ee5a5a);
            color: white;
            padding: 16px 20px;
            text-align: center;
            font-weight: 600;
            position: sticky;
            top: 0;
            z-index: 9999;
        `;
        warning.innerHTML = `
            ⚠️ <strong>Kamera butuh HTTPS!</strong><br>
            <small>
                Kamu akses via HTTP. Buka via 
                <a href="https://timsupport-camera.hf.space/" style="color:#fff;text-decoration:underline;">HF Spaces (HTTPS)</a>
                atau gunakan tunnel (Localtonet/Cloudflare).
            </small>
        `;
        document.body.prepend(warning);
    }

    // Feature detection check
    const hasMediaAPI = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
    const hasLegacyAPI = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
    
    if (!hasMediaAPI && !hasLegacyAPI) {
        console.error('[Camera] ❌ No getUserMedia API available');
    } else {
        console.log('[Camera] ✅ getUserMedia API available');
    }
}

init();
