'use strict';

// Database handle shared across the API. Opening this module:
//   1. ensures the data directory exists,
//   2. opens (or creates) the SQLite file,
//   3. applies schema.sql (idempotent), so the API can self-initialize.
//
// The poller (Python) and the API (Node) both open the same file. WAL mode lets
// the API keep reading while the cron poller writes.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH =
  process.env.TRACKER_DB_PATH ||
  path.join(__dirname, '..', 'data', 'locations.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // wait up to 5s if the poller holds a write lock

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight column migrations for DBs created before a column existed.
// SQLite has no "ADD COLUMN IF NOT EXISTS", so we check table_info first.
// Idempotent: safe to run on every boot.
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[migrate] added ${table}.${column}`);
  }
}
addColumnIfMissing('photos', 'captured_at', 'TEXT');

// Index on captured_at lives here (not in schema.sql) so it runs AFTER the
// column is guaranteed to exist — including on a v1 upgrade where the column
// was just added by the migration above.
db.exec('CREATE INDEX IF NOT EXISTS idx_photos_captured ON photos(captured_at DESC)');

module.exports = db;
