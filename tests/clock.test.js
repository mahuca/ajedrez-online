'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RoomManager,
  MAX_SPECTATORS
} = require('../server/rooms');

function twoPlayers(manager) {
  const { room, player } = manager.createRoom('Blancas');
  manager.attach(room, player, 'socket-white', 0);
  const joined = manager.joinRoom(room.code, undefined, 'Negras');
  manager.attach(room, joined.player, 'socket-black', 0);
  return { room, white: player, black: joined.player };
}

const E4 = [[6, 4], [4, 4]];
const E5 = [[1, 4], [3, 4]];

test('el cronómetro empieza cuando están los dos jugadores', () => {
  const manager = new RoomManager();
  const { room, player } = manager.createRoom('Blancas');
  manager.attach(room, player, 'socket-white', 1000);

  assert.equal(room.timing.runningSince, null, 'no corre con un solo jugador');

  const joined = manager.joinRoom(room.code, undefined, 'Negras');
  manager.attach(room, joined.player, 'socket-black', 2000);

  assert.equal(room.timing.runningSince, 2000, 'arranca al sentarse el rival');
});

test('acumula el tiempo de reflexión por jugador y por jugada', () => {
  const manager = new RoomManager();
  const { room } = twoPlayers(manager);

  manager.applyMove(room, 'white', E4[0], E4[1], null, 5000);
  assert.equal(room.timing.white, 5000);
  assert.equal(room.timing.black, 0);
  assert.deepEqual(room.timing.moves, [5000]);

  manager.applyMove(room, 'black', E5[0], E5[1], null, 8000);
  assert.equal(room.timing.black, 3000);
  assert.deepEqual(room.timing.moves, [5000, 3000]);
  assert.equal(room.timing.runningSince, 8000, 'sigue corriendo para blancas');
});

test('se pausa si el rival se desconecta y se reanuda al volver', () => {
  const manager = new RoomManager();
  const { room, black } = twoPlayers(manager);

  manager.applyMove(room, 'white', E4[0], E4[1], null, 5000);
  manager.applyMove(room, 'black', E5[0], E5[1], null, 8000);

  assert.equal(room.state.turn, 'white');

  manager.disconnect(room, black.token, 'socket-black', 10000);
  assert.equal(room.timing.white, 7000, 'suma los 2 s hasta la desconexión');
  assert.equal(room.timing.partial, 2000);
  assert.equal(room.timing.runningSince, null, 'queda en pausa');

  manager.attach(room, black, 'socket-black', 15000);
  assert.equal(room.timing.runningSince, 15000, 'se reanuda al reconectar');

  manager.applyMove(room, 'white', [7, 6], [5, 5], null, 17000);
  assert.equal(room.timing.white, 9000, '7000 + 2000 desde la reanudación');
  assert.deepEqual(room.timing.moves, [5000, 3000, 4000]);
});

test('deja de contar cuando la partida termina', () => {
  const manager = new RoomManager();
  const { room } = twoPlayers(manager);

  manager.applyMove(room, 'white', E4[0], E4[1], null, 3000);
  assert.ok(manager.resign(room, 'black'));
  assert.equal(room.status.over, true);
  assert.equal(room.timing.runningSince, null);
  assert.equal(room.status.winner, 'white');
});

test('el estado público incluye tiempos y un reloj del servidor', () => {
  const manager = new RoomManager();
  const { room } = twoPlayers(manager);
  manager.applyMove(room, 'white', E4[0], E4[1], null, 4200);

  const view = manager.publicRoom(room);
  assert.equal(view.timing.white, 4200);
  assert.equal(view.timing.black, 0);
  assert.deepEqual(view.timing.moves, [4200]);
  assert.ok(Number.isFinite(view.timing.serverNow));
  assert.equal(view.spectators, 0);
});

test('revancha: reinicia los tiempos', () => {
  const manager = new RoomManager();
  const { room } = twoPlayers(manager);

  manager.applyMove(room, 'white', E4[0], E4[1], null, 6000);
  manager.resign(room, 'black');
  const voteA = manager.voteRematch(room, 'white');
  assert.equal(voteA.started, false);
  const voteB = manager.voteRematch(room, 'black');
  assert.equal(voteB.started, true);

  assert.equal(room.timing.white, 0);
  assert.equal(room.timing.black, 0);
  assert.deepEqual(room.timing.moves, []);
  assert.ok(room.timing.runningSince, 'vuelve a correr');
});

