'use strict';

/*
 * Almacenamiento del torneo.
 *
 * - Con DATABASE_URL usa PostgreSQL (Neon, Supabase, Render…).
 * - Sin DATABASE_URL, o si la conexión falla, guarda en memoria para que la
 *   aplicación siga funcionando (los datos se pierden al reiniciar).
 *
 * La interfaz es la misma en ambos casos, así que el resto del servidor no
 * necesita saber cuál está activo.
 */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS torneo_resultados (
     pairing_id TEXT PRIMARY KEY,
     white TEXT NOT NULL,
     black TEXT NOT NULL,
     result TEXT NOT NULL CHECK (result IN ('white', 'black', 'draw')),
     moves JSONB NOT NULL DEFAULT '[]'::jsonb,
     times JSONB NOT NULL DEFAULT '[]'::jsonb,
     sans JSONB NOT NULL DEFAULT '[]'::jsonb,
     pgn TEXT,
     room_code TEXT,
     source TEXT NOT NULL DEFAULT 'manual',
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS torneo_ajustes (
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`
];

function emptyRecord(record) {
  return {
    pairingId: record.pairingId,
    white: record.white,
    black: record.black,
    result: record.result,
    moves: Array.isArray(record.moves) ? record.moves : [],
    times: Array.isArray(record.times) ? record.times : [],
    sans: Array.isArray(record.sans) ? record.sans : [],
    pgn: record.pgn || null,
    roomCode: record.roomCode || null,
    source: record.source || 'manual',
    updatedAt: record.updatedAt || new Date().toISOString()
  };
}

function createMemoryStore() {
  const results = new Map();
  let roster = null;

  return {
    kind: 'memory',
    init: async () => {},
    close: async () => {},
    async getResults() {
      return Object.fromEntries(results);
    },
    async saveResult(record) {
      const saved = emptyRecord({ ...record, updatedAt: new Date().toISOString() });
      results.set(saved.pairingId, saved);
      return saved;
    },
    async deleteResult(pairingId) {
      results.delete(pairingId);
    },
    async getRoster() {
      return roster ? roster.slice() : null;
    },
    async saveRoster(players) {
      roster = players.slice();
      return roster.slice();
    }
  };
}

function createPostgresStore(connectionString, options = {}) {
  // eslint-disable-next-line global-require
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(connectionString);
  const pool = new Pool({
    connectionString,
    ssl: local ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  pool.on('error', (error) => {
    if (!options.quiet) console.error('PostgreSQL (pool):', error.message);
  });

  let ready = null;
  function init() {
    if (!ready) {
      ready = (async () => {
        for (const statement of SCHEMA) await pool.query(statement);
      })();
    }
    return ready;
  }

  return {
    kind: 'postgres',
    init,
    async close() {
      await pool.end().catch(() => {});
    },
    async getResults() {
      await init();
      const { rows } = await pool.query(
        `SELECT pairing_id, white, black, result, moves, times, sans, pgn,
                room_code, source, updated_at
           FROM torneo_resultados`
      );
      const map = {};
      for (const row of rows) {
        map[row.pairing_id] = {
          pairingId: row.pairing_id,
          white: row.white,
          black: row.black,
          result: row.result,
          moves: row.moves || [],
          times: row.times || [],
          sans: row.sans || [],
          pgn: row.pgn,
          roomCode: row.room_code,
          source: row.source,
          updatedAt: new Date(row.updated_at).toISOString()
        };
      }
      return map;
    },
    async saveResult(record) {
      await init();
      const { rows } = await pool.query(
        `INSERT INTO torneo_resultados
           (pairing_id, white, black, result, moves, times, sans, pgn, room_code, source)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10)
         ON CONFLICT (pairing_id) DO UPDATE SET
           white = EXCLUDED.white,
           black = EXCLUDED.black,
           result = EXCLUDED.result,
           moves = EXCLUDED.moves,
           times = EXCLUDED.times,
           sans = EXCLUDED.sans,
           pgn = EXCLUDED.pgn,
           room_code = EXCLUDED.room_code,
           source = EXCLUDED.source,
           updated_at = now()
         RETURNING updated_at`,
        [
          record.pairingId,
          record.white,
          record.black,
          record.result,
          JSON.stringify(record.moves || []),
          JSON.stringify(record.times || []),
          JSON.stringify(record.sans || []),
          record.pgn || null,
          record.roomCode || null,
          record.source || 'manual'
        ]
      );
      return emptyRecord({
        ...record,
        updatedAt: new Date(rows[0].updated_at).toISOString()
      });
    },
    async deleteResult(pairingId) {
      await init();
      await pool.query('DELETE FROM torneo_resultados WHERE pairing_id = $1', [pairingId]);
    },
    async getRoster() {
      await init();
      const { rows } = await pool.query(
        "SELECT value FROM torneo_ajustes WHERE key = 'jugadores'"
      );
      if (!rows.length) return null;
      const value = rows[0].value;
      return Array.isArray(value) ? value : null;
    },
    async saveRoster(players) {
      await init();
      await pool.query(
        `INSERT INTO torneo_ajustes (key, value) VALUES ('jugadores', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify(players)]
      );
      return players.slice();
    }
  };
}

function createStore(options = {}) {
  const quiet = !!options.quiet;
  const connectionString = options.connectionString || process.env.DATABASE_URL || '';
  const memory = createMemoryStore();

  if (!connectionString) {
    return Object.assign(memory, {
      requested: 'memory',
      fallbackReason: null
    });
  }

  let postgres;
  try {
    postgres = createPostgresStore(connectionString, { quiet });
  } catch (error) {
    if (!quiet) console.error('No se pudo cargar el cliente de PostgreSQL:', error.message);
    return Object.assign(memory, {
      requested: 'postgres',
      fallbackReason: 'cliente_no_disponible'
    });
  }

  let active = postgres;
  let fallbackReason = null;

  const store = {
    get kind() {
      return active.kind;
    },
    requested: 'postgres',
    get fallbackReason() {
      return fallbackReason;
    },
    async init() {
      if (fallbackReason) return;
      try {
        await postgres.init();
      } catch (error) {
        if (!quiet) {
          console.error('No se pudo conectar a PostgreSQL:', error.message);
          console.error('Se guardará en memoria hasta reiniciar.');
        }
        fallbackReason = 'sin_conexion';
        active = memory;
        await memory.init();
      }
    },
    async close() {
      await active.close();
      if (active !== postgres) await postgres.close();
    },
    async getResults() {
      await store.init();
      return active.getResults();
    },
    async saveResult(record) {
      await store.init();
      return active.saveResult(record);
    },
    async deleteResult(pairingId) {
      await store.init();
      return active.deleteResult(pairingId);
    },
    async getRoster() {
      await store.init();
      return active.getRoster();
    },
    async saveRoster(players) {
      await store.init();
      return active.saveRoster(players);
    }
  };

  return store;
}

module.exports = { createStore };
