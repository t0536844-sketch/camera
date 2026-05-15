const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Rooms store active broadcaster info
const rooms = {};

io.on('connection', (socket) => {
    console.log(`[Socket] User connected: ${socket.id}`);

    // Broadcaster starts stream
    socket.on('start-broadcast', ({ roomCode, deviceInfo }) => {
        if (rooms[roomCode]) {
            socket.emit('broadcast-error', { message: 'Room sudah digunakan' });
            return;
        }
        rooms[roomCode] = {
            broadcasterId: socket.id,
            deviceInfo,
            viewers: [],
            createdAt: Date.now()
        };
        socket.join(roomCode);
        socket.roomCode = roomCode;
        console.log(`[Room] Broadcaster ${socket.id} started room: ${roomCode}`);
        socket.emit('broadcast-started', { roomCode });
    });

    // Viewer wants to join
    socket.on('join-room', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) {
            socket.emit('join-error', { message: 'Room tidak ditemukan' });
            return;
        }
        if (!room.broadcasterId) {
            socket.emit('join-error', { message: 'Belum ada yang streaming' });
            return;
        }
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.isViewer = true;
        room.viewers.push(socket.id);
        
        // Notify broadcaster
        socket.to(room.broadcasterId).emit('viewer-joined', {
            viewerId: socket.id,
            viewerCount: room.viewers.length
        });
        
        socket.emit('room-joined', {
            roomCode,
            broadcasterId: room.broadcasterId,
            deviceInfo: room.deviceInfo
        });
        console.log(`[Room] Viewer ${socket.id} joined room: ${roomCode}`);
    });

    // WebRTC signaling: offer
    socket.on('webrtc-offer', ({ targetId, offer }) => {
        socket.to(targetId).emit('webrtc-offer', {
            fromId: socket.id,
            offer
        });
    });

    // WebRTC signaling: answer
    socket.on('webrtc-answer', ({ targetId, answer }) => {
        socket.to(targetId).emit('webrtc-answer', {
            fromId: socket.id,
            answer
        });
    });

    // WebRTC signaling: ICE candidate
    socket.on('webrtc-ice-candidate', ({ targetId, candidate }) => {
        socket.to(targetId).emit('webrtc-ice-candidate', {
            fromId: socket.id,
            candidate
        });
    });

    // Remote control commands from viewer to broadcaster
    socket.on('remote-command', ({ roomCode, command }) => {
        const room = rooms[roomCode];
        if (room && room.broadcasterId) {
            socket.to(room.broadcasterId).emit('remote-command', {
                fromViewer: socket.id,
                command
            });
        }
    });

    // Broadcaster sends screenshot to viewers
    socket.on('broadcast-screenshot', ({ roomCode, imageData }) => {
        socket.to(roomCode).emit('new-screenshot', { imageData });
    });

    // Broadcaster status updates
    socket.on('broadcaster-status', ({ roomCode, isRecording }) => {
        socket.to(roomCode).emit('stream-status', { isRecording });
    });

    // Disconnect
    socket.on('disconnect', () => {
        console.log(`[Socket] User disconnected: ${socket.id}`);
        
        if (socket.roomCode) {
            const room = rooms[socket.roomCode];
            if (room) {
                if (room.broadcasterId === socket.id) {
                    // Broadcaster disconnected — notify all viewers
                    io.to(room.roomCode).emit('broadcaster-disconnected');
                    delete rooms[socket.roomCode];
                    console.log(`[Room] Room ${socket.roomCode} removed (broadcaster left)`);
                } else {
                    // Viewer disconnected
                    room.viewers = room.viewers.filter(id => id !== socket.id);
                    if (room.broadcasterId) {
                        socket.to(room.broadcasterId).emit('viewer-left', {
                            viewerId: socket.id,
                            viewerCount: room.viewers.length
                        });
                    }
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🎬 Camera Stream Server running on port ${PORT}`);
    console.log(`   Local: http://localhost:${PORT}`);
    console.log(`   Network: http://<YOUR_IP>:${PORT}`);
});
