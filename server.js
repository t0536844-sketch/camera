const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve public files
app.use(express.static(path.join(__dirname, 'public')));

// Root → landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});

// Track connected clients (camera devices)
const clients = {}; // clientId -> { name, socketId, status, connectedAt }

// Track active WebRTC sessions
const sessions = {}; // sessionId -> { clientId, adminId, status }

io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // === CLIENT SIDE (Camera Device) ===

    // Client registers itself
    socket.on('client-register', ({ clientId, clientName }) => {
        clients[clientId] = {
            name: clientName,
            socketId: socket.id,
            status: 'online',
            connectedAt: new Date().toISOString()
        };
        socket.clientId = clientId;
        console.log(`[Client] Registered: ${clientId} (${clientName})`);

        // Notify all admins about new client
        io.emit('client-list-updated', getClientsList());
    });

    // Client starts camera (ready to stream)
    socket.on('client-ready', ({ clientId }) => {
        if (clients[clientId]) {
            clients[clientId].status = 'streaming';
            io.emit('client-list-updated', getClientsList());
        }
    });

    // Client sends WebRTC offer to admin
    socket.on('client-offer', ({ clientId, offer }) => {
        // Find admin session for this client
        const session = Object.values(sessions).find(s => s.clientId === clientId && s.adminId);
        if (session) {
            io.to(session.adminId).emit('webrtc-offer', { clientId, offer });
        }
    });

    // Client receives WebRTC answer from admin
    socket.on('client-answer-relay', ({ targetClientId, answer }) => {
        const client = Object.values(clients).find(c => c.socketId === socket.id);
        // This is admin sending answer back, find the client socket
        const targetClient = Object.values(clients).find(c => c.socketId === targetClientId);
        if (targetClient) {
            io.to(targetClient.socketId).emit('webrtc-answer', { answer });
        }
    });

    // Client receives ICE candidate
    socket.on('client-ice-relay', ({ targetClientId, candidate }) => {
        const targetClient = Object.values(clients).find(c => c.socketId === targetClientId);
        if (targetClient) {
            io.to(targetClient.socketId).emit('webrtc-ice-candidate', { candidate });
        }
    });

    // Client sends ICE candidate to admin
    socket.on('client-ice', ({ clientId, candidate }) => {
        const session = Object.values(sessions).find(s => s.clientId === clientId && s.adminId);
        if (session) {
            io.to(session.adminId).emit('webrtc-ice-candidate', { clientId, candidate });
        }
    });

    // Client screenshot
    socket.on('client-screenshot', ({ clientId, imageData }) => {
        io.emit('client-screenshot', { clientId, imageData, timestamp: Date.now() });
    });

    // Client status update
    socket.on('client-status', ({ clientId, isRecording }) => {
        io.emit('client-status-update', { clientId, isRecording });
    });

    // === ADMIN SIDE (Monitoring Dashboard) ===

    // Admin wants to monitor a client
    socket.on('admin-monitor', ({ clientId }) => {
        socket.adminId = socket.id;
        sessions[clientId] = { clientId, adminId: socket.id, status: 'active', startedAt: Date.now() };
        console.log(`[Admin] Monitoring ${clientId} from ${socket.id}`);

        // Notify client to start streaming
        const client = clients[clientId];
        if (client) {
            io.to(client.socketId).emit('admin-request-stream', { adminId: socket.id });
        }
    });

    // Admin stops monitoring
    socket.on('admin-stop-monitor', ({ clientId }) => {
        if (sessions[clientId]) {
            delete sessions[clientId];
            const client = clients[clientId];
            if (client) {
                io.to(client.socketId).emit('admin-stop-stream', { clientId });
            }
        }
    });

    // Admin sends remote command to client
    socket.on('admin-command', ({ clientId, command }) => {
        const client = clients[clientId];
        if (client) {
            io.to(client.socketId).emit('remote-command', { command });
        }
    });

    // Admin sends WebRTC answer to client
    socket.on('admin-answer', ({ clientId, answer }) => {
        const client = clients[clientId];
        if (client) {
            io.to(client.socketId).emit('webrtc-answer', { answer });
        }
    });

    // Admin sends ICE candidate to client
    socket.on('admin-ice', ({ clientId, candidate }) => {
        const client = clients[clientId];
        if (client) {
            io.to(client.socketId).emit('webrtc-ice-candidate', { candidate });
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log(`[Socket] Disconnected: ${socket.id}`);

        // Handle client disconnect
        if (socket.clientId && clients[socket.clientId]) {
            delete clients[socket.clientId];
            io.emit('client-list-updated', getClientsList());
        }

        // Clean up admin sessions
        Object.keys(sessions).forEach(key => {
            if (sessions[key].adminId === socket.id) {
                delete sessions[key];
            }
        });
    });
});

function getClientsList() {
    return Object.entries(clients).map(([id, data]) => ({
        id,
        ...data
    }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎬 Camera Monitoring Server on port ${PORT}`);
    console.log(`   Admin: http://localhost:${PORT}/`);
    console.log(`   Client: http://localhost:${PORT}/client.html`);
});