test('los espectadores no ocupan asiento y tienen límite', () => {
  const manager = new RoomManager();
  const { room } = twoPlayers(manager);

  assert.equal(manager.addSpectator(room, 'spy-1').ok, true);
  assert.equal(manager.addSpectator(room, 'spy-1').ok, true, 'idempotente');
  assert.equal(room.spectators.size, 1);
  assert.notEqual(room.players.white, null);
  assert.notEqual(room.players.black, null);

  for (let i = 2; i <= MAX_SPECTATORS; i += 1) {
    assert.equal(manager.addSpectator(room, 'spy-' + i).ok, true);
  }

  const overflow = manager.addSpectator(room, 'spy-overflow');
  assert.equal(overflow.ok, false);
  assert.equal(overflow.error, 'spectators_full');

  assert.equal(manager.publicRoom(room).spectators, MAX_SPECTATORS);
  assert.equal(manager.removeSpectator(room, 'spy-1'), true);
  assert.equal(manager.publicRoom(room).spectators, MAX_SPECTATORS - 1);
  assert.equal(manager.findSpectatorRooms('spy-2').length, 1);
});

test('una sala de torneo fija los nombres del emparejamiento', () => {
  const manager = new RoomManager();
  const pairing = { id: 'Abuelo|Alejandro', white: 'Abuelo', black: 'Alejandro' };
  const { room, player } = manager.createRoom('otro nombre', { pairing });

  assert.equal(player.name, 'Abuelo');
  assert.equal(room.pairingId, 'Abuelo|Alejandro');
  assert.deepEqual(room.pairing, { white: 'Abuelo', black: 'Alejandro' });

  const joined = manager.joinRoom(room.code, undefined, 'otro más');
  assert.equal(joined.player.name, 'Alejandro');
  assert.equal(manager.publicRoom(room).pairing.white, 'Abuelo');
});

test('cerrar una sala libera el emparejamiento sin guardar resultado', () => {
  const manager = new RoomManager();
  const pairing = { id: 'Abuelo|Manuel', white: 'Abuelo', black: 'Manuel' };
  const { room } = manager.createRoom('Abuelo', { pairing });

  assert.equal(manager.getRoom(room.code), room);
  assert.equal(manager.closeRoom(room), true);
  assert.equal(manager.getRoom(room.code), null, 'la sala desaparece');
  assert.equal(room.status.over, true);
  assert.equal(room.status.reason, 'closed');
  assert.equal(room.saved, true, 'no se guardará como resultado');
});

test('una sala vacía se libera a los 3 minutos; una partida empezada aguanta 10', () => {
  const manager = new RoomManager();
  const vacia = manager.createRoom('Blancas').room;
  const empezada = twoPlayers(manager).room;
  manager.applyMove(empezada, 'white', E4[0], E4[1], null, 0);

  // Nadie conectado en ninguna de las dos.
  for (const room of [vacia, empezada]) {
    room.lastActivity = 0;
    for (const color of ['white', 'black']) {
      if (room.players[color]) room.players[color].connected = false;
    }
  }

  // La de 0 jugadas caduca a los 3 min; la empezada aguanta 10.
  manager.cleanup(3 * 60 * 1000 + 1);
  assert.equal(manager.getRoom(vacia.code), null);
  assert.equal(manager.getRoom(empezada.code), empezada);

  manager.cleanup(10 * 60 * 1000 + 1);
  assert.equal(manager.getRoom(empezada.code), null);
});

test('salir de la sala sin jugadas cancela la partida en vez de dar la victoria', () => {
  const manager = new RoomManager();
  const pairing = { id: 'Abuelo|Alberto', white: 'Abuelo', black: 'Alberto' };
  const { room, player } = manager.createRoom('Abuelo', { pairing });
  manager.attach(room, player, 'socket-white', 0);
  const joined = manager.joinRoom(room.code, undefined, 'Alberto');
  manager.attach(room, joined.player, 'socket-black', 0);

  // Abuelo se va de la sala sin que se haya movido ninguna pieza.
  manager.leave(room, player.token);

  assert.equal(room.status.over, true);
  assert.equal(room.status.reason, 'cancelled');
  assert.equal(room.status.winner, null, 'nadie gana por abandono sin jugadas');
  assert.equal(room.saved, true, 'no se guarda resultado');
});

test('una sala abandonada sin jugadas tampoco se guarda al vencer la espera', () => {
  const manager = new RoomManager();
  const pairing = { id: 'Abuelo|Alberto', white: 'Abuelo', black: 'Alberto' };
  const { room, player } = manager.createRoom('Abuelo', { pairing });
  manager.attach(room, player, 'socket-white', 0);
  manager.disconnect(room, player.token, 'socket-white', 1000);

  const changed = manager.forfeitDisconnected(30 * 60 * 1000);
  assert.equal(changed.length, 1);
  assert.equal(room.status.over, true);
  assert.equal(room.status.reason, 'cancelled');
  assert.equal(room.status.winner, null);
  assert.equal(room.saved, true, 'no se guarda resultado');
});
