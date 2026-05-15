const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve public files (disable auto index.html for /)
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Root → landing page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'home.html'));
});

// Rooms: roomCode → { broadcasterId, viewers: [adminSocketId], deviceInfo, isStreaming }
const rooms = {};

io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    // === CLIENT (Camera Device) ===

    // Client joins/creates a room
    socket.on('client-join-room', ({ roomCode, deviceName }) => {
        roomCode = roomCode.toUpperCase();

        // Check if room already has broadcaster
        if (rooms[roomCode] && rooms[roomCode].broadcasterId) {
            socket.emit('client-error', { message: `Room ${roomCode} sudah ada broadcaster` });
            return;
        }

        rooms[roomCode] = {
            broadcasterId: socket.id,
            viewers: [],
            deviceInfo: { name: deviceName || 'Camera', platform: 'browser' },
            isStreaming: false
        };

        socket.roomCode = roomCode;
        console.log(`[Room] Client ${socket.id} created room: ${roomCode} (${deviceName})`);

        // Broadcast room list to admins
        broadcastRoomList();

        socket.emit('client-room-joined', { roomCode });
    });

    // Client ready to stream (camera started)
    socket.on('client-ready', ({ roomCode }) => {
        if (rooms[roomCode]) {
            rooms[roomCode].isStreaming = true;
            broadcastRoomList();

            // Notify all admins in room that stream is ready
            rooms[roomCode].viewers.forEach(adminId => {
                io.to(adminId).emit('room-stream-ready', { roomCode });
            });
        }
    });

    // Client sends WebRTC offer to specific admin
    socket.on('client-offer', ({ roomCode, adminId, offer }) => {
        io.to(adminId).emit('webrtc-offer', { roomCode, fromClientId: socket.id, offer });
    });

    // Client sends ICE candidate to admin
    socket.on('client-ice', ({ roomCode, adminId, candidate }) => {
        io.to(adminId).emit('webrtc-ice-candidate', { roomCode, candidate });
    });

    // Client sends screenshot
    socket.on('client-screenshot', ({ roomCode, imageData }) => {
        if (rooms[roomCode]) {
            rooms[roomCode].viewers.forEach(adminId => {
                io.to(adminId).emit('new-screenshot', { roomCode, imageData });
            });
        }
    });

    // Client status update
    socket.on('client-status', ({ roomCode, isRecording }) => {
        if (rooms[roomCode]) {
            rooms[roomCode].viewers.forEach(adminId => {
                io.to(adminId).emit('stream-status', { roomCode, isRecording });
            });
        }
    });

    // === ADMIN (Monitoring Dashboard) ===

    // Admin joins room to monitor
    socket.on('admin-join-room', ({ roomCode }) => {
        roomCode = roomCode.toUpperCase();
        const room = rooms[roomCode];

        if (!room || !room.broadcasterId) {
            socket.emit('admin-error', { message: `Room ${roomCode} tidak ditemukan` });
            return;
        }

        if (room.viewers.includes(socket.id)) {
            socket.emit('admin-error', { message: 'Sudah ada di room ini' });
            return;
        }

        room.viewers.push(socket.id);
        socket.adminRoom = roomCode;

        console.log(`[Admin] ${socket.id} joined room ${roomCode}`);

        // Notify client that admin is watching
        io.to(room.broadcasterId).emit('admin-watching', { adminId: socket.id, roomCode });

        // Tell admin about current room state
        socket.emit('room-joined', {
            roomCode,
            deviceInfo: room.deviceInfo,
            isStreaming: room.isStreaming
        });

        broadcastRoomList();
    });

    // Admin stops monitoring room
    socket.on('admin-leave-room', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (room) {
            room.viewers = room.viewers.filter(id => id !== socket.id);
            io.to(room.broadcasterId).emit('admin-left', { adminId: socket.id, roomCode });
            broadcastRoomList();
        }
        socket.adminRoom = null;
    });

    // Admin sends remote command to client
    socket.on('admin-command', ({ roomCode, command }) => {
        const room = rooms[roomCode];
        if (room && room.broadcasterId) {
            io.to(room.broadcasterId).emit('remote-command', { command });
        }
    });

    // Admin sends WebRTC answer to client
    socket.on('admin-answer', ({ roomCode, answer }) => {
        const room = rooms[roomCode];
        if (room && room.broadcasterId) {
            io.to(room.broadcasterId).emit('webrtc-answer', { roomCode, answer });
        }
    });

    // Admin sends ICE candidate to client
    socket.on('admin-ice', ({ roomCode, candidate }) => {
        const room = rooms[roomCode];
        if (room && room.broadcasterId) {
            io.to(room.broadcasterId).emit('webrtc-ice-candidate', { roomCode, candidate });
        }
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log(`[Socket] Disconnected: ${socket.id}`);

        // Handle client disconnect
        if (socket.roomCode && rooms[socket.roomCode]) {
            const room = rooms[socket.roomCode];
            // Notify all admins in room
            room.viewers.forEach(adminId => {
                io.to(adminId).emit('broadcaster-disconnected', { roomCode: socket.roomCode });
            });
            delete rooms[socket.roomCode];
            broadcastRoomList();
        }

        // Handle admin disconnect
        if (socket.adminRoom && rooms[socket.adminRoom]) {
            const room = rooms[socket.adminRoom];
            room.viewers = room.viewers.filter(id => id !== socket.id);
            if (room.broadcasterId) {
                io.to(room.broadcasterId).emit('admin-left', { adminId: socket.id, roomCode: socket.adminRoom });
            }
            broadcastRoomList();
        }
    });
});

function broadcastRoomList() {
    const roomList = Object.entries(rooms).map(([code, room]) => ({
        roomCode: code,
        deviceName: room.deviceInfo.name,
        viewerCount: room.viewers.length,
        isStreaming: room.isStreaming
    }));
    io.emit('room-list-updated', roomList);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎬 Camera Monitoring Server on port ${PORT}`);
    console.log(`   🏠 Home: http://localhost:${PORT}/`);
    console.log(`   📷 Camera Device: http://localhost:${PORT}/index.html`);
    console.log(`   🎬 Admin Monitor: http://localhost:${PORT}/viewer.html`);
});
