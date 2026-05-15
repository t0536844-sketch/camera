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
let currentRoomCode = null;
let viewerCount = 0;

// WebRTC state for broadcaster
let peerConnections = {}; // viewerId -> RTCPeerConnection
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

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
    });

    socket.on('disconnect', () => {
        connectionStatus.classList.remove('connected');
        connectionStatus.querySelector('.status-text').textContent = 'Disconnected';
    });

    socket.on('broadcast-started', ({ roomCode }) => {
        showShareSection(roomCode);
    });

    socket.on('broadcast-error', ({ message }) => { alert(message); });

    socket.on('viewer-joined', ({ viewerId, viewerCount }) => {
        updateViewerCount(viewerCount);
        // Broadcaster creates offer for new viewer
        createPeerConnectionForViewer(viewerId);
    });

    socket.on('viewer-left', ({ viewerCount }) => { updateViewerCount(viewerCount); });

    // WebRTC: Viewer sends answer back
    socket.on('webrtc-answer', ({ fromId, answer }) => {
        const pc = peerConnections[fromId];
        if (pc) {
            pc.setRemoteDescription(new RTCSessionDescription(answer));
        }
    });

    socket.on('webrtc-ice-candidate', ({ fromId, candidate }) => {
        const pc = peerConnections[fromId];
        if (pc && candidate) {
            pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });

    // Remote commands from viewers
    socket.on('remote-command', ({ fromViewer, command }) => {
        if (command === 'capture') capturePhoto();
        if (command === 'record' && mediaRecorder && mediaRecorder.state === 'inactive') {
            startRecording();
            setTimeout(() => stopRecording(), 5000);
        }
    });
}

function updateViewerCount(count) {
    viewerCount = count;
    viewerCountEl.textContent = `👁️ ${count} viewer${count !== 1 ? 's' : ''}`;
}

// === WebRTC: Create peer connection for each viewer ===
async function createPeerConnectionForViewer(viewerId) {
    console.log('[WebRTC] Creating peer connection for viewer:', viewerId);

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[viewerId] = pc;

    // Add camera stream tracks
    stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
    });

    // Send ICE candidates to viewer
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc-ice-candidate', { targetId: viewerId, candidate: event.candidate });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] Connection state for ${viewerId}:`, pc.connectionState);
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            delete peerConnections[viewerId];
        }
    };

    // Create offer and send to viewer
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc-offer', { targetId: viewerId, offer });
        console.log('[WebRTC] Offer sent to viewer:', viewerId);
    } catch (err) {
        console.error('[WebRTC] Failed to create offer:', err);
        delete peerConnections[viewerId];
    }
}

// === Room Setup ===
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    roomCodeInput.value = code;
}

async function startBroadcast() {
    const roomCode = roomCodeInput.value.trim().toUpperCase() || generateCodeAndSet();
    const deviceName = deviceNameInput.value.trim() || 'Kamera';

    // Start camera FIRST
    await startCamera();
    if (!stream) return;

    // Then register with server
    socket.emit('start-broadcast', {
        roomCode,
        deviceInfo: { name: deviceName, platform: navigator.platform }
    });
}

function generateCodeAndSet() {
    generateCode();
    return roomCodeInput.value;
}

// === Share Section ===
function showShareSection(roomCode) {
    currentRoomCode = roomCode;
    cameraSection.classList.remove('hidden');
    shareSection.classList.remove('hidden');

    const baseUrl = window.location.origin;
    const shareUrl = `${baseUrl}/viewer.html?room=${roomCode}`;
    shareLinkInput.value = shareUrl;

    if (typeof QRCode !== 'undefined') {
        QRCode.toCanvas(document.getElementById('qrCode'), shareUrl, {
            width: 200, margin: 2,
            color: { dark: '#0f0f1a', light: '#ffffff' }
        }, (err) => { if (err) console.error('QR Error:', err); });
    }
}

