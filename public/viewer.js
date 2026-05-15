'use strict';

// === DOM Elements ===
const streamVideo = document.getElementById('streamVideo');
const joinSetup = document.getElementById('joinSetup');
const streamSection = document.getElementById('streamSection');
const screenshotsSection = document.getElementById('screenshotsSection');
const screenshots = document.getElementById('screenshots');
const roomCodeInput = document.getElementById('roomCode');
const connectionStatus = document.getElementById('connectionStatus');
const streamText = document.getElementById('streamText');
const deviceInfo = document.getElementById('deviceInfo');

// === State ===
let socket = null;
let peerConnection = null;
let currentRoomCode = null;
let broadcasterId = null;

const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// === Check URL params ===
function initFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room) {
        roomCodeInput.value = room.toUpperCase();
        // Auto-join after short delay (socket needs to connect first)
        setTimeout(() => { joinRoom(); }, 1000);
    }
}

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

    socket.on('room-joined', ({ broadcasterId, deviceInfo }) => {
        console.log('[Viewer] Joined room, broadcaster:', broadcasterId);
        window.broadcasterId = broadcasterId;
        currentRoomCode = roomCodeInput.value.toUpperCase();

        if (deviceInfo) {
            deviceInfo.textContent = `📱 ${deviceInfo.name} — ${deviceInfo.platform}`;
            deviceInfo.classList.remove('hidden');
        }

        streamText.textContent = '⏳ Menunggu stream dari broadcaster...';

        // Setup peer connection - viewer waits for broadcaster's offer
        setupPeerConnection();
    });

    socket.on('join-error', ({ message }) => { alert(message); });

    // === WebRTC: Receive offer from broadcaster ===
    socket.on('webrtc-offer', async ({ fromId, offer }) => {
        console.log('[WebRTC] Received offer from broadcaster');
        if (!peerConnection) setupPeerConnection();

        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            // Send answer back to broadcaster
            socket.emit('webrtc-answer', { targetId: fromId, answer });
            console.log('[WebRTC] Answer sent to broadcaster');
        } catch (err) {
            console.error('[WebRTC] Failed to handle offer:', err);
        }
    });

    socket.on('webrtc-ice-candidate', async ({ fromId, candidate }) => {
        console.log('[WebRTC] ICE candidate received');
        if (peerConnection && candidate) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.warn('[WebRTC] ICE candidate add failed:', err);
            }
        }
    });

    // Stream status updates
    socket.on('stream-status', ({ isRecording }) => {
        const dot = document.querySelector('.live-dot');
        if (isRecording) {
            streamText.textContent = '🔴 Broadcaster sedang merekam';
            if (dot) dot.style.background = '#ff6b6b';
        } else {
            streamText.textContent = '🟢 Live';
            if (dot) dot.style.background = '#00cec9';
        }
    });

    socket.on('broadcaster-disconnected', () => {
        alert('Broadcaster telah memutus koneksi');
        streamVideo.srcObject = null;
        joinSetup.classList.remove('hidden');
        streamSection.classList.add('hidden');
        if (peerConnection) { peerConnection.close(); peerConnection = null; }
    });

    // Screenshots from broadcaster
    socket.on('new-screenshot', ({ imageData }) => {
        screenshotsSection.classList.remove('hidden');
        const img = document.createElement('img');
        img.src = imageData;
        img.onclick = () => openImageModal(imageData);
        screenshots.prepend(img);
        while (screenshots.children.length > 20) screenshots.removeChild(screenshots.lastChild);
    });
}

// === WebRTC Peer Connection (Viewer = recvonly) ===
function setupPeerConnection() {
    peerConnection = new RTCPeerConnection(rtcConfig);

    // Show stream when tracks arrive
    peerConnection.ontrack = (event) => {
        console.log('[WebRTC] Received stream track, kind:', event.track.kind);
        if (event.streams && event.streams[0]) {
            streamVideo.srcObject = event.streams[0];
            streamVideo.onloadedmetadata = () => {
                streamVideo.play();
                streamText.textContent = '🟢 Live';
            };
        }
    };

    // Send ICE candidates to broadcaster
    peerConnection.onicecandidate = (event) => {
        if (event.candidate && window.broadcasterId) {
            socket.emit('webrtc-ice-candidate', {
                targetId: window.broadcasterId,
                candidate: event.candidate
            });
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('[WebRTC] Connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'connected') {
            streamText.textContent = '🟢 Live';
        } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
            streamText.textContent = '❌ Koneksi terputus';
        }
    };
}

// === Join Room ===
function joinRoom() {
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    if (!roomCode) { alert('Masukkan kode room'); return; }

    socket.emit('join-room', { roomCode });
}

// === Remote Commands ===
function sendRemoteCommand(command) {
    socket.emit('remote-command', { roomCode: currentRoomCode, command });
}

// === Modal ===
function openImageModal(src) {
    const modal = document.getElementById('imageModal');
    const img = document.getElementById('fullImage');
    img.src = src;
    modal.classList.remove('hidden');
}

document.getElementById('modalClose').addEventListener('click', () => {
    document.getElementById('imageModal').classList.add('hidden');
});

// === Event Listeners ===
document.getElementById('joinRoom').addEventListener('click', joinRoom);
document.getElementById('remoteCapture').addEventListener('click', () => sendRemoteCommand('capture'));
document.getElementById('remoteRecord').addEventListener('click', () => sendRemoteCommand('record'));

// === Init ===
function init() {
    initFromUrl();
    connectSocket();
}

init();
