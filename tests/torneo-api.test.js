'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { createServer } = require('../server/server');

let instance;
let port;
let base;
const sockets = [];

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

function waitForUpdate(socket, predicate, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room:update', handler);
      reject(new Error('No llegó la actualización esperada'));
    }, timeoutMs);

    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off('room:update', handler);
      resolve(payload);
    }

    socket.on('room:update', handler);
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test.before(async () => {
  instance = createServer({ quiet: true });
  await new Promise((resolve) => instance.server.listen(0, resolve));
  port = instance.server.address().port;
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  for (const socket of sockets) socket.close();
  await instance.close();
});

test('estado inicial del torneo', async () => {
  const response = await fetch(`${base}/api/torneo`);
  assert.equal(response.status, 200);
  const state = await response.json();

  assert.equal(state.ok, true);
  assert.deepEqual(state.players, ['Abuelo', 'Manuel', 'Fernan', 'Alejandro']);
  assert.equal(state.schedule.filter(game => !game.bye).length, 12);
  assert.equal(state.standings.length, 4);
  assert.equal(state.storage.kind, 'memory');
  assert.equal(state.editable, false, 'sin clave configurada no se puede editar');
});

test('la página del torneo se sirve y enlaza la hoja de estilos', async () => {
  const response = await fetch(`${base}/torneo`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Torneo familiar/);
  assert.match(html, /\/torneo\.css/);
});

test('sin clave de organizador no se aceptan cambios', async () => {
  const response = await fetch(`${base}/api/torneo/partida/` + encodeURIComponent('Manuel|Fernan'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ result: 'draw' })
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'clave_no_configurada');
});

test('sala vinculada al torneo con espectador y guardado automático', async () => {
  const white = await connect();
  const black = await connect();
  const spy = await connect();

  const created = await emit(white, 'room:create', {
    name: 'otro nombre',
    partida: 'Abuelo|Alejandro'
  });
  assert.equal(created.ok, true);
  assert.equal(created.room.pairingId, 'Abuelo|Alejandro');
  assert.equal(created.room.players.white.name, 'Abuelo', 'el nombre lo fija el calendario');

  const joined = await emit(black, 'room:join', {
    code: created.code,
    name: 'Alejandro'
  });
  assert.equal(joined.ok, true);
  assert.equal(joined.color, 'black');
  assert.equal(joined.room.players.black.name, 'Alejandro');

  const second = await emit(await connect(), 'room:create', {
    name: 'Abuelo',
    partida: 'Abuelo|Alejandro'
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'pairing_active');

  const watched = await emit(spy, 'room:watch', { code: created.code });
  assert.equal(watched.ok, true);
  assert.equal(watched.room.spectators, 1);

  await wait(60);

  const refused = await emit(spy, 'game:move', { from: [6, 4], to: [4, 4] });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'spectator');

  const moved = waitForUpdate(spy, payload => payload.history.length === 1);
  const move = await emit(white, 'game:move', { from: [6, 4], to: [4, 4] });
  assert.equal(move.ok, true);

  const update = await moved;
  assert.equal(update.history[0], 'e2-e4');
  assert.equal(update.timing.moves.length, 1);
  assert.ok(Number.isFinite(update.timing.serverNow));

  await emit(white, 'game:resign', {});
  await wait(150);

  const response = await fetch(`${base}/api/torneo`);
  const state = await response.json();
  const record = state.results['Abuelo|Alejandro'];
  assert.ok(record, 'el resultado se guarda solo');
  assert.equal(record.result, 'black', 'ganan negras por rendición de blancas');
  assert.equal(record.source, 'partida');
  assert.equal(state.standings.find(row => row.name === 'Alejandro').total, 1);

  const pgnResponse = await fetch(
    `${base}/api/torneo/partida/` + encodeURIComponent('Abuelo|Alejandro') + '/pgn'
  );
  assert.equal(pgnResponse.status, 200);
  assert.match(pgnResponse.headers.get('content-type'), /chess-pgn/);
  const pgn = await pgnResponse.text();
  assert.match(pgn, /\[White "Abuelo"\]/);
  assert.match(pgn, /\[Result "0-1"\]/);
  assert.match(pgn, /1\. e2-e4|1\. e4/);
});

test('emparejamiento inexistente y partida ya jugada', async () => {
  const socket = await connect();
  const unknown = await emit(socket, 'room:create', {
    name: 'Alguien',
    partida: 'Abuelo|Nadie'
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_pairing');

  const played = await emit(socket, 'room:create', {
    name: 'Abuelo',
    partida: 'Abuelo|Alejandro'
  });
  assert.equal(played.ok, false);
  assert.equal(played.error, 'pairing_played');
});

test('el organizador corrige y anula resultados con la clave', async () => {
  process.env.TORNEO_CLAVE = 'clave-de-prueba';
  const id = encodeURIComponent('Manuel|Fernan');

  try {
    const wrong = await fetch(`${base}/api/torneo/partida/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-torneo-clave': 'otra' },
      body: JSON.stringify({ result: 'draw' })
    });
    assert.equal(wrong.status, 403);

    const saved = await fetch(`${base}/api/torneo/partida/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-torneo-clave': 'clave-de-prueba' },
      body: JSON.stringify({ result: 'draw' })
    });
    assert.equal(saved.status, 200);
    const state = await saved.json();
    assert.equal(state.results['Manuel|Fernan'].result, 'draw');
    assert.equal(state.results['Manuel|Fernan'].source, 'manual');
    assert.equal(state.editable, true);

    const clear = await fetch(`${base}/api/torneo/partida/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-torneo-clave': 'clave-de-prueba' },
      body: JSON.stringify({ clear: true })
    });
    assert.equal(clear.status, 200);
    const cleared = await clear.json();
    assert.equal(cleared.results['Manuel|Fernan'], undefined);
  } finally {
    delete process.env.TORNEO_CLAVE;
  }
});

test('cambiar la plantilla y bloquear jugadores con resultados', async () => {
  process.env.TORNEO_CLAVE = 'clave-de-prueba';
  const headers = {
    'Content-Type': 'application/json',
    'x-torneo-clave': 'clave-de-prueba'
  };

  try {
    const added = await fetch(`${base}/api/torneo/jugadores`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ players: ['Abuelo', 'Manuel', 'Fernan', 'Alejandro', 'Ana'] })
    });
    assert.equal(added.status, 200);
    const state = await added.json();
    assert.equal(state.players.length, 5);
    assert.equal(state.schedule.filter(game => !game.bye).length, 10, 'ida sola con 5');
    assert.ok(state.schedule.some(game => game.bye), 'hay descansos');

    const blocked = await fetch(`${base}/api/torneo/jugadores`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ players: ['Manuel', 'Fernan', 'Alejandro'] })
    });
    assert.equal(blocked.status, 409);
    const body = await blocked.json();
    assert.equal(body.error, 'jugador_con_resultados');
    assert.equal(body.player, 'Abuelo');
  } finally {
    delete process.env.TORNEO_CLAVE;
  }
});
