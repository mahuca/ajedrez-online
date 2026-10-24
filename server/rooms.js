'use strict';

const crypto = require('crypto');
const engine = require('../shared/engine');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_NAME_LENGTH = 20;

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;        // 2 horas sin actividad
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;      // 10 minutos sin jugadores
const DISCONNECT_FORFEIT_MS = 3 * 60 * 1000;   // 3 minutos desconectado en partida

function emptyStatus() {
  return { over: false, reason: null, winner: null, inCheck: false };
}

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return clean || fallback;
}

function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return new RegExp('^[' + CODE_ALPHABET + ']{' + CODE_LENGTH + '}$').test(code)
    ? code
    : null;
}

function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function randomToken() {
  return crypto.randomUUID();
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  get size() {
    return this.rooms.size;
  }

  getRoom(code) {
    const normalized = normalizeCode(code);
    return normalized ? this.rooms.get(normalized) || null : null;
  }

  findPlayer(room, token) {
    if (!room || typeof token !== 'string') return null;
    for (const color of ['white', 'black']) {
      const player = room.players[color];
      if (player && player.token === token) return { player, color };
    }
    return null;
  }

  colorOf(room, token) {
    const found = this.findPlayer(room, token);
    return found ? found.color : null;
  }

  createRoom(name) {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));

    const now = Date.now();
    const room = {
      code,
      players: { white: null, black: null },
      state: engine.newState(),
      status: emptyStatus(),
      history: [],
      rematchVotes: { white: false, black: false },
      createdAt: now,
      updatedAt: now,
      lastActivity: now
    };

    const player = {
      token: randomToken(),
      name: sanitizeName(name, 'Blancas'),
      socketId: null,
      connected: false,
      joinedAt: now,
      disconnectedAt: null
    };

    room.players.white = player;
    this.rooms.set(code, room);
    return { room, player, color: 'white' };
  }

  joinRoom(code, token, name) {
    const room = this.getRoom(code);
    if (!room) return { error: 'not_found' };

    // Reconexión con token
    if (typeof token === 'string' && token) {
      const found = this.findPlayer(room, token);
      if (found) {
        room.lastActivity = Date.now();
        if (typeof name === 'string' && name.trim()) {
          found.player.name = sanitizeName(name, found.player.name);
        }
        return { room, player: found.player, color: found.color, resumed: true };
      }
    }

    // Asignar asiento libre
    let color = null;
    if (!room.players.white) color = 'white';
    else if (!room.players.black) color = 'black';
    if (!color) return { error: 'full' };

    const now = Date.now();
    const player = {
      token: randomToken(),
      name: sanitizeName(name, color === 'white' ? 'Blancas' : 'Negras'),
      socketId: null,
      connected: false,
      joinedAt: now,
      disconnectedAt: null
    };
    room.players[color] = player;
    room.lastActivity = now;
    this.rooms.set(room.code, room);
    return { room, player, color, resumed: false };
  }

  attach(room, player, socketId) {
    player.socketId = socketId;
    player.connected = true;
    player.disconnectedAt = null;
    room.lastActivity = Date.now();
  }

  disconnect(room, token, socketId) {
    const found = this.findPlayer(room, token);
    if (!found) return null;
    // Si el jugador ya se reconectó con otro socket, no lo marcamos desconectado
    if (socketId && found.player.socketId && found.player.socketId !== socketId) {
      return null;
    }
    found.player.connected = false;
    found.player.disconnectedAt = Date.now();
    room.lastActivity = Date.now();
    return found;
  }

  leave(room, token) {
    const found = this.findPlayer(room, token);
    if (!found) return null;

    room.players[found.color] = null;
    room.rematchVotes[found.color] = false;
    room.lastActivity = Date.now();

    if (!room.status.over && room.players[found.color === 'white' ? 'black' : 'white']) {
      room.status = {
        over: true,
        reason: 'abandonment',
        winner: engine.other(found.color),
        inCheck: engine.isInCheck(room.state.board, room.state.turn)
      };
    }

    if (!room.players.white && !room.players.black) {
      this.rooms.delete(room.code);
    }

    return found;
  }

  applyMove(room, color, from, to, promotion) {
    if (!room) return { ok: false, error: 'not_found' };
    if (room.status.over) return { ok: false, error: 'game_over' };
    if (room.state.turn !== color) return { ok: false, error: 'not_your_turn' };

    const result = engine.validateAndApply(room.state, from, to, promotion);
    if (!result.ok) return result;

    room.state = result.state;
    room.status = result.status;
    room.history.push(result.move.notation);
    if (room.history.length > 400) room.history.shift();
    room.updatedAt = Date.now();
    room.lastActivity = Date.now();
    return result;
  }

  resign(room, color) {
    if (!room || room.status.over) return false;
    room.status = {
      over: true,
      reason: 'resignation',
      winner: engine.other(color),
      inCheck: engine.isInCheck(room.state.board, room.state.turn)
    };
    room.updatedAt = Date.now();
    room.lastActivity = Date.now();
    return true;
  }

  voteRematch(room, color) {
    if (!room || !room.status.over) return { ok: false, error: 'not_finished' };
    if (!room.players.white || !room.players.black) {
      return { ok: false, error: 'waiting_player' };
    }

    room.rematchVotes[color] = true;
    const both = room.rematchVotes.white && room.rematchVotes.black;
    if (!both) return { ok: true, started: false };

    // Intercambiar colores y empezar de cero
    const white = room.players.white;
    const black = room.players.black;
    room.players.white = black;
    room.players.black = white;
    room.state = engine.newState();
    room.status = emptyStatus();
    room.history = [];
    room.rematchVotes = { white: false, black: false };
    room.updatedAt = Date.now();
    room.lastActivity = Date.now();
    return { ok: true, started: true };
  }

  forfeitDisconnected(now = Date.now()) {
    const changed = [];
    for (const room of this.rooms.values()) {
      if (room.status.over) continue;
      const missing = [];
      for (const color of ['white', 'black']) {
        const player = room.players[color];
        if (player && !player.connected && player.disconnectedAt
            && now - player.disconnectedAt > DISCONNECT_FORFEIT_MS) {
          missing.push(color);
        }
      }
      if (missing.length === 0) continue;
      const winner = missing.length === 2
        ? null
        : engine.other(missing[0]);
      room.status = {
        over: true,
        reason: missing.length === 2 ? 'abandonment' : 'disconnect',
        winner,
        inCheck: engine.isInCheck(room.state.board, room.state.turn)
      };
      room.updatedAt = now;
      room.lastActivity = now;
      changed.push(room);
    }
    return changed;
  }

  cleanup(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const hasPlayers = !!(room.players.white || room.players.black);
      const anyConnected = ['white', 'black'].some(
        color => room.players[color] && room.players[color].connected
      );
      const ttl = !hasPlayers || !anyConnected ? EMPTY_ROOM_TTL_MS : ROOM_TTL_MS;
      if (now - room.lastActivity > ttl) this.rooms.delete(code);
    }
  }

  publicRoom(room) {
    const players = {};
    for (const color of ['white', 'black']) {
      const player = room.players[color];
      players[color] = player
        ? { name: player.name, connected: player.connected }
        : null;
    }
    return {
      code: room.code,
      state: room.state,
      status: room.status,
      history: room.history,
      players,
      rematchVotes: { ...room.rematchVotes }
    };
  }
}

module.exports = {
  RoomManager,
  normalizeCode,
  sanitizeName,
  emptyStatus,
  CODE_LENGTH,
  ROOM_TTL_MS,
  EMPTY_ROOM_TTL_MS,
  DISCONNECT_FORFEIT_MS
};
