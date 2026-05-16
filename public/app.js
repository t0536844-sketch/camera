'use strict';

// === DOM Elements ===
const videoPreview = document.getElementById('videoPreview');
const photoCanvas = document.getElementById('photoCanvas');
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
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const adminCountEl = document.getElementById('adminCount');
const chatSection = document.getElementById('chatSection');
const chatMessagesEl = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

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
let adminCount = 0;
const chatMessages = []; // [{from, message, type, timestamp}]

// WebRTC: peer connection per admin watching this client
const peerConnections = {}; // adminSocketId -> RTCPeerConnection
const waitingAdmins = [];   // admin IDs waiting for stream to start
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

    // Admin watching this client
    socket.on('admin-watching', ({ adminId }) => {
        console.log('[Client] Admin watching:', adminId);
        adminCount++;
        updateAdminCount();

        if (stream) {
            createPeerConnectionForAdmin(adminId);
        } else {
            waitingAdmins.push(adminId);
            console.log('[Client] Admin added to waiting list:', adminId);
        }
    });

    // Admin left
    socket.on('admin-left', ({ adminId }) => {
        console.log('[Client] Admin left:', adminId);
        adminCount = Math.max(0, adminCount - 1);
        updateAdminCount();
        if (peerConnections[adminId]) {
            peerConnections[adminId].close();
            delete peerConnections[adminId];
        }
    });

    // Receive WebRTC answer from admin
    socket.on('webrtc-answer', ({ roomCode, answer, adminId }) => {
        const pc = peerConnections[adminId];
        if (pc && pc.signalingState !== 'closed') {
            pc.setRemoteDescription(new RTCSessionDescription(answer));
            console.log('[WebRTC] Answer applied for admin:', adminId);
        } else {
            console.warn('[WebRTC] No peer connection for admin:', adminId);
        }
    });

    // Receive ICE candidate from admin
    socket.on('webrtc-ice-candidate', ({ roomCode, candidate, adminId }) => {
        const pc = peerConnections[adminId];
        if (pc && candidate) {
            pc.addIceCandidate(new RTCIceCandidate(candidate));
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
        else if (command === 'stopCamera') {
            stopCamera();
        }
    });

    socket.on('client-error', ({ message }) => { alert(message); });

    // Chat messages from admin
    socket.on('chat-message', ({ roomCode, from, message, type, timestamp }) => {
        chatMessages.push({ from, message, type, timestamp });
        renderChatMessages();

        // Show chat section if hidden
        chatSection.classList.remove('hidden');
    });
}

// === WebRTC: Create connection per admin ===
async function createPeerConnectionForAdmin(adminId) {
    if (!stream) {
        console.log('[Client] No stream yet, will create PC when ready');
        return;
    }

    console.log('[WebRTC] Creating peer connection for admin:', adminId);

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[adminId] = pc;

    // Add camera stream tracks
    stream.getTracks().forEach(track => {
        pc.addTrack(track, stream);
    });

    // Send ICE candidates to admin
    pc.onicecandidate = (event) => {
        if (event.candidate && currentRoomCode) {
            socket.emit('client-ice', { roomCode: currentRoomCode, adminId, candidate: event.candidate });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`[WebRTC] Connection state for admin ${adminId}:`, pc.connectionState);
        if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            delete peerConnections[adminId];
        }
    };

    // Create offer and send to admin
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('client-offer', { roomCode: currentRoomCode, adminId, offer });
        console.log('[WebRTC] Offer sent to admin:', adminId);
    } catch (err) {
        console.error('[WebRTC] Failed to create offer:', err);
        delete peerConnections[adminId];
    }
}

// === Room Code ===
function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    roomCodeInput.value = code;
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

        // Notify server that stream is ready
        socket.emit('client-ready', { roomCode: currentRoomCode });

        // If admins are already waiting, create peer connections
        waitingAdmins.forEach(adminId => {
            createPeerConnectionForAdmin(adminId);
        });
        waitingAdmins.length = 0; // Clear waiting list
        Object.keys(peerConnections).forEach(adminId => {
            createPeerConnectionForAdmin(adminId);
        });
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
                socket.emit('client-ready', { roomCode: currentRoomCode });
                resolve();
            }, (e) => reject(e));
    });
}

function stopCamera() {
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; videoPreview.srcObject = null; }
    stopRecording();
    // Close all peer connections
    Object.values(peerConnections).forEach(pc => pc.close());
    peerConnections = {};
    adminCount = 0;
    updateAdminCount();
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
            socket.emit('client-status', { roomCode: currentRoomCode, isRecording: false });
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
    socket.emit('client-screenshot', { roomCode: currentRoomCode, imageData: dataUrl });
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
    socket.emit('client-status', { roomCode: currentRoomCode, isRecording: true });
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

    // Save current admin IDs before stopping
    const adminIds = Object.keys(peerConnections);

    // Stop current tracks
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    stopRecording();

    // Restart camera
    await startCamera();

    // Recreate peer connections for all admins
    adminIds.forEach(adminId => {
        createPeerConnectionForAdmin(adminId);
    });
}