// === Camera Functions ===
async function startCamera() {
    try {
        console.log('[Camera] Checking mediaDevices...');
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
            if (legacy) return startCameraLegacy(legacy);
            throw new Error('Browser tidak mendukung. Pastikan buka via HTTPS.');
        }

        console.log('[Camera] Requesting camera access...');
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: currentFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });

        console.log('[Camera] Stream obtained, tracks:', stream.getTracks().length);
        videoPreview.srcObject = stream;
        try { await videoPreview.play(); } catch (e) { console.warn('[Camera] Auto-play blocked:', e.message); }

        videoTrack = stream.getVideoTracks()[0];
        const caps = videoTrack ? videoTrack.getCapabilities() : {};
        document.getElementById('flashBtn').disabled = !caps.torch;

        initMediaRecorder();
    } catch (err) {
        console.error('[Camera] Error:', err.name, err.message);
        let msg = 'Tidak dapat mengakses kamera.\n\n';
        if (!navigator.mediaDevices) {
            msg += '⚠️ getUserMedia butuh HTTPS!\n• Buka via: https://timsupport-camera.hf.space/\n• Atau via tunnel (Localtonet/Cloudflare)\n• URL saat ini: ' + window.location.href;
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
                videoTrack = stream.getVideoTracks()[0]; initMediaRecorder(); resolve();
            }, (e) => reject(e));
    });
}

function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; videoPreview.srcObject = null; }
    stopRecording();
    // Close all peer connections
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};
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
            socket.emit('broadcaster-status', { roomCode: currentRoomCode, isRecording: false });
        };
    } catch (e) { console.error('MediaRecorder error:', e); }
}

function capturePhoto() {
    photoCanvas.width = videoPreview.videoWidth;
    photoCanvas.height = videoPreview.videoHeight;
    photoCanvas.getContext('2d').drawImage(videoPreview, 0, 0);
    const dataUrl = photoCanvas.toDataURL('image/png');
    saveToGallery(dataUrl, 'image');
    socket.emit('broadcast-screenshot', { roomCode: currentRoomCode, imageData: dataUrl });
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
    socket.emit('broadcaster-status', { roomCode: currentRoomCode, isRecording: true });
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

function stopBroadcast() {
    stopCamera();
    socket.emit('stop-broadcast', { roomCode: currentRoomCode });
    currentRoomCode = null;
    cameraSection.classList.add('hidden');
    shareSection.classList.add('hidden');
    updateViewerCount(0);
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
document.getElementById('generateCode').addEventListener('click', generateCode);
document.getElementById('startBroadcast').addEventListener('click', startBroadcast);
document.getElementById('captureBtn').addEventListener('click', capturePhoto);
document.getElementById('recordBtn').addEventListener('click', toggleRecording);
document.getElementById('switchBtn').addEventListener('click', switchCamera);
document.getElementById('flashBtn').addEventListener('click', toggleFlash);
document.getElementById('stopBroadcastBtn').addEventListener('click', stopBroadcast);
document.getElementById('copyLink').addEventListener('click', copyShareLink);
document.getElementById('clearGallery').addEventListener('click', async () => {
    if (confirm('Hapus semua gallery?')) await clearGalleryDB();
});

// === Init ===
async function init() {
    connectSocket();
    await openDB();
    await loadGallery();
    generateCode();

    if (!window.isSecureContext && window.location.protocol === 'http:') {
        const warning = document.createElement('div');
        warning.style.cssText = 'background:linear-gradient(135deg,#ff6b6b,#ee5a5a);color:white;padding:16px 20px;text-align:center;font-weight:600;position:sticky;top:0;z-index:9999;';
        warning.innerHTML = '⚠️ <strong>Kamera butuh HTTPS!</strong><br><small>Buka via <a href="https://timsupport-camera.hf.space/" style="color:#fff">HF Spaces</a> atau gunakan tunnel.</small>';
        document.body.prepend(warning);
    }

    const hasAPI = navigator.mediaDevices?.getUserMedia || navigator.getUserMedia || navigator.webkitGetUserMedia;
    console.log('[Camera]', hasAPI ? '✅ API available' : '❌ No getUserMedia API');
}

init();
