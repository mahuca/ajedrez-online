'use strict';

/*
 * Lógica del torneo familiar: plantilla, calendario y clasificación.
 * Módulo puro (sin red ni base de datos) para poder probarlo aislado.
 *
 * Los resultados se guardan por pareja y colores («blancas|negras»), no por
 * número de ronda. Así se pueden añadir jugadores sin perder lo ya jugado.
 */

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 16;
const NAME_MAX = 20;
const BYE = 'descanso';
const RESULTS = ['white', 'black', 'draw'];

const DEFAULT_PLAYERS = [
  'Abuelo', 'Manuel', 'Fernan', 'Alejandro', 'Alvaro', 'Alberto'
];

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX);
}

function normalizePlayers(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: 'invalid_players' };
  const players = [];
  const seen = new Set();
  for (const item of raw) {
    const name = cleanName(item);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    players.push(name);
  }
  if (players.length < MIN_PLAYERS) return { ok: false, error: 'too_few_players' };
  if (players.length > MAX_PLAYERS) return { ok: false, error: 'too_many_players' };
  return { ok: true, players };
}

function pairId(white, black) {
  return white + '|' + black;
}

function normalizeResult(raw) {
  if (raw === 'white' || raw === '1-0') return 'white';
  if (raw === 'black' || raw === '0-1') return 'black';
  if (raw === 'draw' || raw === '1/2-1/2' || raw === '½-½') return 'draw';
  return null;
}

function resultLabel(result) {
  if (result === 'white') return '1-0';
  if (result === 'black') return '0-1';
  if (result === 'draw') return '½-½';
  return '*';
}

/*
 * Sistema circular: se fija el primer jugador y se rotan los demás.
 * Con número impar se añade un descanso por ronda.
 */
function circleRounds(players) {
  const list = players.slice();
  if (list.length % 2 === 1) list.push(BYE);
  const total = list.length;
  const rounds = [];

  for (let round = 0; round < total - 1; round += 1) {
    const games = [];
    for (let i = 0; i < total / 2; i += 1) {
      const a = list[i];
      const b = list[total - 1 - i];
      if (a === BYE || b === BYE) {
        games.push({ bye: a === BYE ? b : a });
        continue;
      }
      const white = (round + i) % 2 === 0 ? a : b;
      const black = white === a ? b : a;
      games.push({ white, black });
    }
    rounds.push(games);
    list.splice(1, 0, list.pop());
  }

  return rounds;
}

function mirrorRound(games) {
  return games.map(game => (
    game.bye ? { bye: game.bye } : { white: game.black, black: game.white }
  ));
}

function buildSchedule(players, options = {}) {
  // Torneo familiar: siempre ida y vuelta, así cada pareja juega dos partidas
  // (una con cada color). Con 6 jugadores son 10 rondas y 30 partidas.
  const doubleRound = options.doubleRound === undefined
    ? true
    : !!options.doubleRound;

  const firstLeg = circleRounds(players);
  const legs = doubleRound ? [firstLeg, firstLeg.map(mirrorRound)] : [firstLeg];
  const schedule = [];
  let roundNumber = 0;

  for (let leg = 0; leg < legs.length; leg += 1) {
    for (const games of legs[leg]) {
      roundNumber += 1;
      for (const game of games) {
        if (game.bye) {
          schedule.push({
            id: BYE + '|' + roundNumber + '|' + game.bye,
            round: roundNumber,
            leg: leg + 1,
            white: null,
            black: null,
            bye: game.bye
          });
          continue;
        }
        schedule.push({
          id: pairId(game.white, game.black),
          round: roundNumber,
          leg: leg + 1,
          white: game.white,
          black: game.black,
          bye: null
        });
      }
    }
  }

  return schedule;
}

function byesFor(schedule) {
  const counts = new Map();
  for (const game of schedule) {
    if (!game.bye) continue;
    counts.set(game.bye, (counts.get(game.bye) || 0) + 1);
  }
  return counts;
}

function headToHead(player, rivals, schedule, results) {
  let points = 0;
  for (const game of schedule) {
    if (game.bye) continue;
    if (game.white !== player && game.black !== player) continue;
    const opponent = game.white === player ? game.black : game.white;
    if (!rivals.has(opponent)) continue;
    const record = results[game.id];
    if (!record) continue;
    if (record.result === 'draw') {
      points += 0.5;
    } else if (record.result === 'white' && player === game.white) {
      points += 1;
    } else if (record.result === 'black' && player === game.black) {
      points += 1;
    }
  }
  return points;
}

