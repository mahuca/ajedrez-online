/*
 * Página del torneo familiar.
 * Lee el estado del servidor, pinta calendario y clasificación, y permite
 * crear o unirse a la sala de cada partida.
 */
(function () {
  'use strict';

  const SESSION_KEY = 'ajedrezOnlineSession_v1';
  const NAME_KEY = 'ajedrezOnlineNombre_v1';
  const KEY_STORE = 'ajedrezTorneoClave_v1';
  const POLL_MS = 6000;

  const ERRORS = {
    offline: 'Sin conexión. Comprueba tu red.',
    timeout: 'El servidor tarda en responder. Inténtalo de nuevo.',
    server_error: 'Error del servidor. Inténtalo de nuevo.',
    not_found: 'Esa sala ya no existe o ha caducado.',
    invalid_code: 'El código de sala no es válido.',
    full: 'La sala ya tiene dos jugadores.',
    rate_limited: 'Demasiados intentos. Espera un momento.',
    pairing_active: 'Ya hay una sala abierta para esta partida.',
    pairing_played: 'Esta partida ya tiene resultado guardado.',
    unknown_pairing: 'Esa partida ya no está en el calendario. Actualiza la página.',
    spectator: 'Estás mirando la partida, no jugando.',
    clave_correcta: 'Clave guardada.',
    clave_incorrecta: 'La clave de organizador no es correcta.',
    clave_no_configurada: 'El servidor no tiene clave de organizador configurada.',
    jugador_con_resultados: 'No puedes quitar a un jugador que ya tiene resultados.',
    too_few_players: 'Hacen falta al menos dos jugadores.',
    too_many_players: 'El máximo es 16 jugadores.',
    invalid_players: 'La lista de jugadores no es válida.',
    resultado_invalido: 'Ese resultado no es válido.',
    partida_desconocida: 'Esa partida ya no existe.'
  };

  const el = {
    roster: document.getElementById('roster'),
    formatNote: document.getElementById('formatNote'),
    storageNotice: document.getElementById('storageNotice'),
    pageMessage: document.getElementById('pageMessage'),
    standingsBody: document.getElementById('standingsBody'),
    progress: document.getElementById('progress'),
    rounds: document.getElementById('rounds'),
    refreshBtn: document.getElementById('refreshBtn'),
    adminPanel: document.getElementById('adminPanel'),
    keyForm: document.getElementById('keyForm'),
    keyInput: document.getElementById('keyInput'),
    rosterForm: document.getElementById('rosterForm'),
    rosterInput: document.getElementById('rosterInput'),
    footerStorage: document.getElementById('footerStorage'),
    toast: document.getElementById('toast')
  };

  let state = null;
  let busy = false;
  let toastTimer = null;

  const socket = io({ autoConnect: true });

  // ==================== AYUDANTES ====================

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function showToast(message, type) {
    el.toast.textContent = message;
    el.toast.className = 'toast show' + (type === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.className = 'toast';
    }, 3600);
  }

  function showMessage(text) {
    el.pageMessage.textContent = text || '';
    el.pageMessage.hidden = !text;
  }

  function clearMessage() {
    showMessage('');
  }

  function errorText(code) {
    return ERRORS[code] || 'Ha ocurrido un error. Inténtalo de nuevo.';
  }

  function formatPoints(value) {
    const whole = Math.floor(value);
    const half = value - whole >= 0.5;
    if (!whole && half) return '½';
    return half ? whole + '½' : String(whole);
  }

  function resultText(result) {
    if (result === 'white') return '1-0';
    if (result === 'black') return '0-1';
    if (result === 'draw') return '½-½';
    return '—';
  }

  function getKey() {
    try {
      return sessionStorage.getItem(KEY_STORE) || '';
    } catch (error) {
      return '';
    }
  }

  function hasKey() {
    return !!getKey();
  }

  function storeSession(code, token, color, name) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ code, token, color, name }));
      localStorage.setItem(NAME_KEY, name);
    } catch (error) {
      // almacenamiento no disponible: la partida se abrirá igualmente
    }
  }

  // ==================== RED ====================

  async function api(url, options = {}) {
    const headers = Object.assign({}, options.headers);
    if (options.body) headers['Content-Type'] = 'application/json';
    const key = getKey();
    if (key) headers['x-torneo-clave'] = key;

    try {
      const response = await fetch(url, Object.assign({}, options, { headers }));
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          error: (data && data.error) || 'server_error'
        };
      }
      return data || { ok: false, error: 'server_error' };
    } catch (error) {
      return { ok: false, error: 'offline' };
    }
  }

  function request(event, payload) {
    return new Promise((resolve) => {
      if (!socket.connected) return resolve({ ok: false, error: 'offline' });
      socket.timeout(9000).emit(event, payload, (error, response) => {
        if (error) return resolve({ ok: false, error: 'timeout' });
        resolve(response || { ok: false, error: 'server_error' });
      });
    });
  }

  async function loadState(options = {}) {
    const data = await api('/api/torneo');
    if (!data.ok) {
      if (!options.silent) showMessage(errorText(data.error));
      return false;
    }
    state = data;
    if (!options.silent) clearMessage();
    render();
    return true;
  }

  // ==================== PINTADO ====================

  function render() {
    if (!state) return;
    renderRoster();
    renderNotice();
    renderStandings();
    renderRounds();
    renderAdmin();
  }

  function renderRoster() {
    el.roster.replaceChildren();
    for (const name of state.players) {
      const chip = h('span', 'roster-chip');
      chip.appendChild(h('span', 'chip-glyph', '♞'));
      chip.appendChild(h('span', null, name));
      el.roster.appendChild(chip);
    }

    const total = state.schedule.filter(game => !game.bye).length;
    const rounds = new Set(state.schedule.map(game => game.round)).size;
    const twoLegs = state.schedule.some(game => game.leg === 2);
    el.formatNote.textContent = state.players.length + ' jugadores · '
      + rounds + ' rondas · ' + total + ' partidas · '
      + (twoLegs ? 'ida y vuelta' : 'ida sola');
  }

  function renderNotice() {
    const storage = state.storage || {};
    let text = '';

    if (storage.kind === 'memory') {
      text = storage.fallbackReason === 'sin_conexion'
        ? 'No se pudo conectar con la base de datos. Los resultados se guardan en memoria y se perderán al reiniciar el servidor.'
        : 'Todavía no hay base de datos configurada. Los resultados se guardan en memoria y se perderán al reiniciar el servidor. Añade DATABASE_URL en Render para conservarlos.';
    }

    el.storageNotice.textContent = text;
    el.storageNotice.hidden = !text;
    el.footerStorage.textContent = storage.kind === 'postgres'
      ? 'Resultados guardados de forma permanente'
      : 'Guardado temporal en memoria';
  }

  function renderStandings() {
    el.standingsBody.replaceChildren();

    for (const row of state.standings) {
      const tr = document.createElement('tr');
      if (row.rank === 1 && row.total > 0) tr.className = 'leader';

      const rank = h('td', 'rank', row.rank);
      tr.appendChild(rank);
      rank.className = 'col-rank rank';

      const nameCell = document.createElement('td');
      const wrap = h('div', 'player-cell');
      wrap.appendChild(h('span', 'name', row.name));
      if (row.rank === 1 && row.total > 0) wrap.appendChild(h('span', 'tag', 'líder'));
      if (row.byes) {
        wrap.appendChild(h('span', 'count',
          row.byes === 1 ? '1 descanso' : row.byes + ' descansos'));
      }
      nameCell.appendChild(wrap);
      tr.appendChild(nameCell);

      tr.appendChild(h('td', 'col-num', row.played));
      tr.appendChild(h('td', 'col-num', row.wins));
      tr.appendChild(h('td', 'col-num', row.draws));
      tr.appendChild(h('td', 'col-num', row.losses));
      const points = h('td', 'col-num points', formatPoints(row.total));
      tr.appendChild(points);

      el.standingsBody.appendChild(tr);
    }

    const played = Object.keys(state.results).length;
    const total = state.schedule.filter(game => !game.bye).length;
    el.progress.textContent = played + ' de ' + total + ' partidas';
  }

  function sideNode(game, color) {
    const name = color === 'white' ? game.white : game.black;
    const node = h('span', 'match-side ' + color);
    node.appendChild(h('span', 'glyph', color === 'white' ? '♔' : '♚'));
    node.appendChild(h('span', 'name', name));
    return node;
  }

  function renderRounds() {
    el.rounds.replaceChildren();

    const groups = new Map();
    for (const game of state.schedule) {
      if (!groups.has(game.round)) groups.set(game.round, []);
      groups.get(game.round).push(game);
    }

    const twoLegs = state.schedule.some(game => game.leg === 2);

    for (const [round, games] of groups) {
      const section = h('div', 'round');

      const head = h('div', 'round-head');
      head.appendChild(h('h3', null, 'Ronda ' + round));
      if (twoLegs) {
        head.appendChild(h('span', 'leg', games[0].leg === 2 ? 'Vuelta' : 'Ida'));
      }
      section.appendChild(head);

      for (const game of games) section.appendChild(renderMatch(game));

      el.rounds.appendChild(section);
    }
  }

  function renderMatch(game) {
    const article = h('article', 'match');

    if (game.bye) {
      article.classList.add('bye');
      const wrap = h('div', 'match-players');
      const side = h('span', 'match-side');
      side.appendChild(h('span', 'glyph', '—'));
      side.appendChild(h('span', 'name', game.bye));
      wrap.appendChild(side);
      wrap.appendChild(h('span', 'match-sep', 'descansa'));
      article.appendChild(wrap);
      article.appendChild(h('span', 'result-badge', '+1'));
      article.appendChild(h('span', 'state-badge', 'descanso'));
      return article;
    }

    const record = state.results[game.id];
    const live = state.live[game.id];
    const isLive = !!(live && !live.over);

    if (isLive) article.classList.add('live');
    if (record) article.classList.add('done');

    const players = h('div', 'match-players');
    const white = sideNode(game, 'white');
    const black = sideNode(game, 'black');
    if (record && record.result === 'white') white.classList.add('winner');
    if (record && record.result === 'black') black.classList.add('winner');
    players.appendChild(white);
    players.appendChild(h('span', 'match-sep', 'vs'));
    players.appendChild(black);
    article.appendChild(players);

    const actions = h('div', 'match-actions');

    if (record) {
      actions.appendChild(h('span', 'result-badge', resultText(record.result)));
      actions.appendChild(h('span', 'state-badge', record.source === 'manual' ? 'manual' : 'jugada'));

      const pgn = h('a', 'btn btn-ghost btn-sm', 'PGN');
      pgn.href = '/api/torneo/partida/' + encodeURIComponent(game.id) + '/pgn';
      pgn.setAttribute('download', '');
      actions.appendChild(pgn);
    } else if (isLive) {
      actions.appendChild(h('span', 'state-badge live', 'en curso'));
      actions.appendChild(h('span', 'match-code', live.code));

      const join = h('button', 'btn btn-primary btn-sm', 'Unirme');
      join.type = 'button';
      join.addEventListener('click', () => joinRoom(game, live.code));
      join.title = 'Entrar como ' + game.black + ' (negras)';
      actions.appendChild(join);

      const watch = h('a', 'btn btn-ghost btn-sm', 'Ver');
      watch.href = '/room/' + live.code + '?ver=1';
      watch.title = 'Mirar la partida sin jugar';
      actions.appendChild(watch);
    } else {
      const create = h('button', 'btn btn-primary btn-sm', 'Crear sala');
      create.type = 'button';
      create.title = 'Crear la sala como ' + game.white + ' (blancas)';
      create.addEventListener('click', () => createRoom(game));
      actions.appendChild(create);

      const join = h('button', 'btn btn-ghost btn-sm', 'Unirme');
      join.type = 'button';
      join.disabled = true;
      join.title = 'Espera a que se cree la sala';
      actions.appendChild(join);
    }

    article.appendChild(actions);

    if (hasKey()) article.appendChild(renderAdminActions(game));

    return article;
  }

  function renderAdminActions(game) {
    const bar = h('div', 'admin-actions');

    const options = [
      { label: '1-0', value: 'white', title: 'Ganan blancas' },
      { label: '½-½', value: 'draw', title: 'Tablas' },
      { label: '0-1', value: 'black', title: 'Ganan negras' }
    ];

    for (const option of options) {
      const button = h('button', 'btn btn-ghost btn-sm', option.label);
      button.type = 'button';
      button.title = 'Guardar resultado manual: ' + option.title;
      button.addEventListener('click', () => saveResult(game, option.value));
      bar.appendChild(button);
    }

    const clear = h('button', 'btn btn-danger-ghost btn-sm', 'Anular');
    clear.type = 'button';
    clear.title = 'Borrar el resultado guardado';
    clear.addEventListener('click', () => clearResult(game));
    bar.appendChild(clear);

    return bar;
  }

  // ==================== ACCIONES ====================

  function setRoundButtonsDisabled(value) {
    for (const button of el.rounds.querySelectorAll('button')) {
      if (button.dataset.keep !== '1') button.disabled = value;
    }
  }

  async function createRoom(game) {
    if (busy) return;
    busy = true;
    setRoundButtonsDisabled(true);

    const response = await request('room:create', { name: game.white, partida: game.id });

    busy = false;
    if (!response.ok) {
      if (response.error === 'pairing_active' && response.code) {
        showToast('Ya hay una sala abierta: ' + response.code);
        await loadState({ silent: true });
        return;
      }
      showToast(errorText(response.error), 'error');
      await loadState({ silent: true });
      return;
    }

    storeSession(response.code, response.token, response.color, game.white);
    window.location.href = '/room/' + response.code;
  }

  async function joinRoom(game, code) {
    if (busy) return;
    busy = true;
    setRoundButtonsDisabled(true);

    const response = await request('room:join', { code, name: game.black });

    busy = false;
    if (!response.ok) {
      showToast(errorText(response.error), 'error');
      await loadState({ silent: true });
      return;
    }

    storeSession(response.code, response.token, response.color, game.black);
    window.location.href = '/room/' + response.code;
  }

  async function saveResult(game, result) {
    if (busy) return;
    if (!hasKey()) {
      showToast('Introduce la clave de organizador.', 'error');
      el.adminPanel.open = true;
      el.keyInput.focus();
      return;
    }

    busy = true;
    const response = await api('/api/torneo/partida/' + encodeURIComponent(game.id), {
      method: 'PUT',
      body: JSON.stringify({ result })
    });
    busy = false;

    if (!response.ok) {
      showToast(errorText(response.error), 'error');
      return;
    }

    state = response;
    render();
    showToast('Resultado guardado.');
  }

  async function clearResult(game) {
    if (busy) return;
    if (!hasKey()) {
      showToast('Introduce la clave de organizador.', 'error');
      el.adminPanel.open = true;
      el.keyInput.focus();
      return;
    }
    if (!window.confirm('¿Borrar el resultado de ' + game.white + ' – '
        + game.black + '?')) return;

    busy = true;
    const response = await api('/api/torneo/partida/' + encodeURIComponent(game.id), {
      method: 'PUT',
      body: JSON.stringify({ clear: true })
    });
    busy = false;

    if (!response.ok) {
      showToast(errorText(response.error), 'error');
      return;
    }

    state = response;
    render();
    showToast('Resultado anulado.');
  }

  async function saveRoster(event) {
    event.preventDefault();
    if (busy) return;
    if (!hasKey()) {
      showToast('Introduce la clave de organizador.', 'error');
      el.keyInput.focus();
      return;
    }

    const players = el.rosterInput.value
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);

    busy = true;
    const response = await api('/api/torneo/jugadores', {
      method: 'PUT',
      body: JSON.stringify({ players })
    });
    busy = false;

    if (!response.ok) {
      showToast(errorText(response.error), 'error');
      return;
    }

    state = response;
    render();
    showToast('Jugadores actualizados.');
  }

  function saveKey(event) {
    event.preventDefault();
    const value = el.keyInput.value.trim();
    try {
      if (value) sessionStorage.setItem(KEY_STORE, value);
      else sessionStorage.removeItem(KEY_STORE);
    } catch (error) {
      showToast('No se pudo guardar la clave en este navegador.', 'error');
      return;
    }
    el.keyInput.value = '';
    render();
    showToast(value ? 'Clave guardada en este navegador.' : 'Clave borrada.');
  }

  function renderAdmin() {
    if (!el.adminPanel.open) {
      el.rosterInput.value = state ? state.players.join('\n') : '';
      return;
    }
    if (document.activeElement !== el.rosterInput) {
      el.rosterInput.value = state ? state.players.join('\n') : '';
    }
  }

  // ==================== EVENTOS ====================

  el.refreshBtn.addEventListener('click', async () => {
    el.refreshBtn.disabled = true;
    const ok = await loadState();
    el.refreshBtn.disabled = false;
    if (ok) showToast('Actualizado.');
  });

  el.keyForm.addEventListener('submit', saveKey);
  el.rosterForm.addEventListener('submit', saveRoster);

  el.adminPanel.addEventListener('toggle', () => {
    if (el.adminPanel.open && state) renderAdmin();
  });

  socket.on('connect', () => {
    clearMessage();
  });

  socket.on('disconnect', () => {
    showMessage('Sin conexión con el servidor. Reintentando…');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadState({ silent: true });
  });

  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (busy) return;
    loadState({ silent: true });
  }, POLL_MS);

  loadState();
})();
