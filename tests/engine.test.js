'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../shared/engine');

function emptyBoard() {
  return Array.from({ length: 8 }, () => Array(8).fill(' '));
}

function position(pieces, turn = 'white') {
  const state = engine.newState();
  state.board = emptyBoard();
  for (const [row, col, piece] of pieces) state.board[row][col] = piece;
  state.turn = turn;
  state.kingMoved = { white: true, black: true };
  state.rookMoved = {
    white: { kingside: true, queenside: true },
    black: { kingside: true, queenside: true }
  };
  return state;
}

function play(state, from, to, promotion) {
  return engine.validateAndApply(state, from, to, promotion);
}

test('estado inicial correcto', () => {
  const state = engine.newState();
  assert.equal(state.board.length, 8);
  assert.equal(state.board.flat().filter(p => p !== ' ').length, 32);
  assert.equal(state.turn, 'white');
  assert.equal(engine.isInCheck(state.board, 'white'), false);
  assert.deepEqual(state.captured, { white: [], black: [] });
});

test('e2-e4 legal y actualiza al paso', () => {
  const state = engine.newState();
  const result = play(state, [6, 4], [4, 4]);
  assert.equal(result.ok, true);
  assert.equal(result.move.notation, 'e2-e4');
  assert.equal(result.state.turn, 'black');
  assert.deepEqual(result.state.epTarget, {
    row: 5, col: 4, pawnRow: 4, pawnCol: 4
  });
  // No muta el estado original
  assert.equal(state.board[6][4], '♙');
  assert.equal(state.board[4][4], ' ');
  assert.equal(state.turn, 'white');
});

test('movimiento ilegal y fuera de turno se rechazan', () => {
  const state = engine.newState();
  assert.equal(play(state, [6, 4], [3, 4]).error, 'illegal_move');
  assert.equal(play(state, [1, 4], [3, 4]).error, 'not_your_turn');
  assert.equal(play(state, [4, 4], [3, 4]).error, 'no_piece');
  assert.equal(play(state, [6, 4], [4, 4]).ok, true);

  const after = play(state, [6, 4], [4, 4]).state;
  assert.equal(play(after, [7, 0], [5, 0]).error, 'not_your_turn');
});

test('mate del loco: jaque mate para negras', () => {
  let state = engine.newState();
  state = play(state, [6, 5], [5, 5]).state; // f3
  state = play(state, [1, 4], [3, 4]).state; // e5
  state = play(state, [6, 6], [4, 6]).state; // g4

  const result = play(state, [0, 3], [4, 7]); // Dh4#
  assert.equal(result.ok, true);
  assert.equal(result.move.notation, 'Dd8-h4#');
  assert.equal(result.status.over, true);
  assert.equal(result.status.reason, 'checkmate');
  assert.equal(result.status.winner, 'black');
});

test('ahogado: tablas sin jugadas legales', () => {
  const state = position([
    [0, 7, '♚'], // rey negro h8
    [1, 5, '♔'], // rey blanco f7
    [2, 6, '♕']  // dama blanca g6
  ], 'black');

  assert.equal(engine.isInCheck(state.board, 'black'), false);
  assert.equal(engine.hasAnyLegalMove(state.board, state, 'black'), false);
  const status = engine.getStatus(state);
  assert.equal(status.over, true);
  assert.equal(status.reason, 'stalemate');
  assert.equal(status.winner, null);
});

test('enroque corto mueve rey y torre', () => {
  const state = position([
    [7, 4, '♔'], [7, 7, '♖'], [0, 0, '♚']
  ], 'white');
  state.kingMoved = { white: false, black: true };
  state.rookMoved = {
    white: { kingside: false, queenside: true },
    black: { kingside: true, queenside: true }
  };

  const result = play(state, [7, 4], [7, 6]);
  assert.equal(result.ok, true);
  assert.equal(result.move.notation, 'O-O');
  assert.equal(result.state.board[7][6], '♔');
  assert.equal(result.state.board[7][5], '♖');
  assert.equal(result.state.board[7][7], ' ');
});

test('no se puede enrocar a través de una casilla atacada', () => {
  const state = position([
    [7, 4, '♔'], [7, 7, '♖'], [0, 5, '♜'], [0, 0, '♚']
  ], 'white');
  state.kingMoved = { white: false, black: true };
  state.rookMoved = {
    white: { kingside: false, queenside: true },
    black: { kingside: true, queenside: true }
  };

  assert.equal(play(state, [7, 4], [7, 6]).error, 'illegal_move');
});

test('captura al paso', () => {
  let state = position([
    [7, 4, '♔'], [0, 4, '♚'],
    [3, 4, '♙'], [1, 3, '♟']
  ], 'black');

  state = play(state, [1, 3], [3, 3]).state; // d7-d5
  const result = play(state, [3, 4], [2, 3]); // exd6
  assert.equal(result.ok, true);
  assert.equal(result.move.special, 'enpassant');
  assert.equal(result.state.board[3][3], ' ');
  assert.equal(result.state.board[2][3], '♙');
  assert.deepEqual(result.state.captured.white, ['pawn']);
});

test('promoción con captura y notación', () => {
  const state = position([
    [7, 4, '♔'], [0, 4, '♚'],
    [1, 1, '♙'], [0, 0, '♜']
  ], 'white');

  const result = play(state, [1, 1], [0, 0], 'knight');
  assert.equal(result.ok, true);
  assert.equal(result.move.special, 'promotion');
  assert.equal(result.move.promotion, 'knight');
  assert.equal(result.state.board[0][0], '♘');
  assert.deepEqual(result.state.captured.white, ['rook']);
  assert.equal(result.move.notation, 'b7xa8=C');
});

test('promoción por defecto a dama', () => {
  const state = position([
    [7, 4, '♔'], [0, 4, '♚'], [1, 0, '♙']
  ], 'white');
  const result = play(state, [1, 0], [0, 0]);
  assert.equal(result.ok, true);
  assert.equal(result.move.promotion, 'queen');
  assert.equal(result.state.board[0][0], '♕');
});

test('tablas por material insuficiente', () => {
  const state = position([
    [7, 4, '♔'], [0, 4, '♚'], [2, 2, '♗']
  ], 'white');
  const status = engine.getStatus(state);
  assert.equal(status.over, true);
  assert.equal(status.reason, 'insufficient');
});

test('tablas por regla de 50 jugadas', () => {
  const state = position([
    [7, 4, '♔'], [0, 4, '♚'], [7, 0, '♖']
  ], 'white');
  state.halfmove = 100;
  const status = engine.getStatus(state);
  assert.equal(status.over, true);
  assert.equal(status.reason, 'fifty-move');
});

test('resumen de capturas y ventaja material', () => {
  assert.deepEqual(
    engine.capturedSummary(['pawn', 'pawn', 'knight']),
    [
      { type: 'pawn', count: 2, name: 'peones' },
      { type: 'knight', count: 1, name: 'caballos' }
    ]
  );
  assert.equal(
    engine.materialAdvantage({ white: ['pawn', 'rook'], black: ['knight'] }),
    3
  );
});

test('validateAndApply rechaza payloads malformados', () => {
  const state = engine.newState();
  assert.equal(play(state, 'e2', 'e4').error, 'invalid_payload');
  assert.equal(play(state, [6, 4], [8, 4]).error, 'invalid_payload');
  assert.equal(play(state, [6, 4], [6, 4]).error, 'invalid_move');
  assert.equal(engine.validState(null), false);
});
