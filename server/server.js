'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const engine = require('../shared/engine');
const { RoomManager, normalizeCode } = require('./rooms');

const JOIN_WINDOW_MS = 60 * 1000;
const JOIN_MAX = 20;
const CLEANUP_INTERVAL_MS = 30 * 1000;

function createServer(options = {}) {
  const quiet = !!options.quiet;
  const log = (...args) => {
    if (!quiet) console.log(...args);
  };

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    pingInterval: 25000,
    pingTimeout: 20000,
    maxHttpBufferSize: 100 * 1024
  });
  const rooms = new RoomManager();

  const publicDir = path.join(__dirname, '..', 'public');
  const sharedDir = path.join(__dirname, '..', 'shared');

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data:; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'"
    );
    next();
  });

  app.use(express.static(publicDir, { index: false, maxAge: '5m' }));
  app.use('/shared', express.static(sharedDir, { maxAge: '5m' }));

  const indexFile = path.join(publicDir, 'index.html');
  const sendIndex = (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  };

  app.get('/health', (req, res) => {
    res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
  });
  app.get('/', sendIndex);
  app.get('/room/:code', (req, res, next) => {
    if (!normalizeCode(req.params.code)) return next();
    sendIndex(req, res);
  });
  app.use((req, res) => {
    res.status(404).type('text/plain').send('No encontrado');
  });

  // ==================== AYUDANTES DE SOCKET ====================

  function respond(ack, payload) {
    if (typeof ack === 'function') ack(payload);
  }

  function allowJoin(socket) {
    const now = Date.now();
    if (!Array.isArray(socket.data.joinAttempts)) socket.data.joinAttempts = [];
    socket.data.joinAttempts = socket.data.joinAttempts
      .filter(time => now - time < JOIN_WINDOW_MS);
    if (socket.data.joinAttempts.length >= JOIN_MAX) return false;
    socket.data.joinAttempts.push(now);
    return true;
  }

  function broadcast(room) {
    if (!room) return;
    io.to(room.code).emit('room:update', rooms.publicRoom(room));
  }

  function bind(socket, room, player) {
    const oldCode = socket.data.roomCode;
    const oldToken = socket.data.token;

    // Si el socket estaba en otra sala, liberamos su asiento anterior.
    if (oldCode && oldCode !== room.code) {
      const oldRoom = rooms.getRoom(oldCode);
      if (oldRoom) {
        const found = rooms.findPlayer(oldRoom, oldToken);
        if (found && found.player.socketId === socket.id) {
          rooms.leave(oldRoom, oldToken);
          if (rooms.getRoom(oldCode)) broadcast(oldRoom);
        }
      }
      socket.leave(oldCode);
    }

    socket.data.joinAttempts = socket.data.joinAttempts || [];

    // Si el jugador tenía otro socket (pestaña vieja), lo sacamos de la sala.
    if (player.socketId && player.socketId !== socket.id) {
      const old = io.sockets.sockets.get(player.socketId);
      if (old) {
        old.leave(room.code);
        old.data.roomCode = null;
        old.data.token = null;
      }
    }

    rooms.attach(room, player, socket.id);
    socket.data.roomCode = room.code;
    socket.data.token = player.token;
    socket.join(room.code);
  }

  function current(socket) {
    const room = rooms.getRoom(socket.data.roomCode);
    if (!room) return null;
    const found = rooms.findPlayer(room, socket.data.token);
    if (!found) return null;
    return { room, player: found.player, color: found.color };
  }

  // ==================== EVENTOS ====================

  io.on('connection', (socket) => {
    log('Conectado:', socket.id);

    socket.on('room:create', (payload, ack) => {
      try {
        if (!allowJoin(socket)) {
          return respond(ack, { ok: false, error: 'rate_limited' });
        }
        const name = payload && payload.name;
        const { room, player, color } = rooms.createRoom(name);
        bind(socket, room, player);

        const publicRoom = rooms.publicRoom(room);
        respond(ack, {
          ok: true,
          code: room.code,
          token: player.token,
          color,
          resumed: false,
          room: publicRoom
        });
        broadcast(room);
        log('Sala creada:', room.code);
      } catch (error) {
        console.error('Error en room:create:', error);
        respond(ack, { ok: false, error: 'server_error' });
      }
    });

    socket.on('room:join', (payload, ack) => {
      try {
        if (!allowJoin(socket)) {
          return respond(ack, { ok: false, error: 'rate_limited' });
        }
        const code = normalizeCode(payload && payload.code);
        if (!code) return respond(ack, { ok: false, error: 'invalid_code' });

        const result = rooms.joinRoom(code, payload && payload.token, payload && payload.name);
        if (result.error) return respond(ack, { ok: false, error: result.error });

        bind(socket, result.room, result.player);
        respond(ack, {
          ok: true,
          code: result.room.code,
          token: result.player.token,
          color: result.color,
          resumed: !!result.resumed,
          room: rooms.publicRoom(result.room)
        });
        broadcast(result.room);
        log('Sala unida:', result.room.code, result.color);
      } catch (error) {
        console.error('Error en room:join:', error);
        respond(ack, { ok: false, error: 'server_error' });
      }
    });

    socket.on('game:move', (payload, ack) => {
      try {
        const context = current(socket);
        if (!context) return respond(ack, { ok: false, error: 'not_in_room' });

        const result = rooms.applyMove(
          context.room,
          context.color,
          payload && payload.from,
          payload && payload.to,
          payload && payload.promotion
        );
        if (!result.ok) return respond(ack, result);

        respond(ack, {
          ok: true,
          move: result.move,
          status: result.status,
          room: rooms.publicRoom(context.room)
        });
        broadcast(context.room);
      } catch (error) {
        console.error('Error en game:move:', error);
        respond(ack, { ok: false, error: 'server_error' });
      }
    });

    socket.on('game:resign', (payload, ack) => {
      try {
        const context = current(socket);
        if (!context) return respond(ack, { ok: false, error: 'not_in_room' });
        if (!rooms.resign(context.room, context.color)) {
          return respond(ack, { ok: false, error: 'game_over' });
        }
        respond(ack, { ok: true });
        broadcast(context.room);
        log('Abandono:', context.room.code, context.color);
      } catch (error) {
        console.error('Error en game:resign:', error);
        respond(ack, { ok: false, error: 'server_error' });
      }
    });

    socket.on('game:rematch', (payload, ack) => {
      try {
        const context = current(socket);
        if (!context) return respond(ack, { ok: false, error: 'not_in_room' });

        const result = rooms.voteRematch(context.room, context.color);
        if (!result.ok) return respond(ack, result);

        respond(ack, { ok: true, started: result.started });

        if (result.started) {
          for (const color of ['white', 'black']) {
            const player = context.room.players[color];
            if (player && player.connected && player.socketId) {
              io.to(player.socketId).emit('room:color', { color });
            }
          }
          log('Revancha:', context.room.code);
        }
        broadcast(context.room);
      } catch (error) {
        console.error('Error en game:rematch:', error);
        respond(ack, { ok: false, error: 'server_error' });
      }
    });

    socket.on('room:leave', (payload, ack) => {
      try {
        const context = current(socket);
        if (!context) return respond(ack, { ok: false, error: 'not_in_room' });

        const room = context.room;
        rooms.leave(room, context.player.token);
        socket.leave(room.code);
        socket.data.roomCode = null;
        socket.data.token = null;
        respond(ack, { ok: true });
        broadcast(room);
        log('Sala abandonada:', room.code);
      } catch (error) {
        console.error('Error en room:leave:', error);
        respond(ack, { ok: false, error: 'server_error' });
      }
    });

    socket.on('room:sync', (payload, ack) => {
      try {
        const context = current(socket);
        if (!context) return respond(ack, { ok: false, error: 'not_in_room' });
        respond(ack, {
          ok: true,
          code: context.room.code,
          color: context.color,
          room: rooms.publicRoom(context.room)
        });
      } catch (error) {
        console.error('Error en room:sync:', error);
        respond(ack, { ok: false, error: 'server_error' });
      }
    });

    socket.on('disconnect', (reason) => {
      log('Desconectado:', socket.id, reason);
      const room = rooms.getRoom(socket.data.roomCode);
      if (!room) return;
      const found = rooms.disconnect(room, socket.data.token, socket.id);
      if (found) broadcast(room);
    });
  });

  const cleanupTimer = setInterval(() => {
    for (const room of rooms.forfeitDisconnected()) broadcast(room);
    rooms.cleanup();
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();

  function close() {
    clearInterval(cleanupTimer);
    return new Promise((resolve) => {
      io.close(() => resolve());
    });
  }

  return { app, server, io, rooms, close };
}

if (require.main === module) {
  const instance = createServer();
  const port = Number(process.env.PORT) || 3000;

  instance.server.listen(port, () => {
    console.log(`Ajedrez online escuchando en http://localhost:${port}`);
  });

  const shutdown = () => {
    instance.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, engine };