async function toggleFlash() {
    if (!videoTrack) return;
    const caps = videoTrack.getCapabilities();
    if (!caps.torch) return;
    flashActive = !flashActive;
    await videoTrack.applyConstraints({ advanced: [{ torch: flashActive }] });
    document.getElementById('flashBtn').classList.toggle('active', flashActive);
}

function updateAdminCount() {
    adminCountEl.textContent = `👁️ ${adminCount} admin${adminCount !== 1 ? 's' : ''}`;
}

function copyShareLink() {
    shareLinkInput.select();
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
        const btn = document.getElementById('copyLink');
        btn.textContent = '✅ Tersalin!';
        setTimeout(() => btn.textContent = '📋 Copy', 2000);
    });
}

// === Chat Functions ===
function renderChatMessages() {
    if (chatMessages.length === 0) {
        chatMessagesEl.innerHTML = '<div class="chat-empty">Belum ada pesan</div>';
        return;
    }

    chatMessagesEl.innerHTML = chatMessages.map(msg => {
        const isFromClient = msg.type === 'client';
        const time = new Date(msg.timestamp).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
        return `<div class="chat-message ${msg.type}">
            <div class="chat-sender">${isFromClient ? 'Device' : msg.from}</div>
            <div class="chat-text">${escapeHtml(msg.message)}</div>
            <div class="chat-time">${time}</div>
        </div>`;
    }).join('');

    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function sendClientChat() {
    const message = chatInput.value.trim();
    if (!message || !currentRoomCode) return;

    const deviceName = deviceNameInput.value.trim() || 'Camera Device';
    socket.emit('client-chat', { roomCode: currentRoomCode, message, deviceName });
    chatInput.value = '';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// === Start Broadcast ===
async function startBroadcast() {
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    const deviceName = deviceNameInput.value.trim() || 'Camera Device';

    if (!roomCode) { alert('Masukkan kode room'); return; }

    // Join room first
    socket.emit('client-join-room', { roomCode, deviceName });

    socket.once('client-room-joined', async ({ roomCode }) => {
        currentRoomCode = roomCode;
        roomCodeDisplay.textContent = `Room: ${roomCode}`;

        // Start camera
        await startCamera();

        roomSetup.classList.add('hidden');
        cameraSection.classList.remove('hidden');
        shareSection.classList.remove('hidden');

        const shareUrl = window.location.origin + `/viewer.html?room=${roomCode}`;
        shareLinkInput.value = shareUrl;

        if (typeof QRCode !== 'undefined') {
            QRCode.toCanvas(document.getElementById('qrCode'), shareUrl, {
                width: 200, margin: 2,
                color: { dark: '#0f0f1a', light: '#ffffff' }
            }, (err) => { if (err) console.error('QR Error:', err); });
        }
    });
}

// === Event Listeners ===
document.getElementById('generateCode').addEventListener('click', generateCode);
document.getElementById('startBroadcast').addEventListener('click', startBroadcast);
document.getElementById('captureBtn').addEventListener('click', capturePhoto);
document.getElementById('recordBtn').addEventListener('click', toggleRecording);
document.getElementById('switchBtn').addEventListener('click', switchCamera);
document.getElementById('flashBtn').addEventListener('click', toggleFlash);
document.getElementById('stopBroadcastBtn').addEventListener('click', () => {
    stopCamera();
    socket.emit('admin-leave-room', { roomCode: currentRoomCode });
    currentRoomCode = null;
    cameraSection.classList.add('hidden');
    shareSection.classList.add('hidden');
    roomSetup.classList.remove('hidden');
    generateCode();
});
document.getElementById('copyLink').addEventListener('click', copyShareLink);
document.getElementById('clearGallery').addEventListener('click', async () => {
    if (confirm('Hapus semua gallery?')) await clearGalleryDB();
});

// === Chat Event Listeners ===
chatSendBtn.addEventListener('click', sendClientChat);
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendClientChat();
});

// === Init ===
async function init() {
    connectSocket();
    await openDB();
    await loadGallery();
    generateCode();

    // Check URL params for room
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
        roomCodeInput.value = roomFromUrl.toUpperCase();
    }

    if (!window.isSecureContext && window.location.protocol === 'http:') {
        const warning = document.createElement('div');
        warning.style.cssText = 'background:linear-gradient(135deg,#ff6b6b,#ee5a5a);color:white;padding:16px 20px;text-align:center;font-weight:600;position:sticky;top:0;z-index:9999;';
        warning.innerHTML = '⚠️ <strong>Kamera butuh HTTPS!</strong><br><small>Buka via tunnel (Localtonet/Cloudflare).</small>';
        document.body.prepend(warning);
    }
}

init();
