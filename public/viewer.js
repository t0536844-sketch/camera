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

        streamText.textContent = 'Menunggu stream...';
    });

    socket.on('join-error', ({ message }) => {
        alert(message);
    });

    // WebRTC signaling
    socket.on('webrtc-offer', async ({ fromId, offer }) => {
        console.log('[WebRTC] Received offer');
        if (!peerConnection) setupPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('webrtc-answer', { targetId: fromId, answer });
    });

    socket.on('webrtc-answer', async ({ fromId, answer }) => {
        console.log('[WebRTC] Received answer');
        if (peerConnection) {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        }
    });

    socket.on('webrtc-ice-candidate', async ({ fromId, candidate }) => {
        console.log('[WebRTC] ICE candidate');
        if (peerConnection) {
            await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        }
    });

    // Stream status
    socket.on('stream-status', ({ isRecording }) => {
        const dot = document.querySelector('.live-dot');
        if (isRecording) {
            streamText.textContent = '🔴 Broadcaster sedang merekam';
            dot.style.background = '#ff6b6b';
        } else {
            streamText.textContent = 'Live';
            dot.style.background = '#00cec9';
        }
    });

    socket.on('broadcaster-disconnected', () => {
        alert('Broadcaster telah memutus koneksi');
        streamVideo.srcObject = null;
        joinSetup.classList.remove('hidden');
        streamSection.classList.add('hidden');
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
    });

    // Screenshots from broadcaster
    socket.on('new-screenshot', ({ imageData }) => {
        screenshotsSection.classList.remove('hidden');
        const img = document.createElement('img');
        img.src = imageData;
        img.onclick = () => openImageModal(imageData);
        screenshots.prepend(img);

        // Keep max 20 screenshots
        while (screenshots.children.length > 20) {
            screenshots.removeChild(screenshots.lastChild);
        }
    });
}

// === WebRTC Peer Connection ===
function setupPeerConnection() {
    peerConnection = new RTCPeerConnection(rtcConfig);

    peerConnection.ontrack = (event) => {
        console.log('[WebRTC] Received stream');
        streamVideo.srcObject = event.streams[0];
        streamText.textContent = '🟢 Live';
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('webrtc-ice-candidate', {
                targetId: window.broadcasterId,
                candidate: event.candidate
            });
        }
    };
}

async function startViewerStream() {
    if (!peerConnection) setupPeerConnection();

    // Add receiver transceiver
    peerConnection.addTransceiver('video', { direction: 'recvonly' });
    peerConnection.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('webrtc-offer', { targetId: window.broadcasterId, offer });
}

// === Join Room ===
function joinRoom() {
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    if (!roomCode) {
        alert('Masukkan kode room');
        return;
    }

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
document.getElementById('remoteCapture').addEventListener('click', () => {
    sendRemoteCommand('capture');
});
document.getElementById('remoteRecord').addEventListener('click', () => {
    sendRemoteCommand('record');
});

// === Init ===
function init() {
    initFromUrl();
    connectSocket();
}

init();
