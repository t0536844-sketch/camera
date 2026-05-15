'use strict';

// === DOM Elements ===
const videoPreview = document.getElementById('videoPreview');
const photoCanvas = document.getElementById('photoCanvas');
const recordedVideo = document.getElementById('recordedVideo');
const recordingIndicator = document.getElementById('recordingIndicator');
const recordingTimerEl = document.getElementById('recordingTimer');

const roomSetup = document.getElementById('roomSetup');
const cameraSection = document.getElementById('cameraSection');
const shareSection = document.getElementById('shareSection');
const gallerySection = document.getElementById('gallerySection');
const gallery = document.getElementById('gallery');

const roomCodeInput = document.getElementById('roomCode');
const deviceNameInput = document.getElementById('deviceName');
const shareLinkInput = document.getElementById('shareLink');

const connectionStatus = document.getElementById('connectionStatus');
const viewerCountEl = document.getElementById('viewerCount');

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

// WebRTC state for client
let peerConnection = null;
let adminSocketId = null;
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ]
};

// Unique client ID
const CLIENT_ID = 'client-' + Math.random().toString(36).substring(2, 8);

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
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onerror = (e) => reject(e.target.error);
    });
}

async function saveToGallery(dataUrl, type) {
    if (!db) return;
    const item = { id: Date.now().toString(), data: dataUrl, type, createdAt: new Date().toISOString() };
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(item);
    return new Promise((resolve) => { tx.oncomplete = () => { loadGallery(); resolve(); }; });
}

async function loadGallery() {
    if (!db) return;
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
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
    return new Promise((resolve) => { tx.oncomplete = () => { renderGallery([]); resolve(); }; });
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
    gallery.querySelectorAll('img, video').forEach(el => {
        el.addEventListener('click', () => openModal(el.src, el.tagName === 'video'));
    });
}

function openModal(src, isVideo) {
    const modal = document.getElementById('mediaModal');
    const modalMedia = document.getElementById('modalMedia');
    modal.classList.remove('hidden');
    modalMedia.innerHTML = isVideo
        ? `<video src="${src}" controls autoplay playsinline style="max-width:100%;max-height:80vh;border-radius:12px;"></video>`
        : `<img src="${src}" style="max-width:100%;max-height:80vh;border-radius:12px;">`;

    if (!modalMedia.querySelector('.dl-btn')) {
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

// === Socket.IO ===
function connectSocket() {
    socket = io();

    socket.on('connect', () => {
        connectionStatus.classList.add('connected');
        connectionStatus.querySelector('.status-text').textContent = 'Connected';
        // Register as client device
        const deviceName = deviceNameInput.value.trim() || 'Camera Device';
        socket.emit('client-register', { clientId: CLIENT_ID, clientName: deviceName });
    });

    socket.on('disconnect', () => {
        connectionStatus.classList.remove('connected');
        connectionStatus.querySelector('.status-text').textContent = 'Disconnected';
    });

    // Admin wants to monitor this client
    socket.on('admin-request-stream', ({ adminId }) => {
        console.log('[Client] Admin requesting stream:', adminId);
        adminSocketId = adminId;
        startWebRTCWithAdmin();
    });

    socket.on('admin-stop-stream', () => {
        console.log('[Client] Admin stopped monitoring');
        adminSocketId = null;
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
    });

    // Receive WebRTC answer from admin
    socket.on('webrtc-answer', ({ answer }) => {
        if (peerConnection) {
            peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        }
    });

    // Receive ICE candidate from admin
    socket.on('webrtc-ice-candidate', ({ candidate }) => {
        if (peerConnection && candidate) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });

    // Remote commands from admin
    socket.on('remote-command', ({ command }) => {
        console.log('[Client] Remote command:', command);
        if (command === 'capture') capturePhoto();
        else if (command === 'record') {
            if (mediaRecorder && mediaRecorder.state === 'inactive') {
                startRecording();
                setTimeout(() => stopRecording(), 5000);
            }
        }
        else if (command === 'switch') switchCamera();
        else if (command === 'flash') toggleFlash();
        else if (command === 'startCamera') startCamera();
        else if (command === 'stopCamera') stopCamera();
    });
}

// === WebRTC: Create connection with admin ===
async function startWebRTCWithAdmin() {
    if (!stream) {
        console.log('[Client] No stream yet, waiting...');
        return;
    }

    console.log('[WebRTC] Creating peer connection for admin');

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnection = pc;

    // Add camera stream tracks
    stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
    });

    // Send ICE candidates to admin
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('client-ice', { clientId: CLIENT_ID, candidate: event.candidate });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('[WebRTC] Connection state:', pc.connectionState);
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            peerConnection = null;
        }
    };

    // Create offer and send to admin
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('client-offer', { clientId: CLIENT_ID, offer });
        console.log('[WebRTC] Offer sent to admin');
    } catch (err) {
        console.error('[WebRTC] Failed to create offer:', err);
        peerConnection = null;
    }
}

