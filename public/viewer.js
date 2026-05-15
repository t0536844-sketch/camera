'use strict';

// === DOM Elements ===
const joinRoomSection = document.getElementById('joinRoomSection');
const roomListSection = document.getElementById('roomListSection');
const streamsSection = document.getElementById('streamsSection');
const screenshotsSection = document.getElementById('screenshotsSection');
const streamsGrid = document.getElementById('streamsGrid');
const streamCount = document.getElementById('streamCount');
const screenshots = document.getElementById('screenshots');
const connectionStatus = document.getElementById('connectionStatus');
const roomCodeInput = document.getElementById('roomCode');

// === State ===
let socket = null;
let activeRooms = {}; // roomCode -> { deviceName, viewerCount, isStreaming }
let monitoringRooms = new Set(); // rooms this admin is currently monitoring
const peerConnections = {}; // roomCode -> RTCPeerConnection

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

    // Room list updated
    socket.on('room-list-updated', (rooms) => {
        console.log('[Admin] Room list updated:', rooms);
        activeRooms = {};
        rooms.forEach(r => { activeRooms[r.roomCode] = r; });
        renderRoomList(rooms);
    });

    // Successfully joined room for monitoring
    socket.on('room-joined', ({ roomCode, deviceInfo, isStreaming }) => {
        console.log('[Admin] Joined room:', roomCode);
        monitoringRooms.add(roomCode);
        renderRoomList(Object.values(activeRooms));

        if (isStreaming) {
            // Stream is already active, set up peer connection
            setupPeerConnection(roomCode);
        }

        streamsSection.classList.remove('hidden');
        updateStreamCount();
    });

    // Room stream is ready (client started camera)
    socket.on('room-stream-ready', ({ roomCode }) => {
        console.log('[Admin] Stream ready in room:', roomCode);
        if (monitoringRooms.has(roomCode)) {
            setupPeerConnection(roomCode);
            updateStreamCard(roomCode);
        }
    });

    // Broadcaster disconnected
    socket.on('broadcaster-disconnected', ({ roomCode }) => {
        console.log('[Admin] Broadcaster disconnected:', roomCode);
        monitoringRooms.delete(roomCode);
        removeStreamCard(roomCode);
        cleanupPeerConnection(roomCode);
        updateStreamCount();
        renderRoomList(Object.values(activeRooms));

        if (monitoringRooms.size === 0) {
            streamsSection.classList.add('hidden');
        }
    });

    // WebRTC offer from client
    socket.on('webrtc-offer', async ({ roomCode, fromClientId, offer }) => {
        console.log('[WebRTC] Received offer from room:', roomCode);

        if (!peerConnections[roomCode]) {
            setupPeerConnection(roomCode);
        }

        const pc = peerConnections[roomCode];
        if (!pc) return;

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('admin-answer', { roomCode, answer });
            console.log('[WebRTC] Answer sent for room:', roomCode);
        } catch (err) {
            console.error('[WebRTC] Failed to handle offer:', err);
        }
    });

    socket.on('webrtc-ice-candidate', async ({ roomCode, candidate }) => {
        const pc = peerConnections[roomCode];
        if (pc && candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.warn('[WebRTC] ICE candidate add failed:', err);
            }
        }
    });

    // Stream status
    socket.on('stream-status', ({ roomCode, isRecording }) => {
        updateStreamCard(roomCode, isRecording);
    });

    // Screenshots
    socket.on('new-screenshot', ({ roomCode, imageData }) => {
        screenshotsSection.classList.remove('hidden');
        const img = document.createElement('img');
        img.src = imageData;
        img.title = `Room: ${roomCode}`;
        img.onclick = () => openImageModal(imageData);
        screenshots.prepend(img);
        while (screenshots.children.length > 20) screenshots.removeChild(screenshots.lastChild);
    });

    socket.on('admin-error', ({ message }) => { alert(message); });
}

// === WebRTC Peer Connection ===
function setupPeerConnection(roomCode) {
    // Close existing if any
    if (peerConnections[roomCode]) {
        peerConnections[roomCode].close();
    }

    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[roomCode] = pc;

    pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
            const video = document.getElementById(`video-${roomCode}`);
            if (video) {
                video.srcObject = event.streams[0];
                video.onloadedmetadata = () => { video.play(); };
            }
            updateStreamCard(roomCode, null, true);
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('admin-ice', { roomCode, candidate: event.candidate });
        }
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
            updateStreamCard(roomCode, null, true);
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
            updateStreamCard(roomCode, null, false);
        }
    };
}

function cleanupPeerConnection(roomCode) {
    if (peerConnections[roomCode]) {
        peerConnections[roomCode].close();
        delete peerConnections[roomCode];
    }
}

