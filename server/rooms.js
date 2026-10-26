'use strict';

const crypto = require('crypto');
const engine = require('../shared/engine');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const MAX_NAME_LENGTH = 20;

const ROOM_TTL_MS = 2 * 60 * 60 * 1000;        // 2 horas sin actividad
const EMPTY_ROOM_TTL_MS = 3 * 60 * 1000;       // 3 minutos: sala recién abierta y vacía
const RECONNECT_TTL_MS = 10 * 60 * 1000;       // 10 minutos: partida empezada sin nadie dentro
const DISCONNECT_FORFEIT_MS = 3 * 60 * 1000;   // 3 minutos desconectado en partida
const TOURNAMENT_FORFEIT_MS = 20 * 60 * 1000;  // 20 minutos en salas del torneo
const MAX_SPECTATORS = 50;
const HISTORY_LIMIT = 400;

function emptyStatus() {
  return { over: false, reason: null, winner: null, inCheck: false };
}

/*
 * Cronómetro de reflexión: cuenta hacia arriba y no limita la partida.
 * Guarda el tiempo acumulado de cada color y el de cada jugada.
 */
function emptyTiming() {
  return { white: 0, black: 0, moves: [], partial: 0, runningSince: null };
}

function bothConnected(room) {
  return !!(room.players.white && room.players.black
    && room.players.white.connected && room.players.black.connected);
}

function startTiming(room, now = Date.now()) {
  if (!room || room.status.over) return false;
  if (room.timing.runningSince !== null) return false;
  if (!bothConnected(room)) return false;
  room.timing.runningSince = now;
  return true;
}

function pauseTiming(room, now = Date.now()) {
  const timing = room.timing;
  if (!timing || timing.runningSince === null) return false;
  const elapsed = Math.max(0, now - timing.runningSince);
  const turn = room.state.turn;
  timing[turn] += elapsed;
  timing.partial += elapsed;
  timing.runningSince = null;
  return true;
}

function stopTiming(room) {
  if (room && room.timing) room.timing.runningSince = null;
}

