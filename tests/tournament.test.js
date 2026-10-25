'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tournament = require('../server/tournament');

const FOUR = ['Abuelo', 'Manuel', 'Fernan', 'Alejandro'];
const FIVE = FOUR.concat('Ana');

test('calendario de ida y vuelta para cuatro jugadores', () => {
  const schedule = tournament.buildSchedule(FOUR);
  const games = schedule.filter(game => !game.bye);

  assert.equal(games.length, 12, '12 partidas en total');
  assert.equal(new Set(schedule.map(game => game.round)).size, 6, '6 rondas');

  for (const game of games) {
    const mirror = games.find(other => (
      other.white === game.black && other.black === game.white
    ));
    assert.ok(mirror, 'cada pareja juega con los dos colores');
  }

  const colors = { white: {}, black: {} };
  for (const game of games) {
    colors.white[game.white] = (colors.white[game.white] || 0) + 1;
    colors.black[game.black] = (colors.black[game.black] || 0) + 1;
  }
  for (const name of FOUR) {
    assert.equal(colors.white[name], 3, name + ' juega 3 con blancas');
    assert.equal(colors.black[name], 3, name + ' juega 3 con negras');
  }
});

test('calendario con número impar: ida sola y un descanso por jugador', () => {
  const schedule = tournament.buildSchedule(FIVE, { doubleRound: false });
  const games = schedule.filter(game => !game.bye);
  const byes = schedule.filter(game => game.bye);

  assert.equal(games.length, 10, '5 jugadores → 10 partidas');
  assert.equal(new Set(schedule.map(game => game.round)).size, 5, '5 rondas');
  assert.equal(byes.length, 5, 'un descanso por jugador');

  const perPlayer = {};
  for (const game of byes) {
    perPlayer[game.bye] = (perPlayer[game.bye] || 0) + 1;
  }
  for (const name of FIVE) assert.equal(perPlayer[name], 1, name + ' descansa una vez');
});

test('calendario para seis jugadores sin descansos', () => {
  const players = FOUR.concat(['Ana', 'Luis']);
  const schedule = tournament.buildSchedule(players, { doubleRound: false });

  assert.equal(schedule.filter(game => !game.bye).length, 15);
  assert.equal(schedule.filter(game => game.bye).length, 0);
  assert.equal(new Set(schedule.map(game => game.round)).size, 5);
});

test('los identificadores de partida son estables y únicos', () => {
  const schedule = tournament.buildSchedule(FOUR);
  const ids = schedule.filter(game => !game.bye).map(game => game.id);
  assert.equal(new Set(ids).size, ids.length, 'sin identificadores repetidos');
  assert.ok(ids.includes('Abuelo|Alejandro'));
  assert.ok(ids.includes('Alejandro|Abuelo'));
});

test('clasificación: victoria, tablas y derrota', () => {
  const schedule = tournament.buildSchedule(FOUR);
  const results = {
    'Abuelo|Alejandro': { result: 'white' },
    'Manuel|Fernan': { result: 'draw' }
  };

  const table = tournament.computeStandings(FOUR, schedule, results);
  const byName = Object.fromEntries(table.map(row => [row.name, row]));

  assert.equal(byName.Abuelo.total, 1);
  assert.equal(byName.Abuelo.wins, 1);
  assert.equal(byName.Manuel.total, 0.5);
  assert.equal(byName.Manuel.draws, 1);
  assert.equal(byName.Fernan.total, 0.5);
  assert.equal(byName.Alejandro.total, 0);
  assert.equal(byName.Alejandro.losses, 1);
  assert.equal(table[0].name, 'Abuelo');
});

test('desempate por resultado directo entre jugadores empatados', () => {
  const players = ['Ana', 'Luis', 'Marta', 'Pablo'];
  const schedule = tournament.buildSchedule(players);
  const results = {};

  function game(a, b) {
    const found = schedule.find(item => !item.bye && (
      (item.white === a && item.black === b) || (item.white === b && item.black === a)
    ));
    assert.ok(found, 'existe la partida entre ' + a + ' y ' + b);
    return found;
  }

  function winFor(winner, loser) {
    const item = game(winner, loser);
    results[item.id] = { result: item.white === winner ? 'white' : 'black' };
  }

  winFor('Ana', 'Marta');
  winFor('Ana', 'Pablo');
  winFor('Luis', 'Ana');
  winFor('Luis', 'Marta');
  winFor('Pablo', 'Luis');
  results[game('Marta', 'Pablo').id] = { result: 'draw' };

  const table = tournament.computeStandings(players, schedule, results);
  const ana = table.find(row => row.name === 'Ana');
  const luis = table.find(row => row.name === 'Luis');

  assert.equal(ana.total, 2);
  assert.equal(luis.total, 2);
  assert.equal(ana.wins, 2);
  assert.equal(luis.wins, 2);
  assert.ok(luis.rank < ana.rank, 'Luis gana el desempate directo');
});

test('los descansos suman un punto', () => {
  const schedule = tournament.buildSchedule(FIVE, { doubleRound: false });
  const table = tournament.computeStandings(FIVE, schedule, {});

  assert.equal(table.length, 5);
  for (const row of table) {
    assert.equal(row.byes, 1);
    assert.equal(row.total, 1, 'un punto por descanso');
  }
});

test('normaliza la plantilla y rechaza listas inválidas', () => {
  const ok = tournament.normalizePlayers([' Ana ', 'ana', 'Luis', '', '  ']);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.players, ['Ana', 'Luis']);

  assert.equal(tournament.normalizePlayers(['solo uno']).error, 'too_few_players');
  assert.equal(tournament.normalizePlayers('nada').error, 'invalid_players');
});

test('las barras no pueden colarse en un nombre', () => {
  const cleaned = tournament.cleanName('Abuelo|Manuel');
  assert.equal(cleaned, 'Abuelo Manuel');
});

test('PGN con cabeceras, jugadas y resultado', () => {
  const pgn = tournament.toPgn({
    white: 'Abuelo',
    black: 'Alejandro',
    result: 'white',
    moves: [
      { from: [6, 4], to: [4, 4] },
      { from: [1, 4], to: [3, 4] },
      { from: [7, 6], to: [5, 5] }
    ],
    date: '2026.10.25'
  });

  assert.match(pgn, /\[White "Abuelo"\]/);
  assert.match(pgn, /\[Black "Alejandro"\]/);
  assert.match(pgn, /\[Result "1-0"\]/);
  assert.match(pgn, /1\. e4 e5 2\. Nf3/);
});

test('el PGN de tablas usa la notación correcta', () => {
  const pgn = tournament.toPgn({
    white: 'Ana',
    black: 'Luis',
    result: 'draw',
    moves: [],
    date: '2026.10.25'
  });
  assert.match(pgn, /\[Result "1\/2-1\/2"\]/);
});

test('resultados: normalización y etiquetas', () => {
  assert.equal(tournament.normalizeResult('1-0'), 'white');
  assert.equal(tournament.normalizeResult('0-1'), 'black');
  assert.equal(tournament.normalizeResult('½-½'), 'draw');
  assert.equal(tournament.normalizeResult('otra cosa'), null);
  assert.equal(tournament.resultLabel('draw'), '½-½');
});
