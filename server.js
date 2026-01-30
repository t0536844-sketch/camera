const express = require('express');
const socketIO = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

io.on('connection', (socket) => {
    console.log('User connected');
    
    socket.on('join-room', (roomCode) => {
        socket.join(roomCode);
        socket.room = roomCode;
    });
    
    socket.on('command', (data) => {
        io.to(socket.room).emit('remote-command', data);
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

server.listen(3000, () => {
    console.log('Server running on port 3000');
});
