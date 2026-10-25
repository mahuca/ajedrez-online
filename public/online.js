/*
 * Capa de red del ajedrez online.
 * Mantiene la sesión (código + token) y la reconexión automática.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'ajedrezOnlineSession_v1';
  const NAME_KEY = 'ajedrezOnlineName_v1';
  const REQUEST_TIMEOUT_MS = 10000;
  const CONNECT_TIMEOUT_MS = 8000;

  const socket = io({
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    timeout: 10000
  });

  const listeners = new Map();
  let session = loadSession();
  let room = null;
  let autoResume = false;
  let needsResume = !!session;
  let resumePromise = null;

  // ==================== EVENTOS LOCALES ====================

  function on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => off(event, fn);
  }

  function off(event, fn) {
    const set = listeners.get(event);
    if (set) set.delete(fn);
  }

  function emit(event, payload) {
    const set = listeners.get(event);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (error) {
        console.error('Error en listener', event, error);
      }
    }
  }

  // ==================== SESIÓN ====================

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.code !== 'string' || typeof parsed.token !== 'string') {
        return null;
      }
      return {
        code: parsed.code,
        token: parsed.token,
        color: parsed.color === 'black' ? 'black' : 'white',
        name: typeof parsed.name === 'string' ? parsed.name : ''
      };
    } catch (error) {
      return null;
    }
  }

  function saveSession(next) {
    session = next;
    needsResume = false;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      // almacenamiento no disponible (modo privado): seguimos en memoria
    }
  }

  function clearSession() {
    session = null;
    room = null;
    needsResume = false;
    autoResume = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // nada que hacer
    }
  }

  function getName() {
    try {
      return localStorage.getItem(NAME_KEY) || '';
    } catch (error) {
      return '';
    }
  }

  function setName(name) {
    try {
      if (name) localStorage.setItem(NAME_KEY, name);
    } catch (error) {
      // nada que hacer
    }
  }

  // ==================== TRANSPORTE ====================

  function waitForConnect(timeoutMs) {
    if (socket.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.off('connect', onConnect);
        resolve(value);
      };
      const onConnect = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      socket.on('connect', onConnect);
    });
  }

  function request(event, payload, options = {}) {
    const wait = options.wait !== false;
    if (!socket.connected) {
      if (!wait) return Promise.resolve({ ok: false, error: 'offline' });
      return waitForConnect(CONNECT_TIMEOUT_MS).then((connected) => {
        if (!connected) return { ok: false, error: 'timeout' };
        return send(event, payload);
      });
    }
    return send(event, payload);
  }

  function send(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(REQUEST_TIMEOUT_MS).emit(event, payload, (error, response) => {
        if (error) return resolve({ ok: false, error: 'timeout' });
        if (!response || typeof response !== 'object') {
          return resolve({ ok: false, error: 'server_error' });
        }
        resolve(response);
      });
    });
  }

  // ==================== CONEXIÓN ====================

  socket.on('connect', () => {
    emit('connection', { status: 'connected' });
    if (autoResume && session && needsResume) resume();
  });

  socket.on('disconnect', (reason) => {
    needsResume = !!session;
    emit('connection', { status: 'disconnected', reason });
  });

  socket.io.on('reconnect_attempt', () => {
    emit('connection', { status: 'reconnecting' });
  });

  socket.io.on('reconnect_failed', () => {
    emit('connection', { status: 'offline' });
  });

  socket.on('room:update', (payload) => {
    if (!payload || typeof payload.code !== 'string') return;
    room = payload;
    needsResume = false;
    emit('room', room);
  });

  socket.on('room:color', (payload) => {
    if (!payload || (payload.color !== 'white' && payload.color !== 'black')) return;
    if (!session) return;
    session.color = payload.color;
    saveSession(session);
    emit('color', payload.color);
  });

  // ==================== API ====================

  async function createRoom(name) {
    if (session) await leaveRoom({ silent: true });
    const response = await request('room:create', { name });
    if (!response.ok) return response;

    room = response.room;
    saveSession({
      code: response.code,
      token: response.token,
      color: response.color,
      name: name || ''
    });
    autoResume = true;
    needsResume = false;
    setName(name || '');
    emit('room', room);
    return response;
  }

  async function joinRoom(code, name) {
    const normalized = String(code || '').trim().toUpperCase();
    if (session && session.code !== normalized) {
      await leaveRoom({ silent: true });
    }
    const token = session && session.code === normalized ? session.token : undefined;

    const response = await request('room:join', {
      code: normalized,
      token,
      name
    });
    if (!response.ok) return response;

    room = response.room;
    saveSession({
      code: response.code,
      token: response.token,
      color: response.color,
      name: name || (session ? session.name : '')
    });
    autoResume = true;
    needsResume = false;
    setName(name || '');
    emit('room', room);
    return response;
  }

  async function watch(code) {
    const normalized = String(code || '').trim().toUpperCase();
    const response = await request('room:watch', { code: normalized });
    if (!response.ok) return response;

    room = response.room;
    emit('room', room);
    return response;
  }

  function stopWatching() {
    if (!socket.connected) return Promise.resolve({ ok: true });
    return request('room:leave', {});
  }

  async function resume() {
    if (!session) return { ok: false, error: 'no_session' };
    if (resumePromise) return resumePromise;

    resumePromise = (async () => {
      const response = await request('room:join', {
        code: session.code,
        token: session.token,
        name: session.name
      });

      if (response.ok) {
        room = response.room;
        saveSession({
          code: response.code,
          token: response.token,
          color: response.color,
          name: session.name
        });
        autoResume = true;
        needsResume = false;
        emit('joined', { ...response, resumed: true });
        emit('room', room);
        return response;
      }

      if (response.error === 'not_found' || response.error === 'invalid_code'
          || response.error === 'full') {
        clearSession();
        emit('session-lost', response);
      }
      return response;
    })();

    try {
      return await resumePromise;
    } finally {
      resumePromise = null;
    }
  }

  async function sendMove(from, to, promotion) {
    if (!session) return { ok: false, error: 'no_session' };
    if (!socket.connected) return { ok: false, error: 'offline' };
    return request('game:move', { from, to, promotion });
  }

  async function resign() {
    if (!session) return { ok: false, error: 'no_session' };
    return request('game:resign', {});
  }

  async function rematch() {
    if (!session) return { ok: false, error: 'no_session' };
    return request('game:rematch', {});
  }

  async function leaveRoom(options = {}) {
    const hadSession = !!session;
    if (hadSession && socket.connected) {
      await request('room:leave', {});
    }
    clearSession();
    if (!options.silent) emit('left');
    return { ok: true };
  }

  function enableAutoResume() {
    autoResume = true;
    if (socket.connected && session && needsResume && !resumePromise) resume();
  }

  function getSession() {
    return session ? { ...session } : null;
  }

  function getRoom() {
    return room;
  }

  function getColor() {
    return session ? session.color : null;
  }

  function isConnected() {
    return socket.connected;
  }

  function reconnect() {
    if (!socket.connected) socket.connect();
  }

  window.Online = {
    on,
    off,
    createRoom,
    joinRoom,
    watch,
    stopWatching,
    resume,
    sendMove,
    resign,
    rematch,
    leaveRoom,
    enableAutoResume,
    getSession,
    getRoom,
    getColor,
    getName,
    setName,
    isConnected,
    reconnect
  };
})();
