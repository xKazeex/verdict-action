'use strict';

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'nonce-ledger.db');

// SQLite UNIQUE-violation codes vary by driver version; match on the SQLite result
// code family rather than the (less stable) error message text.
function isUniqueViolation(err) {
  return err && (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT');
}

/**
 * Single-writer, single-instance nonce ledger for exact-EVM payment authorizations.
 * Not built for multi-instance coordination -- see DEBUG_LOG.md for why that's out of
 * scope for this deployment.
 */
function createNonceLedger(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS consumed_authorizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      network TEXT NOT NULL,
      payer TEXT NOT NULL,
      nonce TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'failed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (network, payer, nonce)
    );
  `);

  const insertPending = db.prepare(`
    INSERT INTO consumed_authorizations (network, payer, nonce, status, created_at, updated_at)
    VALUES (@network, @payer, @nonce, 'pending', @now, @now)
  `);
  const updateStatus = db.prepare(`
    UPDATE consumed_authorizations SET status = @status, updated_at = @now
    WHERE network = @network AND payer = @payer AND nonce = @nonce
  `);
  const getRow = db.prepare(`
    SELECT * FROM consumed_authorizations WHERE network = @network AND payer = @payer AND nonce = @nonce
  `);

  function normalize(network, payer, nonce) {
    return { network, payer: String(payer).toLowerCase(), nonce: String(nonce).toLowerCase() };
  }

  return {
    /**
     * Atomically reserves (network, payer, nonce) as 'pending'.
     * Returns { reserved: true } on success, { reserved: false, reason } if it was
     * already seen, or { reserved: false, reason: 'ledger_error' } if the insert itself
     * failed for an unexpected reason (fail CLOSED on that -- if we can't prove
     * uniqueness, we don't let the payment through).
     */
    reserve(network, payer, nonce) {
      const key = normalize(network, payer, nonce);
      const now = new Date().toISOString();
      try {
        insertPending.run({ ...key, now });
        return { reserved: true };
      } catch (err) {
        if (isUniqueViolation(err)) {
          return { reserved: false, reason: 'duplicate_authorization_nonce' };
        }
        return { reserved: false, reason: 'ledger_error', error: err };
      }
    },
    markSettled(network, payer, nonce) {
      const key = normalize(network, payer, nonce);
      updateStatus.run({ ...key, status: 'settled', now: new Date().toISOString() });
    },
    markFailed(network, payer, nonce) {
      const key = normalize(network, payer, nonce);
      updateStatus.run({ ...key, status: 'failed', now: new Date().toISOString() });
    },
    getStatus(network, payer, nonce) {
      const key = normalize(network, payer, nonce);
      const row = getRow.get(key);
      return row ? row.status : undefined;
    },
    close() {
      db.close();
    }
  };
}

module.exports = { createNonceLedger, DEFAULT_DB_PATH };