function recordMove(room, color, now = Date.now()) {
  const timing = room.timing;
  const elapsed = timing.runningSince === null
    ? 0
    : Math.max(0, now - timing.runningSince);
  timing[color] += elapsed;
  timing.partial += elapsed;
  timing.moves.push(timing.partial);
  if (timing.moves.length > HISTORY_LIMIT) timing.moves.shift();
  timing.partial = 0;
  timing.runningSince = null;
  if (!room.status.over && bothConnected(room)) timing.runningSince = now;
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

  all() {
    return [...this.rooms.values()];
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

  createRoom(name, options = {}) {
    let code;
    do {
      code = randomCode();
    } while (this.rooms.has(code));

    const pairing = options.pairing || null;
    const now = Date.now();
    const room = {
      code,
      players: { white: null, black: null },
      state: engine.newState(),
      status: emptyStatus(),
      history: [],
      moves: [],
      timing: emptyTiming(),
      spectators: new Set(),
      pairingId: pairing ? pairing.id : null,
      pairing: pairing ? { white: pairing.white, black: pairing.black } : null,
      saved: false,
      savedIds: new Set(),
      saveError: null,
      rematchVotes: { white: false, black: false },
      createdAt: now,
      updatedAt: now,
      lastActivity: now
    };

    const player = {
      token: randomToken(),
      name: sanitizeName(pairing ? pairing.white : name, 'Blancas'),
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
    const fallback = color === 'white' ? 'Blancas' : 'Negras';
    const forced = room.pairing ? room.pairing[color] : null;
    const player = {
      token: randomToken(),
      name: forced ? sanitizeName(forced, fallback) : sanitizeName(name, fallback),
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

  attach(room, player, socketId, now = Date.now()) {
    player.socketId = socketId;
    player.connected = true;
    player.disconnectedAt = null;
    room.lastActivity = now;
    startTiming(room, now);
  }

  disconnect(room, token, socketId, now = Date.now()) {
    const found = this.findPlayer(room, token);
    if (!found) return null;
    // Si el jugador ya se reconectó con otro socket, no lo marcamos desconectado
    if (socketId && found.player.socketId && found.player.socketId !== socketId) {
      return null;
    }
    found.player.connected = false;
    found.player.disconnectedAt = now;
    room.lastActivity = now;
    // El cronómetro de reflexión se pausa mientras falte alguien.
    pauseTiming(room, now);
    return found;
  }

  leave(room, token) {
    const found = this.findPlayer(room, token);
    if (!found) return null;

    room.players[found.color] = null;
    room.rematchVotes[found.color] = false;
    room.lastActivity = Date.now();
    stopTiming(room);

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

  applyMove(room, color, from, to, promotion, now = Date.now()) {
    if (!room) return { ok: false, error: 'not_found' };
    if (room.status.over) return { ok: false, error: 'game_over' };
    if (room.state.turn !== color) return { ok: false, error: 'not_your_turn' };

    const result = engine.validateAndApply(room.state, from, to, promotion);
    if (!result.ok) return result;

    recordMove(room, color, now);
    room.state = result.state;
    room.status = result.status;
    room.history.push(result.move.notation);
    if (room.history.length > HISTORY_LIMIT) room.history.shift();
    room.moves.push({
      from: result.move.from,
      to: result.move.to,
      promotion: result.move.promotion
    });
    if (room.moves.length > HISTORY_LIMIT) room.moves.shift();
    if (room.status.over) stopTiming(room);
    room.updatedAt = now;
    room.lastActivity = now;
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
    stopTiming(room);
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

    // Intercambiar colores y empezar de cero. La revancha es la vuelta del
    // torneo: se invierte también el emparejamiento para guardar el segundo
    // resultado en su propia casilla (B|A) sin pisar la ida (A|B).
    const white = room.players.white;
    const black = room.players.black;
    room.players.white = black;
    room.players.black = white;
    if (room.pairing) {
      room.pairing = { white: room.pairing.black, black: room.pairing.white };
      room.pairingId = room.pairing.white + '|' + room.pairing.black;
    }
    room.saved = false;
    room.saveError = null;
    room.state = engine.newState();
    room.status = emptyStatus();
    room.history = [];
    room.moves = [];
    room.timing = emptyTiming();
    room.rematchVotes = { white: false, black: false };
    room.updatedAt = Date.now();
    room.lastActivity = Date.now();
    startTiming(room);
    return { ok: true, started: true };
  }

  forfeitDisconnected(now = Date.now()) {
    const changed = [];
    for (const room of this.rooms.values()) {
      if (room.status.over) continue;
      // Las partidas del torneo se juegan cuando cada uno puede: damos 20
      // minutos para una pausa. Las salas sueltas 1v1 siguen con 3 minutos.
      const grace = room.pairingId ? TOURNAMENT_FORFEIT_MS : DISCONNECT_FORFEIT_MS;
      const missing = [];
      for (const color of ['white', 'black']) {
        const player = room.players[color];
        if (player && !player.connected && player.disconnectedAt
            && now - player.disconnectedAt > grace) {
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
      stopTiming(room);
      room.updatedAt = now;
      room.lastActivity = now;
      changed.push(room);
    }
    return changed;
  }

  addSpectator(room, socketId) {
    if (!room) return { ok: false, error: 'not_found' };
    if (room.spectators.has(socketId)) return { ok: true };
    if (room.spectators.size >= MAX_SPECTATORS) {
      return { ok: false, error: 'spectators_full' };
    }
    room.spectators.add(socketId);
    room.lastActivity = Date.now();
    return { ok: true };
  }

  removeSpectator(room, socketId) {
    if (!room || !socketId) return false;
    return room.spectators.delete(socketId);
  }

  findSpectatorRooms(socketId) {
    const found = [];
    for (const room of this.rooms.values()) {
      if (room.spectators.has(socketId)) found.push(room);
    }
    return found;
  }

  // Cierre administrativo (organizador): la sala desaparece y libera el
  // emparejamiento sin guardar resultado.
  closeRoom(room) {
    if (!room) return false;
    room.status = { over: true, reason: 'closed', winner: null, inCheck: false };
    room.saved = true;
    stopTiming(room);
    this.rooms.delete(room.code);
    return true;
  }

  cleanup(now = Date.now()) {
    for (const [code, room] of this.rooms) {
      const hasPlayers = !!(room.players.white || room.players.black);
      const anyConnected = ['white', 'black'].some(
        color => room.players[color] && room.players[color].connected
      );
      // Una sala recién abierta y vacía (sin jugadas) se libera pronto para no
      // bloquear el emparejamiento; si la partida ya empezó se da margen para
      // que vuelvan a conectarse.
      let ttl = ROOM_TTL_MS;
      if (!hasPlayers || !anyConnected) {
        ttl = room.moves.length === 0 ? EMPTY_ROOM_TTL_MS : RECONNECT_TTL_MS;
      }
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
      pairingId: room.pairingId,
      pairing: room.pairing,
      spectators: room.spectators.size,
      timing: {
        white: room.timing.white,
        black: room.timing.black,
        moves: room.timing.moves,
        partial: room.timing.partial,
        runningSince: room.timing.runningSince,
        serverNow: Date.now()
      },
      rematchVotes: { ...room.rematchVotes }
    };
  }
}

module.exports = {
  RoomManager,
  normalizeCode,
  sanitizeName,
  emptyStatus,
  emptyTiming,
  startTiming,
  pauseTiming,
  stopTiming,
  recordMove,
  CODE_LENGTH,
  MAX_SPECTATORS,
  ROOM_TTL_MS,
  EMPTY_ROOM_TTL_MS,
  RECONNECT_TTL_MS,
  DISCONNECT_FORFEIT_MS
};
