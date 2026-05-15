'use strict';

// === DOM Elements ===
const streamVideo = document.getElementById('streamVideo');
const clientListSection = document.getElementById('clientListSection');
const streamSection = document.getElementById('streamSection');
const screenshotsSection = document.getElementById('screenshotsSection');
const screenshots = document.getElementById('screenshots');
const connectionStatus = document.getElementById('connectionStatus');
const streamText = document.getElementById('streamText');
const streamTitle = document.getElementById('streamTitle');
const clientList = document.getElementById('clientList');

// === State ===
let socket = null;
let peerConnection = null;
let monitoringClientId = null;
let connectedClients = {}; // clientId -> { name, status, socketId, connectedAt }

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

    // Client list updated
    socket.on('client-list-updated', (clients) => {
        console.log('[Admin] Client list updated:', clients);
        connectedClients = {};
        clients.forEach(c => { connectedClients[c.id] = c; });
        renderClientList(clients);
    });

    // WebRTC: Receive offer from client
    socket.on('webrtc-offer', async ({ clientId, offer }) => {
        console.log('[WebRTC] Received offer from client:', clientId);

        if (!peerConnection) setupPeerConnection(clientId);

        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);

            // Send answer back to client
            socket.emit('admin-answer', { clientId, answer });
            console.log('[WebRTC] Answer sent to client:', clientId);
        } catch (err) {
            console.error('[WebRTC] Failed to handle offer:', err);
        }
    });

    socket.on('webrtc-ice-candidate', async ({ clientId, candidate }) => {
        console.log('[WebRTC] ICE candidate from client:', clientId);
        if (peerConnection && candidate) {
            try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.warn('[WebRTC] ICE candidate add failed:', err);
            }
        }
    });

    // Client screenshot
    socket.on('client-screenshot', ({ clientId, imageData, timestamp }) => {
        console.log('[Admin] Screenshot from:', clientId);
        screenshotsSection.classList.remove('hidden');
        const img = document.createElement('img');
        img.src = imageData;
        img.title = new Date(timestamp).toLocaleTimeString();
        img.onclick = () => openImageModal(imageData);
        screenshots.prepend(img);
        while (screenshots.children.length > 20) screenshots.removeChild(screenshots.lastChild);
    });

    // Client status update
    socket.on('client-status-update', ({ clientId, isRecording }) => {
        const client = connectedClients[clientId];
        if (client && clientId === monitoringClientId) {
            if (isRecording) {
                streamText.textContent = '🔴 Client sedang merekam';
                document.querySelector('.live-dot').style.background = '#ff6b6b';
            } else {
                streamText.textContent = '🟢 Live';
                document.querySelector('.live-dot').style.background = '#00cec9';
            }
        }
    });
}

// === WebRTC Peer Connection (Admin = recvonly) ===
function setupPeerConnection(clientId) {
    // Close existing connection if any
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

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

    // Send ICE candidates to client
    peerConnection.onicecandidate = (event) => {
        if (event.candidate && monitoringClientId) {
            socket.emit('admin-ice', { clientId: monitoringClientId, candidate: event.candidate });
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

// === Render Client List ===
function renderClientList(clients) {
    if (clients.length === 0) {
        clientList.innerHTML = `
            <div class="client-empty">
                <p>Belum ada device terhubung</p>
                <p class="hint">Device buka halaman camera untuk mulai</p>
            </div>`;
        return;
    }

    clientList.innerHTML = clients.map(client => {
        const isStreaming = client.status === 'streaming';
        const isMonitoring = client.id === monitoringClientId;
        return `
        <div class="client-card ${isMonitoring ? 'monitoring' : ''}" data-id="${client.id}">
            <div class="client-info">
                <div class="client-name">${client.name}</div>
                <div class="client-meta">
                    <span class="client-status-badge ${isStreaming ? 'streaming' : 'online'}">
                        ${isStreaming ? '🔴 Streaming' : '🟢 Online'}
                    </span>
                    <span class="client-id">${client.id}</span>
                </div>
            </div>
            <div class="client-actions">
                ${isMonitoring
                    ? `<button class="btn btn-danger btn-small" onclick="stopMonitoring('${client.id}')">⏹️ Stop</button>`
                    : `<button class="btn btn-primary btn-small" onclick="startMonitoring('${client.id}')" ${!isStreaming ? 'disabled' : ''}>📹 Monitor</button>`
                }
            </div>
        </div>`;
    }).join('');
}

// === Start/Stop Monitoring ===
function startMonitoring(clientId) {
    const client = connectedClients[clientId];
    if (!client) return;

    monitoringClientId = clientId;
    streamTitle.textContent = `📹 ${client.name}`;
    streamText.textContent = '⏳ Meminta stream...';

    streamSection.classList.remove('hidden');
    screenshotsSection.classList.add('hidden');
    screenshots.innerHTML = '';

    // Tell server to start monitoring
    socket.emit('admin-monitor', { clientId });

    // Setup peer connection (will receive offer from client)
    setupPeerConnection(clientId);

    // Update client list UI
    document.querySelectorAll('.client-card').forEach(card => {
        card.classList.toggle('monitoring', card.dataset.id === clientId);
    });
}

function stopMonitoring(clientId) {
    socket.emit('admin-stop-monitor', { clientId });

    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }

    streamVideo.srcObject = null;
    streamSection.classList.add('hidden');
    monitoringClientId = null;
    streamText.textContent = 'Menunggu stream...';

    renderClientList(Object.values(connectedClients));
}

// Make functions globally accessible for onclick handlers
window.startMonitoring = startMonitoring;
window.stopMonitoring = stopMonitoring;

// === Remote Commands ===
function sendRemoteCommand(command) {
    if (!monitoringClientId) return;
    socket.emit('admin-command', { clientId: monitoringClientId, command });
}

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

// === Event Listeners ===
document.getElementById('remoteCapture').addEventListener('click', () => sendRemoteCommand('capture'));
document.getElementById('remoteRecord').addEventListener('click', () => sendRemoteCommand('record'));
document.getElementById('remoteSwitch').addEventListener('click', () => sendRemoteCommand('switch'));
document.getElementById('remoteFlash').addEventListener('click', () => sendRemoteCommand('flash'));
document.getElementById('stopMonitor').addEventListener('click', () => {
    if (monitoringClientId) stopMonitoring(monitoringClientId);
});

// === Init ===
function init() {
    connectSocket();
}

init();
