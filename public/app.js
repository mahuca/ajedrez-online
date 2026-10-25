/*
 * Interfaz del ajedrez online.
 * El servidor es la autoridad; este cliente solo pinta el estado recibido.
 */
(function () {
  'use strict';

  const E = window.ChessEngine;
  const O = window.Online;
  if (!E || !O) {
    document.body.textContent = 'No se pudo cargar el motor de ajedrez.';
    return;
  }

  const PROMOTION_ORDER = ['queen', 'rook', 'bishop', 'knight'];
  const PROMOTION_NAMES = {
    queen: 'Dama', rook: 'Torre', bishop: 'Alfil', knight: 'Caballo'
  };

  const ERRORS = {
    invalid_code: 'El código debe tener 6 caracteres válidos.',
    not_found: 'No existe ninguna sala con ese código. Revisa el código.',
    full: 'La sala ya tiene dos jugadores.',
    rate_limited: 'Demasiados intentos. Espera un momento e inténtalo de nuevo.',
    timeout: 'El servidor tarda en responder. Inténtalo de nuevo.',
    offline: 'Sin conexión. Comprueba tu red e inténtalo de nuevo.',
    server_error: 'Error del servidor. Inténtalo de nuevo.',
    not_in_room: 'Ya no estás en esa sala.',
    game_over: 'La partida ya ha terminado.',
    not_your_turn: 'No es tu turno.',
    illegal_move: 'Esa jugada no es legal.',
    too_fast: 'Espera un instante antes de mover otra vez.',
    waiting_player: 'Tu rival ya no está en la sala.',
    not_finished: 'La partida todavía no ha terminado.',
    no_session: 'No hay ninguna partida guardada.'
  };

  const el = {
    lobbyScreen: document.getElementById('lobbyScreen'),
    gameScreen: document.getElementById('gameScreen'),
    playerName: document.getElementById('playerName'),
    codeInput: document.getElementById('codeInput'),
    createBtn: document.getElementById('createBtn'),
    joinForm: document.getElementById('joinForm'),
    joinBtn: document.getElementById('joinBtn'),
    lobbyError: document.getElementById('lobbyError'),
    resumeNotice: document.getElementById('resumeNotice'),
    roomCode: document.getElementById('roomCode'),
    copyBtn: document.getElementById('copyBtn'),
    connectionBadge: document.getElementById('connectionBadge'),
    connectionText: document.getElementById('connectionText'),
    flipBtn: document.getElementById('flipBtn'),
    leaveBtn: document.getElementById('leaveBtn'),
    board: document.getElementById('board'),
    topPlayer: document.getElementById('topPlayer'),
    topColor: document.getElementById('topColor'),
    topName: document.getElementById('topName'),
    topTag: document.getElementById('topTag'),
    topCaptured: document.getElementById('topCaptured'),
    topMaterial: document.getElementById('topMaterial'),
    bottomPlayer: document.getElementById('bottomPlayer'),
    bottomColor: document.getElementById('bottomColor'),
    bottomName: document.getElementById('bottomName'),
    bottomTag: document.getElementById('bottomTag'),
    bottomCaptured: document.getElementById('bottomCaptured'),
    bottomMaterial: document.getElementById('bottomMaterial'),
    waitingOverlay: document.getElementById('waitingOverlay'),
    waitingCode: document.getElementById('waitingCode'),
    waitingCopyBtn: document.getElementById('waitingCopyBtn'),
    tournamentLink: document.getElementById('tournamentLink'),
    spectatorNote: document.getElementById('spectatorNote'),
    topClock: document.getElementById('topClock'),
    bottomClock: document.getElementById('bottomClock'),
    timeSummary: document.getElementById('timeSummary'),
    promotionOverlay: document.getElementById('promotionOverlay'),
    promotionRow: document.getElementById('promotionRow'),
    cancelPromotionBtn: document.getElementById('cancelPromotionBtn'),
    resultOverlay: document.getElementById('resultOverlay'),
    resultKicker: document.getElementById('resultKicker'),
    resultTitle: document.getElementById('resultTitle'),
    resultText: document.getElementById('resultText'),
    rematchBtn: document.getElementById('rematchBtn'),
    resultLeaveBtn: document.getElementById('resultLeaveBtn'),
    rematchNote: document.getElementById('rematchNote'),
    statusText: document.getElementById('statusText'),
    moveList: document.getElementById('moveList'),
    toast: document.getElementById('toast')
  };

  const squares = [];
  let room = null;
  let myColor = null;
  let orientation = 'white';
  let selected = null;
  let legalMoves = [];
  let drag = null;
  let pendingPromotion = null;
  let movePending = false;
  let rematchPending = false;
  let busy = false;
  let toastTimer = null;
  let isSpectator = false;
  let clockSkew = 0;
  let clockTimer = null;

  // ==================== AYUDANTES ====================

  function other(color) {
    return color === 'white' ? 'black' : 'white';
  }

  function viewColor() {
    return myColor || orientation || 'white';
  }

  function formatMs(milliseconds) {
    const total = Math.max(0, Math.round((milliseconds || 0) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes >= 60) {
      return Math.floor(minutes / 60) + ':'
        + String(minutes % 60).padStart(2, '0') + ':'
        + String(seconds).padStart(2, '0');
    }
    return minutes + ':' + String(seconds).padStart(2, '0');
  }

  function clockMs(color) {
    if (!room || !room.timing) return 0;
    const timing = room.timing;
    let ms = timing[color] || 0;
    if (room.state.turn === color) {
      ms += timing.partial || 0;
      if (timing.runningSince !== null && timing.runningSince !== undefined) {
        ms += Math.max(0, Date.now() + clockSkew - timing.runningSince);
      }
    }
    return ms;
  }

  function colorLabel(color) {
    return color === 'white' ? 'Blancas' : 'Negras';
  }

  function playerName(color) {
    if (!room) return colorLabel(color);
    const player = room.players[color];
    return player ? player.name : colorLabel(color);
  }

  function errorText(code) {
    return ERRORS[code] || 'Ha ocurrido un error. Inténtalo de nuevo.';
  }

  function showToast(message, type = 'info') {
    el.toast.textContent = message;
    el.toast.className = 'toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.className = 'toast';
    }, 3400);
  }

  function showLobbyError(message) {
    el.lobbyError.textContent = message;
    el.lobbyError.hidden = !message;
  }

  function clearLobbyError() {
    el.lobbyError.textContent = '';
    el.lobbyError.hidden = true;
  }

  function showResumeNotice(text, onRetry) {
    el.resumeNotice.replaceChildren();
    const span = document.createElement('span');
    span.textContent = text;
    el.resumeNotice.appendChild(span);
    if (onRetry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = ' Reintentar';
      button.addEventListener('click', onRetry);
      el.resumeNotice.appendChild(button);
    }
    el.resumeNotice.hidden = false;
  }

  function clearResumeNotice() {
    el.resumeNotice.replaceChildren();
    el.resumeNotice.hidden = true;
  }

  function setBusy(value) {
    busy = value;
    el.createBtn.disabled = value;
    el.joinBtn.disabled = value;
    el.codeInput.disabled = value;
    const label = el.createBtn.querySelector('span');
    if (label) label.textContent = value ? 'Conectando…' : 'Crear sala';
  }

  function clearSelection() {
    selected = null;
    legalMoves = [];
  }

  function roomCodeFromUrl() {
    const match = window.location.pathname.match(/^\/room\/([A-Za-z0-9]{6})\/?$/);
    if (match) return match[1].toUpperCase();
    const query = new URLSearchParams(window.location.search).get('sala');
    if (query && /^[A-Za-z0-9]{6}$/.test(query)) return query.toUpperCase();
    return null;
  }

  function updateUrl(code) {
    try {
      window.history.replaceState(null, '', code ? '/room/' + code : '/');
    } catch (error) {
      // history no disponible: no pasa nada
    }
  }

  // ==================== PANTALLAS ====================

  function showLobby() {
    document.body.classList.remove('in-game');
    el.lobbyScreen.hidden = false;
    el.gameScreen.hidden = true;
  }

  function showGame() {
    document.body.classList.add('in-game');
    el.lobbyScreen.hidden = true;
    el.gameScreen.hidden = false;
  }

  function enterGame() {
    if (!room) return;
    if (!isSpectator && !myColor) myColor = O.getColor() || 'white';
    if (!orientation) orientation = myColor || 'white';
    document.body.classList.toggle('is-spectator', isSpectator);
    el.spectatorNote.hidden = !isSpectator;
    el.tournamentLink.hidden = !(room.pairingId || isSpectator);
    showGame();
    el.roomCode.textContent = room.code;
    el.waitingCode.textContent = room.code;
    if (!isSpectator) updateUrl(room.code);
    clearResumeNotice();
    clearLobbyError();
    clearSelection();
    pendingPromotion = null;
    movePending = false;
    el.promotionOverlay.hidden = true;
    applyClockSkew();
    render();
    startClockLoop();
  }

  // ==================== TABLERO ====================

  function buildBoard() {
    for (let index = 0; index < 64; index++) {
      const square = document.createElement('div');
      square.className = 'square';
      square.setAttribute('role', 'gridcell');
      el.board.appendChild(square);
      squares.push(square);
    }
  }

  function squareLabel(row, col, piece) {
    const name = E.FILES[col] + (8 - row);
    if (!piece || piece === ' ') return name + ', vacía';
    const type = E.typeOf(piece);
    const color = E.colorOf(piece) === 'white' ? 'blanca' : 'negra';
    return name + ', ' + E.PIECE_NAMES[type] + ' ' + color;
  }

  function renderBoard() {
    if (!room) return;
    const board = room.state.board;
    const flipped = orientation === 'black';
    const inCheck = E.isInCheck(board, room.state.turn);
    const king = inCheck ? E.findKing(board, room.state.turn) : null;

    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        const row = flipped ? 7 - dr : dr;
        const col = flipped ? 7 - dc : dc;
        const square = squares[dr * 8 + dc];

        square.dataset.row = String(row);
        square.dataset.col = String(col);
        square.className = 'square ' + ((row + col) % 2 === 0 ? 'light' : 'dark');
        square.replaceChildren();

        const piece = board[row][col];
        if (piece !== ' ') {
          const pieceEl = document.createElement('span');
          pieceEl.className = 'piece '
            + (E.colorOf(piece) === 'white' ? 'piece-white' : 'piece-black');
          pieceEl.textContent = E.BLACK_PIECES[E.typeOf(piece)];
          pieceEl.setAttribute('aria-hidden', 'true');
          square.appendChild(pieceEl);
        }

        if (room.state.lastMove) {
          const { from, to } = room.state.lastMove;
          if ((from[0] === row && from[1] === col)
              || (to[0] === row && to[1] === col)) {
            square.classList.add('last-move');
          }
        }

        if (selected && selected.row === row && selected.col === col) {
          square.classList.add('selected');
        }

        if (selected) {
          for (const move of legalMoves) {
            if (move.row !== row || move.col !== col) continue;
            if (move.special === 'castling') square.classList.add('castling-path');
            else if (move.special === 'enpassant') square.classList.add('en-passant-target');
            else if (move.capture) square.classList.add('valid-capture');
            else square.classList.add('valid-move');
          }
        }

        if (king && king.row === row && king.col === col) {
          square.classList.add('check');
        }

        if (drag && drag.active && drag.row === row && drag.col === col) {
          square.classList.add('dragging');
        }

        square.setAttribute('aria-label', squareLabel(row, col, piece));
      }
    }
  }

  function renderBar(position, color) {
    const player = room.players[color];
    const isTop = position === 'top';
    const colorEl = isTop ? el.topColor : el.bottomColor;
    const nameEl = isTop ? el.topName : el.bottomName;
    const tagEl = isTop ? el.topTag : el.bottomTag;
    const capturedEl = isTop ? el.topCaptured : el.bottomCaptured;
    const materialEl = isTop ? el.topMaterial : el.bottomMaterial;
    const bar = isTop ? el.topPlayer : el.bottomPlayer;

    colorEl.className = 'player-color ' + color;
    colorEl.textContent = E.BLACK_PIECES.king;

    bar.classList.toggle('waiting', !player);
    bar.classList.toggle('active',
      !room.status.over && !!player && room.state.turn === color);
    bar.classList.toggle('offline', !!player && !player.connected);

    if (!player) {
      nameEl.textContent = isTop ? 'Esperando rival…' : 'Tú';
      tagEl.textContent = isTop ? 'Rival' : 'Tú';
      capturedEl.replaceChildren();
      capturedEl.setAttribute('aria-label', 'Sin rival todavía');
      materialEl.textContent = '';
      return;
    }

    nameEl.textContent = player.name;
    tagEl.textContent = isSpectator
      ? colorLabel(color)
      : (isTop ? 'Rival' : 'Tú') + ' · ' + colorLabel(color);

    capturedEl.replaceChildren();
    const captured = room.state.captured[color] || [];
    const counts = {};
    for (const type of captured) counts[type] = (counts[type] || 0) + 1;

    if (!captured.length) {
      const empty = document.createElement('span');
      empty.className = 'captured-empty';
      empty.textContent = 'Sin capturas';
      capturedEl.appendChild(empty);
    } else {
      for (const type of E.CAPTURE_ORDER) {
        const count = counts[type] || 0;
        if (!count) continue;

        const group = document.createElement('span');
        group.className = 'captured-group';

        const glyph = document.createElement('span');
        // Quien captura muestra piezas del color contrario.
        glyph.className = 'captured-piece '
          + (other(color) === 'white' ? 'piece-white' : 'piece-black');
        glyph.textContent = E.BLACK_PIECES[type];
        group.appendChild(glyph);

        if (count > 1) {
          const times = document.createElement('span');
          times.className = 'captured-count';
          times.textContent = '×' + count;
          group.appendChild(times);
        }

        capturedEl.appendChild(group);
      }
    }

    const summary = E.capturedSummary(captured)
      .map(item => item.count + ' ' + item.name)
      .join(', ');
    capturedEl.setAttribute(
      'aria-label',
      'Capturas de ' + player.name + ': ' + (summary || 'ninguna')
    );

    const advantage = color === 'white'
      ? E.materialAdvantage(room.state.captured)
      : -E.materialAdvantage(room.state.captured);
    materialEl.textContent = advantage > 0 ? '+' + advantage : '';
  }

  function renderPlayers() {
    if (isSpectator) {
      renderBar('top', other(viewColor()));
      renderBar('bottom', viewColor());
      return;
    }
    if (!myColor) return;
    renderBar('top', other(myColor));
    renderBar('bottom', myColor);
  }

  function applyClockSkew() {
    if (room && room.timing && Number.isFinite(room.timing.serverNow)) {
      clockSkew = room.timing.serverNow - Date.now();
    }
  }

  function startClockLoop() {
    if (clockTimer) return;
    clockTimer = setInterval(() => {
      if (!room || el.gameScreen.hidden) return;
      renderClocks();
    }, 500);
  }

  function renderClocks() {
    if (!room || !room.timing) return;
    const rows = [
      { node: el.topClock, color: other(viewColor()) },
      { node: el.bottomClock, color: viewColor() }
    ];
    for (const row of rows) {
      const ms = clockMs(row.color);
      row.node.textContent = formatMs(ms);
      row.node.classList.toggle(
        'ticking',
        !room.status.over && room.state.turn === row.color
          && room.timing.runningSince !== null
      );
      row.node.classList.toggle('is-you', !isSpectator && row.color === myColor);
    }
  }

  function timeSummaryText() {
    if (!room || !room.timing) return '';
    const moves = room.timing.moves || [];
    if (!moves.length) return '';
    const parts = [];
    for (const color of ['white', 'black']) {
      const own = moves.filter((_, index) => (
        color === 'white' ? index % 2 === 0 : index % 2 === 1
      ));
      const total = own.reduce((sum, value) => sum + value, 0);
      const average = own.length ? total / own.length : 0;
      parts.push(playerName(color) + ' ' + formatMs(total)
        + (own.length ? ' (' + formatMs(average) + ' por jugada)' : ''));
    }
    return parts.join(' · ');
  }

  function renderStatus() {
    if (!room) return;

    if (isSpectator) {
      if (room.status.over) {
        el.statusText.textContent = spectatorResult(room.status).status;
        return;
      }
      const current = playerName(room.state.turn);
      const suffix = room.status.inCheck ? ' · ¡Jaque!' : '';
      const watching = room.spectators > 1
        ? ' · ' + (room.spectators - 1) + ' mirando'
        : '';
      el.statusText.textContent = 'Turno de ' + current + suffix + watching;
      return;
    }

    const opponent = other(myColor);
    const opponentName = playerName(opponent);

    if (room.status.over) {
      el.statusText.textContent = resultInfo(room.status, opponentName).status;
      return;
    }

    if (!O.isConnected()) {
      el.statusText.textContent = 'Sin conexión. Reconectando…';
      return;
    }

    if (!room.players[opponent]) {
      el.statusText.textContent = 'Esperando a que se una un rival…';
      return;
    }

    if (movePending) {
      el.statusText.textContent = 'Enviando jugada…';
      return;
    }

    const parts = [];
    const chip = document.createElement('span');
    chip.className = 'turn-chip ' + room.state.turn;
    chip.textContent = room.state.turn === 'white' ? 'Blancas' : 'Negras';
    parts.push(chip);

    const text = document.createElement('span');
    text.textContent = room.state.turn === myColor
      ? 'Tu turno'
      : 'Turno de ' + opponentName;
    parts.push(text);

    if (room.status.inCheck) {
      const check = document.createElement('span');
      check.className = 'status-check';
      check.textContent = ' · ¡Jaque!';
      parts.push(check);
    }

    if (room.players[opponent] && !room.players[opponent].connected) {
      const offline = document.createElement('span');
      offline.className = 'status-muted';
      offline.textContent = ' · Rival desconectado';
      parts.push(offline);
    }

    if (room.spectators > 0) {
      const watching = document.createElement('span');
      watching.className = 'status-muted';
      watching.textContent = ' · ' + room.spectators
        + (room.spectators === 1 ? ' espectador' : ' espectadores');
      parts.push(watching);
    }

    el.statusText.replaceChildren(...parts);
  }

  function renderMoveList() {
    const history = room.history || [];
    const times = (room.timing && room.timing.moves) || [];
    el.moveList.replaceChildren();

    if (!history.length) {
      const empty = document.createElement('span');
      empty.className = 'empty';
      empty.textContent = 'Sin jugadas todavía';
      el.moveList.appendChild(empty);
      return;
    }

    function addMove(parent, san, index) {
      const move = document.createElement('span');
      move.className = 'move-san';
      move.textContent = san;
      parent.appendChild(move);

      if (times[index] != null) {
        const time = document.createElement('span');
        time.className = 'move-time';
        time.textContent = formatMs(times[index]);
        time.title = 'Tiempo pensado en esta jugada';
        parent.appendChild(time);
      }
    }

    for (let index = 0; index < history.length; index += 2) {
      const pair = document.createElement('span');
      pair.className = 'move-pair';

      const number = document.createElement('span');
      number.className = 'move-num';
      number.textContent = (index / 2 + 1) + '.';
      pair.appendChild(number);

      addMove(pair, history[index], index);

      if (history[index + 1]) addMove(pair, history[index + 1], index + 1);

      el.moveList.appendChild(pair);
    }

    requestAnimationFrame(() => {
      el.moveList.scrollLeft = el.moveList.scrollWidth;
      el.moveList.scrollTop = el.moveList.scrollHeight;
    });
  }

  function spectatorResult(status) {
    if (status.winner === 'white' || status.winner === 'black') {
      const winner = playerName(status.winner);
      const loser = playerName(other(status.winner));
      return {
        title: 'Victoria de ' + winner,
        text: winner + ' gana la partida contra ' + loser + '.',
        status: 'Victoria de ' + winner + '.'
      };
    }
    return {
      title: 'Tablas',
      text: 'La partida ha terminado en tablas.',
      status: 'Tablas.'
    };
  }

  function renderOverlays() {
    const opponent = other(viewColor());
    const waiting = !isSpectator && !room.status.over && !room.players[opponent];
    el.waitingOverlay.hidden = !waiting;
    if (waiting) el.waitingCode.textContent = room.code;

    el.promotionOverlay.hidden = !pendingPromotion || isSpectator;

    const over = room.status.over;
    el.resultOverlay.hidden = !over;
    el.resultLeaveBtn.textContent = isSpectator ? 'Volver al torneo' : 'Salir';

    const summary = over ? timeSummaryText() : '';
    el.timeSummary.textContent = summary;
    el.timeSummary.hidden = !summary;

    if (!over) return;

    const info = isSpectator
      ? spectatorResult(room.status)
      : resultInfo(room.status, playerName(opponent));
    el.resultKicker.textContent = room.status.reason === 'checkmate'
      ? 'Jaque mate'
      : 'Fin de la partida';
    el.resultTitle.textContent = info.title;
    el.resultText.textContent = info.text;

    const canRematch = !isSpectator && !!(room.players[opponent] && room.players[myColor]);
    const voted = !isSpectator && !!(room.rematchVotes && room.rematchVotes[myColor]);
    el.rematchBtn.hidden = !canRematch;
    el.rematchBtn.disabled = rematchPending || voted;
    el.rematchBtn.textContent = rematchPending || voted ? 'Esperando…' : 'Revancha';

    let note = '';
    if (!canRematch) note = 'Tu rival ha salido de la sala.';
    else if (voted) note = 'Esperando a que ' + playerName(opponent) + ' acepte…';
    else if (room.rematchVotes && room.rematchVotes[opponent]) {
      note = playerName(opponent) + ' quiere la revancha.';
    }
    el.rematchNote.textContent = note;
    el.rematchNote.hidden = !note;
  }

  function render() {
    if (!room) return;
    if (!isSpectator && !myColor) myColor = O.getColor() || 'white';
    applyClockSkew();
    renderBoard();
    renderPlayers();
    renderStatus();
    renderMoveList();
    renderClocks();
    renderOverlays();
  }

  // ==================== RESULTADO ====================

  function resultInfo(status, opponentName) {
    const win = status.winner === myColor;
    switch (status.reason) {
      case 'checkmate':
        return win
          ? {
              title: '¡Jaque mate!',
              text: 'Has ganado la partida contra ' + opponentName + '.',
              status: 'Jaque mate. ¡Has ganado!'
            }
          : {
              title: 'Jaque mate',
              text: opponentName + ' te ha dado jaque mate.',
              status: 'Jaque mate. Gana ' + opponentName + '.'
            };
      case 'stalemate':
        return {
          title: 'Tablas',
          text: 'El rey no tiene jugadas legales, pero no está en jaque: ahogado.',
          status: 'Tablas por ahogado.'
        };
      case 'insufficient':
        return {
          title: 'Tablas',
          text: 'No queda material suficiente para dar jaque mate.',
          status: 'Tablas por material insuficiente.'
        };
      case 'fifty-move':
        return {
          title: 'Tablas',
          text: 'Se han jugado 50 movimientos sin capturas ni peones.',
          status: 'Tablas por la regla de 50 jugadas.'
        };
      case 'resignation':
        return win
          ? {
              title: 'Victoria',
              text: opponentName + ' se ha rendido.',
              status: opponentName + ' se rindió. ¡Has ganado!'
            }
          : {
              title: 'Derrota',
              text: 'Te has rendido.',
              status: 'Te has rendido.'
            };
      case 'disconnect':
        return win
          ? {
              title: 'Victoria',
              text: opponentName + ' no volvió a conectarse a tiempo.',
              status: opponentName + ' no volvió. ¡Has ganado!'
            }
          : {
              title: 'Derrota',
              text: 'Se agotó tu tiempo de reconexión.',
              status: 'Se agotó el tiempo de reconexión.'
            };
      case 'abandonment':
        return win
          ? {
              title: 'Victoria',
              text: opponentName + ' ha abandonado la sala.',
              status: opponentName + ' abandonó. ¡Has ganado!'
            }
          : {
              title: 'Partida abandonada',
              text: 'Has abandonado la partida.',
              status: 'Has abandonado la partida.'
            };
      default:
        return {
          title: 'Fin de la partida',
          text: 'La partida ha terminado.',
          status: 'Fin de la partida.'
        };
    }
  }

  // ==================== INTERACCIÓN ====================

  function canInteract() {
    if (!room || !myColor) return false;
    if (room.status.over || pendingPromotion || movePending) return false;
    if (!O.isConnected()) return false;
    if (room.state.turn !== myColor) return false;
    if (!room.players[myColor]) return false;
    if (!room.players[other(myColor)]) return false;
    return true;
  }

  function onBoardPointerDown(event) {
    if (!room || drag) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.pointerType !== 'mouse' && event.isPrimary === false) return;

    const square = event.target.closest('.square');
    if (!square) return;
    event.preventDefault();

    const row = Number(square.dataset.row);
    const col = Number(square.dataset.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;

    if (!canInteract()) {
      const piece = room.state.board[row][col];
      if (isSpectator) {
        showToast('Estás mirando la partida.');
      } else if (!O.isConnected()) {
        showToast('Sin conexión. Reconectando…', 'error');
      } else if (!room.status.over && piece !== ' '
          && E.colorOf(piece) === myColor && room.state.turn !== myColor) {
        showToast('Espera tu turno.');
      } else if (!room.players[other(myColor)]) {
        showToast('Todavía no hay rival. Comparte el enlace.');
      }
      return;
    }

    try {
      el.board.setPointerCapture(event.pointerId);
    } catch (error) {
      // algunos navegadores no lo permiten; seguimos con listeners globales
    }

    const piece = room.state.board[row][col];
    if (piece !== ' ' && E.colorOf(piece) === myColor) {
      if (selected && selected.row === row && selected.col === col) {
        clearSelection();
        renderBoard();
        return;
      }
      selected = { row, col };
      legalMoves = E.legalMovesFor(row, col, room.state.board, room.state);
      drag = {
        row,
        col,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        clone: null,
        pointerId: event.pointerId
      };
      renderBoard();
      return;
    }

    if (selected && trySquare(row, col)) return;

    if (selected) {
      clearSelection();
      renderBoard();
    }
  }

  function trySquare(row, col) {
    const move = legalMoves.find(item => item.row === row && item.col === col);
    if (!move) return false;

    if (move.special === 'promotion') {
      pendingPromotion = {
        from: { row: selected.row, col: selected.col },
        to: { row, col },
        color: myColor
      };
      clearSelection();
      renderBoard();
      openPromotion();
      return true;
    }

    sendMove(selected, { row, col });
    return true;
  }

  function onPointerMove(event) {
    if (!drag || !room) return;
    if (drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (!drag.active && Math.hypot(dx, dy) > 6) {
      const piece = room.state.board[drag.row][drag.col];
      if (!piece || piece === ' ') {
        drag = null;
        return;
      }
      drag.active = true;
      const clone = document.createElement('span');
      clone.className = 'drag-clone '
        + (E.colorOf(piece) === 'white' ? 'piece-white' : 'piece-black');
      clone.textContent = E.BLACK_PIECES[E.typeOf(piece)];
      clone.style.left = event.clientX + 'px';
      clone.style.top = event.clientY + 'px';
      document.body.appendChild(clone);
      drag.clone = clone;
      renderBoard();
    }

    if (drag.active && drag.clone) {
      drag.clone.style.left = event.clientX + 'px';
      drag.clone.style.top = event.clientY + 'px';
    }
  }

  function onPointerUp(event) {
    if (!drag) return;
    if (drag.pointerId !== undefined && event.pointerId !== drag.pointerId) return;

    const wasActive = drag.active;
    const startRow = drag.row;
    const startCol = drag.col;
    const clone = drag.clone;
    drag = null;

    if (clone) clone.remove();
    try {
      if (el.board.hasPointerCapture(event.pointerId)) {
        el.board.releasePointerCapture(event.pointerId);
      }
    } catch (error) {
      // nada que hacer
    }

    if (!wasActive) {
      // Fue un toque: la selección ya se hizo en pointerdown.
      renderBoard();
      return;
    }

    if (!room) return;

    const rect = el.board.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const displayCol = Math.floor((x / rect.width) * 8);
    const displayRow = Math.floor((y / rect.height) * 8);

    if (displayRow < 0 || displayRow > 7 || displayCol < 0 || displayCol > 7) {
      renderBoard();
      return;
    }

    const flipped = orientation === 'black';
    const row = flipped ? 7 - displayRow : displayRow;
    const col = flipped ? 7 - displayCol : displayCol;

    if (row === startRow && col === startCol) {
      renderBoard();
      return;
    }

    if (!selected || selected.row !== startRow || selected.col !== startCol) {
      selected = { row: startRow, col: startCol };
      legalMoves = E.legalMovesFor(startRow, startCol, room.state.board, room.state);
    }

    if (!trySquare(row, col)) {
      renderBoard();
    }
  }

  function onPointerCancel() {
    if (!drag) return;
    if (drag.clone) drag.clone.remove();
    drag = null;
    renderBoard();
  }

  // ==================== JUGADAS ====================

  function sendMove(from, to, promotion) {
    if (movePending) return;
    movePending = true;
    clearSelection();
    renderBoard();
    renderStatus();

    O.sendMove([from.row, from.col], [to.row, to.col], promotion).then((response) => {
      movePending = false;
      if (!response.ok) {
        showToast(errorText(response.error), 'error');
        render();
        return;
      }
      if (response.room) room = response.room;
      render();
    });
  }

  function openPromotion() {
    if (!pendingPromotion) return;
    el.promotionRow.replaceChildren();
    for (const type of PROMOTION_ORDER) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'promotion-btn '
        + (pendingPromotion.color === 'white' ? 'piece-white' : 'piece-black');
      button.textContent = E.BLACK_PIECES[type];
      button.setAttribute('aria-label', 'Coronar ' + PROMOTION_NAMES[type].toLowerCase());
      button.addEventListener('click', () => choosePromotion(type));
      el.promotionRow.appendChild(button);
    }
    el.promotionOverlay.hidden = false;
  }

  function choosePromotion(type) {
    const promotion = pendingPromotion;
    pendingPromotion = null;
    el.promotionOverlay.hidden = true;
    if (!promotion) return;
    sendMove(promotion.from, promotion.to, type);
  }

  function cancelPromotion() {
    pendingPromotion = null;
    el.promotionOverlay.hidden = true;
    clearSelection();
    renderBoard();
  }

  // ==================== LOBBY ====================

  async function attemptResume() {
    if (busy) return;
    O.enableAutoResume();
    setBusy(true);
    clearLobbyError();
    showResumeNotice('Recuperando tu partida…');
    const response = await O.resume();
    setBusy(false);

    if (response.ok) {
      myColor = response.color;
      orientation = response.color;
      room = response.room || O.getRoom();
      enterGame();
      showToast('Partida recuperada');
      return;
    }

    showLobby();
    if (response.error === 'not_found' || response.error === 'invalid_code'
        || response.error === 'full' || response.error === 'no_session') {
      showLobbyError('Tu partida anterior ya no está disponible. Crea una sala nueva.');
      clearResumeNotice();
      return;
    }

    showResumeNotice(
      'No se pudo recuperar la partida. ' + errorText(response.error),
      attemptResume
    );
  }

  async function handleCreate() {
    if (busy) return;
    const name = el.playerName.value.trim();
    setBusy(true);
    clearLobbyError();
    clearResumeNotice();

    const response = await O.createRoom(name);
    setBusy(false);

    if (!response.ok) {
      showLobbyError(errorText(response.error));
      return;
    }

    myColor = response.color;
    orientation = response.color;
    room = response.room;
    enterGame();
    showToast('Sala creada. Comparte el enlace con tu rival.');
  }

  async function handleJoin(event) {
    if (event) event.preventDefault();
    if (busy) return;

    const code = el.codeInput.value.trim().toUpperCase();
    if (code.length !== 6) {
      showLobbyError('El código de sala tiene 6 caracteres.');
      return;
    }

    const name = el.playerName.value.trim();
    setBusy(true);
    clearLobbyError();
    clearResumeNotice();

    const response = await O.joinRoom(code, name);
    setBusy(false);

    if (!response.ok) {
      showLobbyError(errorText(response.error));
      return;
    }

    myColor = response.color;
    orientation = response.color;
    room = response.room;
    enterGame();
    showToast(response.resumed ? 'Partida recuperada' : 'Te has unido a la sala');
  }

  async function leaveGame(confirmFirst) {
    if (isSpectator) {
      await O.stopWatching();
      window.location.href = '/torneo';
      return;
    }

    if (!room) {
      showLobby();
      updateUrl(null);
      return;
    }

    const opponent = other(myColor);
    const inProgress = !room.status.over && !!room.players[opponent];
    if (confirmFirst && inProgress) {
      const confirmed = window.confirm(
        '¿Salir de la partida? Se contará como abandono.'
      );
      if (!confirmed) return;
    }

    await O.leaveRoom();
    room = null;
    myColor = null;
    pendingPromotion = null;
    rematchPending = false;
    movePending = false;
    clearSelection();
    showLobby();
    updateUrl(null);
    clearResumeNotice();
    showToast('Has salido de la sala');
  }

  // ==================== COPIAR ENLACE ====================

  async function copyInvite() {
    if (!room) return;
    const url = window.location.origin + '/room/' + room.code;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Enlace copiado al portapapeles');
      return;
    } catch (error) {
      // Fallback para navegadores sin clipboard API
    }

    const input = document.createElement('textarea');
    input.value = url;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    try {
      document.execCommand('copy');
      showToast('Enlace copiado al portapapeles');
    } catch (error) {
      showToast('Copia este enlace: ' + url, 'error');
    }
    input.remove();
  }

  // ==================== EVENTOS DE RED ====================

  O.on('room', (payload) => {
    if (!payload) return;
    const wasOver = !!(room && room.status.over);
    room = payload;

    if (!myColor && !isSpectator) {
      const session = O.getSession();
      if (session) myColor = session.color;
    }

    if (wasOver && !payload.status.over) {
      rematchPending = false;
      pendingPromotion = null;
      movePending = false;
      el.promotionOverlay.hidden = true;
      clearSelection();
      orientation = myColor || orientation;
      showToast('¡Nueva partida!');
    }

    if (selected) {
      const piece = payload.state.board[selected.row][selected.col];
      if (payload.status.over || payload.state.turn !== myColor
          || !piece || piece === ' ' || E.colorOf(piece) !== myColor) {
        clearSelection();
      }
    }

    if (!el.gameScreen.hidden) {
      el.roomCode.textContent = room.code;
      el.waitingCode.textContent = room.code;
      render();
    }
  });

  O.on('joined', (payload) => {
    if (!payload || !payload.room) return;
    const previousColor = myColor;
    myColor = payload.color;
    room = payload.room;
    if (previousColor && previousColor !== payload.color) {
      orientation = payload.color;
      clearSelection();
      pendingPromotion = null;
      el.promotionOverlay.hidden = true;
    }
    if (el.gameScreen.hidden) {
      orientation = payload.color;
      enterGame();
    } else {
      render();
    }
  });

  O.on('color', (color) => {
    myColor = color;
    orientation = color;
    rematchPending = false;
    clearSelection();
    if (room) render();
    showToast('Ahora juegas con ' + colorLabel(color).toLowerCase());
  });

  O.on('connection', (payload) => {
    const badge = el.connectionBadge;
    badge.classList.remove('warn', 'bad');
    if (payload.status === 'connected') {
      el.connectionText.textContent = 'En línea';
    } else if (payload.status === 'reconnecting') {
      badge.classList.add('warn');
      el.connectionText.textContent = 'Reconectando…';
      movePending = false;
    } else {
      badge.classList.add('bad');
      el.connectionText.textContent = 'Sin conexión';
      movePending = false;
      if (drag) {
        if (drag.clone) drag.clone.remove();
        drag = null;
      }
    }
    if (room && !el.gameScreen.hidden) renderStatus();
  });

  O.on('session-lost', () => {
    if (busy) return;
    room = null;
    myColor = null;
    showLobby();
    updateUrl(null);
    showLobbyError('La sala ya no existe o ha caducado.');
    clearResumeNotice();
  });

  O.on('left', () => {
    room = null;
    myColor = null;
    showLobby();
    updateUrl(null);
  });

  // ==================== EVENTOS DE UI ====================

  el.createBtn.addEventListener('click', handleCreate);
  el.joinForm.addEventListener('submit', handleJoin);

  el.codeInput.addEventListener('input', () => {
    el.codeInput.value = el.codeInput.value
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6);
  });

  el.playerName.addEventListener('change', () => {
    const name = el.playerName.value.trim();
    if (name) O.setName(name);
  });

  el.copyBtn.addEventListener('click', copyInvite);
  el.waitingCopyBtn.addEventListener('click', copyInvite);

  el.flipBtn.addEventListener('click', () => {
    orientation = orientation === 'white' ? 'black' : 'white';
    clearSelection();
    renderBoard();
  });

  el.leaveBtn.addEventListener('click', () => leaveGame(true));
  el.resultLeaveBtn.addEventListener('click', () => leaveGame(false));
  el.cancelPromotionBtn.addEventListener('click', cancelPromotion);

  el.rematchBtn.addEventListener('click', async () => {
    if (rematchPending) return;
    rematchPending = true;
    renderOverlays();
    const response = await O.rematch();
    rematchPending = false;
    if (!response.ok) {
      showToast(errorText(response.error), 'error');
      render();
      return;
    }
    if (!response.started) showToast('Revancha solicitada. Esperando al rival…');
    render();
  });

  el.board.addEventListener('pointerdown', onBoardPointerDown);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);

  window.AjedrezDebug = {
    get room() { return room; },
    get myColor() { return myColor; },
    get orientation() { return orientation; },
    get selected() { return selected; },
    get pendingPromotion() { return pendingPromotion; }
  };

  async function startWatching(code) {
    const response = await O.watch(code);
    if (!response.ok) {
      showLobby();
      showLobbyError('No se pudo ver esa partida. ' + errorText(response.error));
      updateUrl(null);
      return;
    }
    isSpectator = true;
    myColor = null;
    orientation = 'white';
    room = response.room;
    enterGame();
  }

  // ==================== ARRANQUE ====================

  function init() {
    buildBoard();

    const savedName = O.getName();
    if (savedName) el.playerName.value = savedName;

    const session = O.getSession();
    const urlCode = roomCodeFromUrl();
    const watchOnly = new URLSearchParams(window.location.search).get('ver') === '1';
    if (urlCode) el.codeInput.value = urlCode;

    showLobby();

    if (urlCode && watchOnly) {
      startWatching(urlCode);
      return;
    }

    updateUrl(urlCode);

    if (session && (!urlCode || urlCode === session.code)) {
      attemptResume();
    } else if (session && urlCode && urlCode !== session.code) {
      showResumeNotice(
        'Tienes otra partida guardada en la sala ' + session.code + '. '
          + 'Si entras en una sala nueva, la anterior se cerrará.',
        () => {
          updateUrl(session.code);
          el.codeInput.value = session.code;
          attemptResume();
        }
      );
    } else if (urlCode) {
      el.codeInput.focus();
    }

    const online = O.isConnected();
    el.connectionBadge.classList.toggle('warn', !online);
    el.connectionText.textContent = online ? 'En línea' : 'Reconectando…';
  }

  init();
})();
