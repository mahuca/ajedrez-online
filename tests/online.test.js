'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createServer } = require('../server/server');

let instance;
let port;
const sockets = [];
let roomCode;
let joinerToken;
let joiner2;

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    });
    sockets.push(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit(event, payload, (error, response) => {
      if (error) return resolve({ ok: false, error: 'timeout' });
      resolve(response);
    });
  });
}

function nextEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function nextUpdate(socket) {
  return nextEvent(socket, 'room:update');
}

test.before(async () => {
  instance = createServer({ quiet: true });
  await new Promise((resolve) => instance.server.listen(0, resolve));
  port = instance.server.address().port;
});

test.after(async () => {
  for (const socket of sockets) socket.close();
  await instance.close();
});

test('crear sala, unirse y sincronizar jugadas', async () => {
  const creator = await connect();
  const joiner = await connect();

  const creatorUpdate = nextUpdate(creator);
  const created = await emit(creator, 'room:create', { name: 'Ana' });
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(created.color, 'white');
  assert.equal(typeof created.token, 'string');
  const firstUpdate = await creatorUpdate;
  assert.equal(firstUpdate.code, created.code);
  assert.equal(firstUpdate.players.white.name, 'Ana');
  assert.equal(firstUpdate.players.black, null);

  const joinUpdate = nextUpdate(creator);
  const joined = await emit(joiner, 'room:join', {
    code: created.code.toLowerCase(),
    name: 'Luis'
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.color, 'black');
  assert.equal(joined.room.state.turn, 'white');

  const update = await joinUpdate;
  assert.equal(update.players.white.name, 'Ana');
  assert.equal(update.players.black.name, 'Luis');
  assert.equal(update.players.white.connected, true);
  assert.equal(update.players.black.connected, true);

  const opponentUpdate = nextUpdate(joiner);
  const move = await emit(creator, 'game:move', {
    from: [6, 4], to: [4, 4]
  });
  assert.equal(move.ok, true);
  assert.equal(move.move.notation, 'e2-e4');
  assert.equal(move.status.over, false);

  const afterMove = await opponentUpdate;
  assert.equal(afterMove.state.turn, 'black');
  assert.deepEqual(afterMove.history, ['e2-e4']);
  assert.deepEqual(afterMove.state.lastMove, { from: [6, 4], to: [4, 4] });

  // Turno equivocado
  const wrongTurn = await emit(joiner, 'game:move', {
    from: [7, 4], to: [6, 4]
  });
  assert.equal(wrongTurn.ok, false);
  assert.equal(wrongTurn.error, 'not_your_turn');

  // Jugada ilegal del bando que tiene el turno
  const illegal = await emit(joiner, 'game:move', {
    from: [1, 4], to: [4, 4]
  });
  assert.equal(illegal.ok, false);
  assert.equal(illegal.error, 'illegal_move');

  // Jugada válida de negras
  const blackUpdate = nextUpdate(creator);
  const blackMove = await emit(joiner, 'game:move', {
    from: [1, 4], to: [3, 4]
  });
  assert.equal(blackMove.ok, true);
  assert.equal(blackMove.move.notation, 'e7-e5');
  await blackUpdate;

  roomCode = created.code;
  joinerToken = joined.token;
});

test('reconexión con token y presencia', async () => {
  const creator = sockets[0];
  const joiner = sockets[1];

  const offlineUpdate = nextUpdate(creator);
  joiner.disconnect();
  const offline = await offlineUpdate;
  assert.equal(offline.players.black.connected, false);

  const reconnected = await connect();
  const onlineUpdate = nextUpdate(creator);
  const resumed = await emit(reconnected, 'room:join', {
    code: roomCode,
    token: joinerToken,
    name: 'Luis'
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.color, 'black');
  assert.equal(resumed.room.state.turn, 'white');

  const online = await onlineUpdate;
  assert.equal(online.players.black.connected, true);

  joiner2 = reconnected;
});

test('rendición, revancha con cambio de colores', async () => {
  const creator = sockets[0];
  const joiner = joiner2;

  const resignUpdate = nextUpdate(creator);
  const resigned = await emit(joiner, 'game:resign', {});
  assert.equal(resigned.ok, true);
  const afterResign = await resignUpdate;
  assert.equal(afterResign.status.over, true);
  assert.equal(afterResign.status.reason, 'resignation');
  assert.equal(afterResign.status.winner, 'white');

  // Primer voto: aún no empieza
  const firstVoteUpdate = nextUpdate(joiner);
  const firstVote = await emit(creator, 'game:rematch', {});
  assert.equal(firstVote.ok, true);
  assert.equal(firstVote.started, false);

  // El rival ve el voto
  const votesUpdate = await firstVoteUpdate;
  assert.equal(votesUpdate.rematchVotes.white, true);

  const creatorColor = nextEvent(creator, 'room:color');
  const joinerColor = nextEvent(joiner, 'room:color');
  const rematchUpdate = nextUpdate(creator);
  const secondVote = await emit(joiner, 'game:rematch', {});
  assert.equal(secondVote.ok, true);
  assert.equal(secondVote.started, true);

  assert.deepEqual(await creatorColor, { color: 'black' });
  assert.deepEqual(await joinerColor, { color: 'white' });

  const rematchState = await rematchUpdate;
  assert.equal(rematchState.status.over, false);
  assert.equal(rematchState.state.turn, 'white');
  assert.deepEqual(rematchState.history, []);
  assert.equal(rematchState.players.white.name, 'Luis');
  assert.equal(rematchState.players.black.name, 'Ana');

  // Ahora el que era negro juega con blancas
  const newMoveUpdate = nextUpdate(creator);
  const newMove = await emit(joiner, 'game:move', {
    from: [6, 4], to: [4, 4]
  });
  assert.equal(newMove.ok, true);
  await newMoveUpdate;

  // No se puede pedir revancha con la partida en curso
  const notFinished = await emit(joiner, 'game:rematch', {});
  assert.equal(notFinished.ok, false);
  assert.equal(notFinished.error, 'not_finished');

  // Salir de la partida en curso da la victoria al rival
  const leaveUpdate = nextUpdate(joiner);
  const left = await emit(creator, 'room:leave', {});
  assert.equal(left.ok, true);
  const afterLeave = await leaveUpdate;
  assert.equal(afterLeave.players.black, null);
  assert.equal(afterLeave.status.over, true);
  assert.equal(afterLeave.status.reason, 'abandonment');
  assert.equal(afterLeave.status.winner, 'white');
});

test('código inexistente, sala llena y payloads inválidos', async () => {
  const client = await connect();

  const missing = await emit(client, 'room:join', { code: 'ZZZZZZ' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'not_found');

  const invalid = await emit(client, 'room:join', { code: 'abc' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error, 'invalid_code');

  // Crear una sala y llenarla
  const a = await connect();
  const b = await connect();
  const c = await connect();
  const created = await emit(a, 'room:create', { name: 'A' });
  assert.equal(created.ok, true);
  const joined = await emit(b, 'room:join', { code: created.code, name: 'B' });
  assert.equal(joined.ok, true);

  const full = await emit(c, 'room:join', { code: created.code, name: 'C' });
  assert.equal(full.ok, false);
  assert.equal(full.error, 'full');

  // Payload de jugada inválido
  const badMove = await emit(a, 'game:move', { from: 'e2', to: 'e4' });
  assert.equal(badMove.ok, false);
  assert.equal(badMove.error, 'invalid_payload');

  // Sin sala no se puede mover
  const noRoom = await emit(c, 'game:move', { from: [6, 4], to: [4, 4] });
  assert.equal(noRoom.ok, false);
  assert.equal(noRoom.error, 'not_in_room');
});

test('HTTP: salud, portada y enlace de sala', async () => {
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(typeof healthBody.rooms, 'number');

  const home = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Ajedrez Online/);
  assert.match(html, /\/shared\/engine\.js/);

  const room = await fetch(`http://127.0.0.1:${port}/room/ABC234`);
  assert.equal(room.status, 200);
  assert.match(await room.text(), /id="board"/);

  const notFound = await fetch(`http://127.0.0.1:${port}/otra-cosa`);
  assert.equal(notFound.status, 404);

  const engineFile = await fetch(`http://127.0.0.1:${port}/shared/engine.js`);
  assert.equal(engineFile.status, 200);
  assert.match(await engineFile.text(), /validateAndApply/);
});

test('solo una sala de torneo a la vez y cierre por el organizador', async () => {
  const a = await connect();
  const b = await connect();

  // Primera partida del torneo: se crea sin problema.
  const created = await emit(a, 'room:create', {
    name: 'Abuelo',
    partida: 'Abuelo|Manuel'
  });
  assert.equal(created.ok, true);

  // Cualquier otro emparejamiento queda en espera mientras haya una en curso.
  const second = await emit(b, 'room:create', {
    name: 'Fernan',
    partida: 'Fernan|Manuel'
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'sala_ocupada');
  assert.equal(second.code, created.code);

  // Sin clave configurada no hay cierre administrativo.
  const noKey = await emit(b, 'room:close', { code: created.code });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.error, 'clave_no_configurada');

  process.env.TORNEO_CLAVE = 'clave-de-prueba';

  const wrong = await emit(b, 'room:close', {
    code: created.code,
    clave: 'otra-clave'
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'clave_incorrecta');

  // El organizador cierra: los de dentro reciben el aviso y la sala desaparece.
  const closedEvent = nextEvent(a, 'room:closed');
  const closed = await emit(b, 'room:close', {
    code: created.code,
    clave: 'clave-de-prueba'
  });
  assert.equal(closed.ok, true);
  assert.equal((await closedEvent).code, created.code);

  const gone = await emit(b, 'room:watch', { code: created.code });
  assert.equal(gone.error, 'not_found');

  // El emparejamiento vuelve a estar libre.
  const free = await emit(b, 'room:create', {
    name: 'Fernan',
    partida: 'Fernan|Manuel'
  });
  assert.equal(free.ok, true);

  // Cerrar una sala no guarda resultado en el torneo.
  const state = await (await fetch(`http://127.0.0.1:${port}/api/torneo`)).json();
  assert.deepEqual(state.results, {});

  await emit(b, 'room:close', { code: free.code, clave: 'clave-de-prueba' });
  delete process.env.TORNEO_CLAVE;
});
