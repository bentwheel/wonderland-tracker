-- Wonderland Trail tracker — SQLite schema.
-- Idempotent: safe to apply repeatedly (used by both the API on boot and the
-- standalone migrate.js). Kept in sync with the inline schema in poll_mapshare.py.

CREATE TABLE IF NOT EXISTS locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,          -- ISO 8601 UTC, e.g. 2026-06-27T10:30:00Z
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    elevation_m REAL,
    inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(timestamp)
);

CREATE INDEX IF NOT EXISTS idx_locations_timestamp ON locations(timestamp DESC);

CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_filename TEXT,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),  -- when the server received it
    captured_at TEXT,                  -- from EXIF DateTimeOriginal; falls back to upload time
    caption TEXT,                      -- optional, provided at upload time
    associated_lat REAL,               -- EXIF GPS (if near route) else most recent ping
    associated_lon REAL,
    file_size_bytes INTEGER
);

CREATE INDEX IF NOT EXISTS idx_photos_uploaded ON photos(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_photos_captured ON photos(captured_at DESC);

-- Single-row table the poller stamps after each run so the API can report
-- feed_healthy (false when no successful fetch in >30 min).
CREATE TABLE IF NOT EXISTS poll_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_success_utc TEXT,
    last_attempt_utc TEXT,
    last_error TEXT
);
INSERT OR IGNORE INTO poll_status (id) VALUES (1);