function computeStandings(players, schedule, results) {
  const stats = new Map();
  for (const name of players) {
    stats.set(name, {
      name,
      played: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      points: 0,
      byes: 0,
      total: 0
    });
  }

  for (const [name, count] of byesFor(schedule)) {
    const entry = stats.get(name);
    if (entry) entry.byes = count;
  }

  for (const game of schedule) {
    if (game.bye) continue;
    const record = results[game.id];
    if (!record) continue;
    const white = stats.get(game.white);
    const black = stats.get(game.black);
    if (!white || !black) continue;

    white.played += 1;
    black.played += 1;

    if (record.result === 'white') {
      white.wins += 1;
      black.losses += 1;
      white.points += 1;
    } else if (record.result === 'black') {
      black.wins += 1;
      white.losses += 1;
      black.points += 1;
    } else if (record.result === 'draw') {
      white.draws += 1;
      black.draws += 1;
      white.points += 0.5;
      black.points += 0.5;
    }
  }

  const table = [...stats.values()];
  for (const entry of table) {
    entry.total = entry.points + entry.byes;
  }

  table.sort((a, b) => (
    b.total - a.total
    || b.wins - a.wins
    || a.name.localeCompare(b.name, 'es')
  ));

  // Desempate por resultado directo dentro de cada grupo de puntos.
  let index = 0;
  while (index < table.length) {
    let end = index + 1;
    while (end < table.length && table[end].total === table[index].total) end += 1;

    if (end - index > 1) {
      const group = table.slice(index, end);
      const names = new Set(group.map(entry => entry.name));
      for (const entry of group) {
        entry.headToHead = headToHead(entry.name, names, schedule, results);
      }
      group.sort((a, b) => (
        b.headToHead - a.headToHead
        || b.wins - a.wins
        || a.name.localeCompare(b.name, 'es')
      ));
      table.splice(index, end - index, ...group);
    } else {
      table[index].headToHead = 0;
    }

    index = end;
  }

  return table.map((entry, position) => ({ ...entry, rank: position + 1 }));
}

function squareOf(square) {
  if (!Array.isArray(square) || square.length !== 2) return null;
  const [row, col] = square;
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null;
  if (row < 0 || row > 7 || col < 0 || col > 7) return null;
  return 'abcdefgh'[col] + (8 - row);
}

function pgnDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '????.??.??';
  const pad = number => String(number).padStart(2, '0');
  return date.getUTCFullYear() + '.' + pad(date.getUTCMonth() + 1) + '.' + pad(date.getUTCDate());
}

function fallbackPgn(headers, info) {
  const lines = [
    '[Event "' + headers.Event + '"]',
    '[Site "' + headers.Site + '"]',
    '[Date "' + headers.Date + '"]',
    '[White "' + headers.White + '"]',
    '[Black "' + headers.Black + '"]',
    '[Result "' + headers.Result + '"]',
    ''
  ];
  const sans = Array.isArray(info.sans) ? info.sans : [];
  let text = '';
  for (let i = 0; i < sans.length; i += 2) {
    text += (i / 2 + 1) + '. ' + sans[i] + ' ';
    if (sans[i + 1]) text += sans[i + 1] + ' ';
  }
  text += headers.Result;
  lines.push(text.trim());
  return lines.join('\n') + '\n';
}

/*
 * Convierte la partida a PGN estándar. Si chess.js no está disponible o la
 * secuencia no se puede reproducir, devuelve un PGN básico con la notación
 * que ya usa la aplicación.
 */
function toPgn(info) {
  const result = resultLabel(info.result);
  const headers = {
    Event: info.event || 'Torneo familiar',
    Site: info.site || 'Ajedrez online',
    Date: info.date || pgnDate(),
    White: info.white || 'Blancas',
    Black: info.black || 'Negras',
    Result: result === '½-½' ? '1/2-1/2' : result
  };

  try {
    // Dependencia opcional: si falta, se usa el PGN básico.
    // eslint-disable-next-line global-require
    const { Chess } = require('chess.js');
    const game = new Chess();
    for (const [key, value] of Object.entries(headers)) game.setHeader(key, value);

    for (const move of info.moves || []) {
      const from = squareOf(move.from);
      const to = squareOf(move.to);
      if (!from || !to) throw new Error('movimiento inválido');
      game.move({ from, to, promotion: move.promotion || undefined });
    }

    return game.pgn({ maxWidth: 78, newline: '\n' }) + '\n';
  } catch (error) {
    return fallbackPgn(headers, info);
  }
}

module.exports = {
  MIN_PLAYERS,
  MAX_PLAYERS,
  NAME_MAX,
  BYE,
  RESULTS,
  DEFAULT_PLAYERS,
  cleanName,
  normalizePlayers,
  normalizeResult,
  resultLabel,
  pairId,
  buildSchedule,
  computeStandings,
  byesFor,
  toPgn,
  squareOf,
  pgnDate
};