// === Render Room List ===
function renderRoomList(rooms) {
    const roomList = document.getElementById('roomList');

    if (rooms.length === 0) {
        roomList.innerHTML = '<div class="room-empty"><p>Belum ada room aktif</p></div>';
        return;
    }

    roomList.innerHTML = rooms.map(room => {
        const isMonitoring = monitoringRooms.has(room.roomCode);
        return `
        <div class="room-card ${isMonitoring ? 'monitoring' : ''}">
            <div class="room-info">
                <div class="room-code">${room.roomCode}</div>
                <div class="room-meta">
                    <span class="room-device">📷 ${room.deviceName}</span>
                    <span class="room-viewers">👁️ ${room.viewerCount} admin${room.viewerCount !== 1 ? 's' : ''}</span>
                    ${room.isStreaming ? '<span class="room-live">🔴 LIVE</span>' : '<span class="room-waiting">⏳ Waiting</span>'}
                </div>
            </div>
            <div class="room-actions">
                ${isMonitoring
                    ? `<button class="btn btn-danger btn-small" onclick="leaveRoom('${room.roomCode}')">Leave</button>`
                    : `<button class="btn btn-primary btn-small" onclick="joinRoom('${room.roomCode}')">📹 Monitor</button>`
                }
            </div>
        </div>`;
    }).join('');
}

// === Join/Leave Room ===
function joinRoom(roomCode) {
    roomCode = roomCode.toUpperCase();
    if (monitoringRooms.has(roomCode)) return;

    socket.emit('admin-join-room', { roomCode });
}

function leaveRoom(roomCode) {
    socket.emit('admin-leave-room', { roomCode });
    monitoringRooms.delete(roomCode);
    removeStreamCard(roomCode);
    cleanupPeerConnection(roomCode);
    updateStreamCount();
    renderRoomList(Object.values(activeRooms));

    if (monitoringRooms.size === 0) {
        streamsSection.classList.add('hidden');
    }
}

window.joinRoom = joinRoom;
window.leaveRoom = leaveRoom;

// === Stream Cards ===
function createStreamCard(roomCode) {
    if (document.getElementById(`stream-${roomCode}`)) return;

    const room = activeRooms[roomCode] || {};
    const card = document.createElement('div');
    card.id = `stream-${roomCode}`;
    card.className = 'stream-card';
    card.innerHTML = `
        <div class="stream-card-header">
            <span class="stream-room-code">${roomCode}</span>
            <span class="stream-device">📷 ${room.deviceName || 'Unknown'}</span>
            <button class="btn btn-danger btn-small stream-leave-btn" onclick="leaveRoom('${roomCode}')">✕</button>
        </div>
        <div class="stream-video-wrapper">
            <video id="video-${roomCode}" autoplay playsinline></video>
            <div class="stream-status-overlay" id="status-${roomCode}">
                <span class="waiting-text">⏳ Menunggu stream...</span>
            </div>
            <div class="stream-controls">
                <button class="ctrl-btn" onclick="sendCommand('${roomCode}', 'capture')" title="Foto">📷</button>
                <button class="ctrl-btn" onclick="sendCommand('${roomCode}', 'record')" title="Rekam">⏺️</button>
                <button class="ctrl-btn" onclick="sendCommand('${roomCode}', 'switch')" title="Ganti Kamera">🔄</button>
                <button class="ctrl-btn" onclick="sendCommand('${roomCode}', 'flash')" title="Flash">🔦</button>
            </div>
        </div>`;
    streamsGrid.appendChild(card);
}

function updateStreamCard(roomCode, isRecording = null, isLive = null) {
    const statusEl = document.getElementById(`status-${roomCode}`);
    if (!statusEl) {
        // Card doesn't exist yet, create it
        createStreamCard(roomCode);
        return;
    }

    if (isLive === true) {
        statusEl.innerHTML = isRecording
            ? '<span class="recording-badge">🔴 REC</span>'
            : '<span class="live-badge">🟢 LIVE</span>';
    } else if (isRecording === true) {
        statusEl.innerHTML = '<span class="recording-badge">🔴 REC</span>';
    } else if (isRecording === false) {
        statusEl.innerHTML = '<span class="live-badge">🟢 LIVE</span>';
    }
}

function removeStreamCard(roomCode) {
    const card = document.getElementById(`stream-${roomCode}`);
    if (card) card.remove();
}

function updateStreamCount() {
    const count = monitoringRooms.size;
    streamCount.textContent = `${count} stream${count !== 1 ? 's' : ''}`;
}

// === Remote Commands ===
function sendCommand(roomCode, command) {
    socket.emit('admin-command', { roomCode, command });
}

window.sendCommand = sendCommand;

// === Image Modal ===
function openImageModal(src) {
    const modal = document.getElementById('imageModal');
    const img = document.getElementById('fullImage');
    img.src = src;
    modal.classList.remove('hidden');
}

document.getElementById('modalClose').addEventListener('click', () => {
    document.getElementById('imageModal').classList.add('hidden');
});

// === Join Room Button ===
document.getElementById('joinRoomBtn').addEventListener('click', () => {
    const code = roomCodeInput.value.trim().toUpperCase();
    if (!code) { alert('Masukkan kode room'); return; }
    joinRoom(code);
});

// === Auto-join from URL ===
function initFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) {
        roomCodeInput.value = room.toUpperCase();
        setTimeout(() => joinRoom(room.toUpperCase()), 1500);
    }
}

// === Init ===
function init() {
    connectSocket();
    initFromUrl();
}

init();