// === Camera Functions ===
async function startCamera() {
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
            if (legacy) return startCameraLegacy(legacy);
            throw new Error('Browser tidak mendukung. Pastikan buka via HTTPS.');
        }

        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: currentFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });

        videoPreview.srcObject = stream;
        try { await videoPreview.play(); } catch (e) { console.warn('[Camera] Auto-play blocked:', e.message); }

        videoTrack = stream.getVideoTracks()[0];
        const caps = videoTrack ? videoTrack.getCapabilities() : {};
        document.getElementById('flashBtn').disabled = !caps.torch;

        initMediaRecorder();

        // Notify server that client is ready to stream
        socket.emit('client-ready', { clientId: CLIENT_ID });

        // If admin is already monitoring, start WebRTC
        if (adminSocketId) {
            startWebRTCWithAdmin();
        }
    } catch (err) {
        console.error('[Camera] Error:', err.name, err.message);
        let msg = 'Tidak dapat mengakses kamera.\n\n';
        if (!navigator.mediaDevices) {
            msg += '⚠️ getUserMedia butuh HTTPS!\n• Buka via tunnel (Localtonet/Cloudflare)\n• URL saat ini: ' + window.location.href;
        } else if (err.name === 'NotAllowedError') {
            msg += '❌ Akses kamera ditolak. Izinkan di browser settings.';
        } else if (err.name === 'NotFoundError') {
            msg += '❌ Tidak ada kamera di device ini.';
        } else if (err.name === 'NotReadableError') {
            msg += '❌ Kamera digunakan aplikasi lain.';
        } else { msg += err.message; }
        alert(msg);
    }
}

function startCameraLegacy(getUserMedia) {
    return new Promise((resolve, reject) => {
        getUserMedia.call(navigator, { video: { facingMode: currentFacingMode }, audio: false },
            (s) => {
                stream = s; videoPreview.srcObject = stream; videoPreview.play();
                videoTrack = stream.getVideoTracks()[0]; initMediaRecorder();
                socket.emit('client-ready', { clientId: CLIENT_ID });
                resolve();
            }, (e) => reject(e));
    });
}

function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; videoPreview.srcObject = null; }
    stopRecording();
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    adminSocketId = null;
}

function initMediaRecorder() {
    recordedChunks = [];
    try {
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            await saveToGallery(URL.createObjectURL(blob), 'video');
            clearInterval(recordingInterval);
            recordingSeconds = 0;
            recordingIndicator.classList.add('hidden');
            socket.emit('client-status', { clientId: CLIENT_ID, isRecording: false });
        };
    } catch (e) { console.error('MediaRecorder error:', e); }
}

function capturePhoto() {
    if (!videoPreview.srcObject) return;
    photoCanvas.width = videoPreview.videoWidth;
    photoCanvas.height = videoPreview.videoHeight;
    photoCanvas.getContext('2d').drawImage(videoPreview, 0, 0);
    const dataUrl = photoCanvas.toDataURL('image/png');
    saveToGallery(dataUrl, 'image');
    socket.emit('client-screenshot', { clientId: CLIENT_ID, imageData: dataUrl });
}

function toggleRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
    else if (mediaRecorder && mediaRecorder.state === 'inactive') startRecording();
}

function startRecording() {
    recordedChunks = [];
    mediaRecorder.start(100);
    recordingSeconds = 0;
    recordingIndicator.classList.remove('hidden');
    recordingInterval = setInterval(() => {
        recordingSeconds++;
        const m = Math.floor(recordingSeconds / 60).toString().padStart(2, '0');
        const s = (recordingSeconds % 60).toString().padStart(2, '0');
        recordingTimerEl.textContent = `${m}:${s}`;
    }, 1000);
    socket.emit('client-status', { clientId: CLIENT_ID, isRecording: true });
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        recordingIndicator.classList.add('hidden');
        clearInterval(recordingInterval);
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
    const caps = videoTrack.getCapabilities();
    if (!caps.torch) return;
    flashActive = !flashActive;
    await videoTrack.applyConstraints({ advanced: [{ torch: flashActive }] });
    document.getElementById('flashBtn').classList.toggle('active', flashActive);
}

function copyShareLink() {
    shareLinkInput.select();
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
        const btn = document.getElementById('copyLink');
        btn.textContent = '✅ Tersalin!';
        setTimeout(() => btn.textContent = '📋 Copy', 2000);
    });
}

// === Event Listeners ===
document.getElementById('startBroadcast').addEventListener('click', () => {
    startCamera();
    // Show share link
    cameraSection.classList.remove('hidden');
    shareSection.classList.remove('hidden');
    const shareUrl = window.location.href;
    shareLinkInput.value = shareUrl;
    if (typeof QRCode !== 'undefined') {
        QRCode.toCanvas(document.getElementById('qrCode'), shareUrl, {
            width: 200, margin: 2,
            color: { dark: '#0f0f1a', light: '#ffffff' }
        }, (err) => { if (err) console.error('QR Error:', err); });
    }
});

document.getElementById('captureBtn').addEventListener('click', capturePhoto);
document.getElementById('recordBtn').addEventListener('click', toggleRecording);
document.getElementById('switchBtn').addEventListener('click', switchCamera);
document.getElementById('flashBtn').addEventListener('click', toggleFlash);
document.getElementById('stopBroadcastBtn').addEventListener('click', () => {
    stopCamera();
    cameraSection.classList.add('hidden');
    shareSection.classList.add('hidden');
});
document.getElementById('copyLink').addEventListener('click', copyShareLink);
document.getElementById('clearGallery').addEventListener('click', async () => {
    if (confirm('Hapus semua gallery?')) await clearGalleryDB();
});

// === Init ===
async function init() {
    connectSocket();
    await openDB();
    await loadGallery();

    // HTTPS warning
    if (!window.isSecureContext && window.location.protocol === 'http:') {
        const warning = document.createElement('div');
        warning.style.cssText = 'background:linear-gradient(135deg,#ff6b6b,#ee5a5a);color:white;padding:16px 20px;text-align:center;font-weight:600;position:sticky;top:0;z-index:9999;';
        warning.innerHTML = '⚠️ <strong>Kamera butuh HTTPS!</strong><br><small>Buka via tunnel (Localtonet/Cloudflare) untuk akses dari internet.</small>';
        document.body.prepend(warning);
    }
}

init();
