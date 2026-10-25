'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const engine = require('../shared/engine');
const { RoomManager, normalizeCode } = require('./rooms');
const tournament = require('./tournament');
const { createStore } = require('./db');

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
  const store = createStore({ quiet });

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
  const tournamentFile = path.join(publicDir, 'torneo.html');
  const sendIndex = (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile);
  };

  // ==================== TORNEO ====================

  function envPlayers() {
    const raw = process.env.TORNEO_JUGADORES;
    if (!raw) return null;
    const list = raw.split(',').map(item => item.trim()).filter(Boolean);
    const normalized = tournament.normalizePlayers(list);
    return normalized.ok ? normalized.players : null;
  }

  async function getRoster() {
    try {
      const saved = await store.getRoster();
      if (saved && saved.length >= tournament.MIN_PLAYERS) return saved;
    } catch (error) {
      log('No se pudo leer la plantilla:', error.message);
    }
    return envPlayers() || tournament.DEFAULT_PLAYERS.slice();
  }

  async function getSchedule() {
    const players = await getRoster();
    return { players, schedule: tournament.buildSchedule(players) };
  }

  function liveRooms() {
    const live = {};
    for (const room of rooms.all()) {
      if (!room.pairingId) continue;
      live[room.pairingId] = {
        code: room.code,
        over: room.status.over,
        spectators: room.spectators.size
      };
    }
    return live;
  }

  async function buildState() {
    const { players, schedule } = await getSchedule();
    let results = {};
    try {
      results = await store.getResults();
    } catch (error) {
      log('No se pudieron leer los resultados:', error.message);
    }
    const standings = tournament.computeStandings(players, schedule, results);
    return {
      ok: true,
      players,
      schedule,
      results,
      standings,
      live: liveRooms(),
      storage: {
        kind: store.kind,
        requested: store.requested,
        fallbackReason: store.fallbackReason || null
      },
      editable: !!process.env.TORNEO_CLAVE,
      updatedAt: new Date().toISOString()
    };
  }

  function organizer(req) {
    const expected = process.env.TORNEO_CLAVE || '';
    if (!expected) return { ok: false, status: 503, error: 'clave_no_configurada' };
    const given = String(req.get('x-torneo-clave') || '');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, status: 403, error: 'clave_incorrecta' };
    }
    return { ok: true };
  }

  function saveFinishedGame(room) {
    if (!room || room.saved || !room.pairingId || !room.status.over) return;
    room.saved = true;

    const white = room.pairing ? room.pairing.white : '';
    const black = room.pairing ? room.pairing.black : '';
    const result = room.status.winner === 'white'
      ? 'white'
      : room.status.winner === 'black' ? 'black' : 'draw';

    let pgn = null;
    try {
      pgn = tournament.toPgn({
        white,
        black,
        result,
        moves: room.moves,
        sans: room.history,
        date: tournament.pgnDate()
      });
    } catch (error) {
      log('No se pudo generar el PGN:', error.message);
    }

    store.saveResult({
      pairingId: room.pairingId,
      white,
      black,
      result,
      moves: room.moves,
      times: room.timing.moves,
      sans: room.history,
      pgn,
      roomCode: room.code,
      source: 'partida'
    }).then(() => {
      log('Resultado guardado:', room.pairingId, result);
    }).catch((error) => {
      room.saveError = error.message;
      console.error('No se pudo guardar el resultado del torneo:', error.message);
    });
  }

  app.use('/api', express.json({ limit: '16kb' }));

  app.get('/health', async (req, res) => {
    res.json({
      ok: true,
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      storage: store.kind
    });
  });

  app.get('/api/torneo', async (req, res) => {
    try {
      res.json(await buildState());
    } catch (error) {
      console.error('Error en /api/torneo:', error);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  app.put('/api/torneo/jugadores', async (req, res) => {
    const check = organizer(req);
    if (!check.ok) return res.status(check.status).json({ ok: false, error: check.error });

    const normalized = tournament.normalizePlayers(req.body && req.body.players);
    if (!normalized.ok) {
      return res.status(400).json({ ok: false, error: normalized.error });
    }

    try {
      const current = await getRoster();
      const results = await store.getResults();
      const keep = new Set(normalized.players.map(name => name.toLowerCase()));
      const removed = current.filter(name => !keep.has(name.toLowerCase()));

      for (const name of removed) {
        const used = Object.values(results)
          .some(record => record.white === name || record.black === name);
        if (used) {
          return res.status(409).json({
            ok: false,
            error: 'jugador_con_resultados',
            player: name
          });
        }
      }

      await store.saveRoster(normalized.players);
      res.json(await buildState());
    } catch (error) {
      console.error('Error al guardar la plantilla:', error);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  app.put('/api/torneo/partida/:id', async (req, res) => {
    const check = organizer(req);
    if (!check.ok) return res.status(check.status).json({ ok: false, error: check.error });

    const id = String(req.params.id || '');
    try {
      const { schedule } = await getSchedule();
      const game = schedule.find(item => item.id === id && !item.bye);
      if (!game) return res.status(404).json({ ok: false, error: 'partida_desconocida' });

      if (req.body && req.body.clear) {
        await store.deleteResult(id);
        const room = rooms.all().find(item => item.pairingId === id);
        // Si la partida sigue en curso, permitimos que se guarde al terminar.
        if (room) room.saved = !!room.status.over;
        return res.json(await buildState());
      }

      const result = tournament.normalizeResult(req.body && req.body.result);
      if (!result) return res.status(400).json({ ok: false, error: 'resultado_invalido' });

      let pgn = null;
      try {
        pgn = tournament.toPgn({
          white: game.white,
          black: game.black,
          result,
          moves: [],
          sans: [],
          date: tournament.pgnDate()
        });
      } catch (error) {
        log('No se pudo generar el PGN manual:', error.message);
      }

      await store.saveResult({
        pairingId: id,
        white: game.white,
        black: game.black,
        result,
        moves: [],
        times: [],
        sans: [],
        pgn,
        source: 'manual'
      });

      const room = rooms.all().find(item => item.pairingId === id);
      if (room) room.saved = true;

      res.json(await buildState());
    } catch (error) {
      console.error('Error al guardar un resultado manual:', error);
      res.status(500).json({ ok: false, error: 'server_error' });
    }
  });

  app.get('/api/torneo/partida/:id/pgn', async (req, res) => {
    const id = String(req.params.id || '');
    try {
      const { schedule } = await getSchedule();
      const game = schedule.find(item => item.id === id && !item.bye);
      if (!game) return res.status(404).type('text/plain').send('Partida desconocida');

      const results = await store.getResults();
      const record = results[id];
      const text = record && record.pgn
        ? record.pgn
        : tournament.toPgn({
            white: game.white,
            black: game.black,
            result: record ? record.result : null,
            moves: [],
            sans: [],
            date: tournament.pgnDate()
          });

      const filename = (game.white + '-' + game.black)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'partida';

      res.setHeader('Content-Type', 'application/vnd.chess-pgn; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '.pgn"');
      res.setHeader('Cache-Control', 'no-store');
      res.send(text);
    } catch (error) {
      console.error('Error al descargar el PGN:', error);
      res.status(500).type('text/plain').send('No se pudo generar la partida');
    }
  });

  app.get('/', sendIndex);
  app.get('/torneo', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(tournamentFile);
  });
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
    saveFinishedGame(room);
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

    rooms.removeSpectator(room, socket.id);
    rooms.attach(room, player, socket.id);
    socket.data.roomCode = room.code;
    socket.data.token = player.token;
    socket.data.watching = null;
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

    socket.on('room:create', async (payload, ack) => {
      try {
        if (!allowJoin(socket)) {
          return respond(ack, { ok: false, error: 'rate_limited' });
        }

        const name = payload && payload.name;
        const pairingId = payload && typeof payload.partida === 'string'
          ? payload.partida
          : null;
        let pairing = null;

        if (pairingId) {
          const { schedule } = await getSchedule();
          const target = schedule.find(game => !game.bye && game.id === pairingId);
          if (!target) return respond(ack, { ok: false, error: 'unknown_pairing' });

          const results = await store.getResults();
          if (results[target.id]) {
            return respond(ack, { ok: false, error: 'pairing_played' });
          }

          const active = rooms.all()
            .find(room => room.pairingId === target.id && !room.status.over);
          if (active) {
            return respond(ack, {
              ok: false,
              error: 'pairing_active',
              code: active.code
            });
          }
          pairing = target;
        }

        const { room, player, color } = rooms.createRoom(name, { pairing });
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
        log('Sala creada:', room.code, room.pairingId || '');
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

    socket.on('room:watch', (payload, ack) => {
      try {
        if (!allowJoin(socket)) {
          return respond(ack, { ok: false, error: 'rate_limited' });
        }
        const code = normalizeCode(payload && payload.code);
        if (!code) return respond(ack, { ok: false, error: 'invalid_code' });

        const room = rooms.getRoom(code);
        if (!room) return respond(ack, { ok: false, error: 'not_found' });

        const added = rooms.addSpectator(room, socket.id);
        if (!added.ok) return respond(ack, added);

        socket.join(room.code);
        socket.data.watching = room.code;

        respond(ack, {
          ok: true,
          code: room.code,
          room: rooms.publicRoom(room)
        });
        broadcast(room);
        log('Espectador:', socket.id, '→', room.code);
      } catch (error) {
        console.error('Error en room:watch:', error);
        respond(ack, { ok: false, error: 'server_error' });
      }
    });

    socket.on('game:move', (payload, ack) => {
      try {
        const context = current(socket);
        if (!context) {
          if (socket.data.watching) return respond(ack, { ok: false, error: 'spectator' });
          return respond(ack, { ok: false, error: 'not_in_room' });
        }

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
        if (!context) {
          if (socket.data.watching) return respond(ack, { ok: false, error: 'spectator' });
          return respond(ack, { ok: false, error: 'not_in_room' });
        }
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
        if (!context) {
          if (socket.data.watching) return respond(ack, { ok: false, error: 'spectator' });
          return respond(ack, { ok: false, error: 'not_in_room' });
        }

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
        if (!context) {
          if (socket.data.watching) {
            const watched = rooms.getRoom(socket.data.watching);
            if (watched) {
              rooms.removeSpectator(watched, socket.id);
              socket.leave(watched.code);
              broadcast(watched);
            }
            socket.data.watching = null;
            return respond(ack, { ok: true });
          }
          return respond(ack, { ok: false, error: 'not_in_room' });
        }

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
        if (!context) {
          const watched = rooms.getRoom(socket.data.watching);
          if (watched) {
            return respond(ack, {
              ok: true,
              code: watched.code,
              color: null,
              spectator: true,
              room: rooms.publicRoom(watched)
            });
          }
          return respond(ack, { ok: false, error: 'not_in_room' });
        }
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
      for (const room of rooms.findSpectatorRooms(socket.id)) {
        rooms.removeSpectator(room, socket.id);
        broadcast(room);
      }
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
      io.close(() => {
        store.close().catch(() => {}).then(() => resolve());
      });
    });
  }

  return { app, server, io, rooms, store, close };
}

if (require.main === module) {
  const instance = createServer();
  const port = Number(process.env.PORT) || 3000;

  instance.server.listen(port, () => {
    console.log(`Ajedrez online escuchando en http://localhost:${port}`);
    console.log(`Torneo: http://localhost:${port}/torneo`);
  });

  const shutdown = () => {
    instance.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createServer, engine };
