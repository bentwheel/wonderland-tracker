#!/usr/bin/env python3
"""
poll_mapshare.py — Wonderland Trail location poller.

Fetches the public Garmin MapShare KML feed, parses each <Placemark>, and
inserts new location pings into the SQLite `locations` table.

Design notes (see project brief):
  * PRIVACY: the "Text:" field inside a Placemark's <description> is NEVER read
    or stored. Those are message conversations with specific people. We only
    ever read the <when> timestamp and the <coordinates> (lon,lat,elev).
  * IDEMPOTENT: dedupe on the UNIQUE(timestamp) constraint. Re-running is safe.
  * RESILIENT: every failure mode (network error, 5xx, empty body, malformed
    XML, missing fields) is logged and swallowed. The poller must never crash
    the cron slot. Quiet success is the norm.
  * HEALTH: on every successful fetch+parse we stamp `poll_status` so the API
    can compute `feed_healthy` (false if no success in >30 min).

Run from cron every 15 minutes. See ../deploy/poller.cron.

Configuration (all via environment variables):
  MAPSHARE_FEED_URL  default https://share.garmin.com/Feed/Share/cslester
  TRACKER_DB_PATH    default ../data/locations.db (relative to this file)
  MAPSHARE_TIMEOUT   default 30 (seconds)
"""

import logging
import os
import sqlite3
import sys
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

import requests

# --- Configuration -----------------------------------------------------------
FEED_URL = os.environ.get(
    "MAPSHARE_FEED_URL", "https://share.garmin.com/Feed/Share/cslester"
)
_DEFAULT_DB = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "data", "locations.db"
)
DB_PATH = os.environ.get("TRACKER_DB_PATH", _DEFAULT_DB)
HTTP_TIMEOUT = int(os.environ.get("MAPSHARE_TIMEOUT", "30"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s poll_mapshare %(levelname)s %(message)s",
)
log = logging.getLogger("poll_mapshare")


# --- XML helpers -------------------------------------------------------------
def local_name(tag):
    """Return an XML tag without its {namespace} prefix.

    Garmin's KML declares the default kml namespace, so every tag arrives as
    e.g. '{http://www.opengis.net/kml/2.2}Placemark'. We match on local names
    so the parser is namespace-agnostic and survives feed quirks.
    """
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def normalize_timestamp(when):
    """Normalize a KML <when> value to ISO-8601 UTC, e.g. 2026-06-27T10:30:00Z.

    Returns None if the value can't be parsed.
    """
    try:
        cleaned = when.strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)
        return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, AttributeError):
        return None


def parse_placemarks(kml_text):
    """Parse KML text into a list of (timestamp_iso, lat, lon, elevation_m).

    We deliberately ignore each Placemark's <description> CDATA entirely — that
    is where the privacy-sensitive "Text:" message lives. We only read <when>
    (from <TimeStamp>) and <coordinates> (from <Point>).

    Raises xml.etree.ElementTree.ParseError on malformed XML (caller logs it).
    """
    pings = []
    root = ET.fromstring(kml_text)

    for placemark in root.iter():
        if local_name(placemark.tag) != "Placemark":
            continue

        when = None
        coords = None
        # Look only at the timestamp and point inside this Placemark. We never
        # touch <description>, so the message text cannot leak in.
        for child in placemark.iter():
            name = local_name(child.tag)
            if name == "when" and child.text:
                when = child.text.strip()
            elif name == "coordinates" and child.text:
                coords = child.text.strip()

        if not when or not coords:
            # MapShare also emits a track <LineString> Placemark and sometimes
            # entries without a fix. Skip anything missing time or coordinates.
            continue

        # <coordinates> is "lon,lat[,elev_meters]"
        parts = coords.split(",")
        if len(parts) < 2:
            log.warning("Skipping placemark with unparseable coordinates: %r", coords)
            continue
        try:
            lon = float(parts[0])
            lat = float(parts[1])
            elev_m = float(parts[2]) if len(parts) >= 3 and parts[2] != "" else None
        except ValueError:
            log.warning("Skipping placemark with non-numeric coordinates: %r", coords)
            continue

        ts = normalize_timestamp(when)
        if ts is None:
            log.warning("Skipping placemark with unparseable timestamp: %r", when)
            continue

        pings.append((ts, lat, lon, elev_m))

    return pings


# --- HTTP --------------------------------------------------------------------
def fetch_feed(url):
    """GET the KML feed. Returns response text. Raises requests.RequestException."""
    resp = requests.get(
        url,
        timeout=HTTP_TIMEOUT,
        headers={"User-Agent": "wonderland-tracker/1.0"},
    )
    resp.raise_for_status()
    return resp.text


# --- Storage -----------------------------------------------------------------
def ensure_schema(conn):
    """Create the tables the poller needs if they don't exist yet.

    Kept in sync with api/schema.sql. Both are idempotent so it doesn't matter
    whether the poller or the API runs first.
    """
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS locations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            elevation_m REAL,
            inserted_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(timestamp)
        );
        CREATE INDEX IF NOT EXISTS idx_locations_timestamp ON locations(timestamp DESC);

        CREATE TABLE IF NOT EXISTS poll_status (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_success_utc TEXT,
            last_attempt_utc TEXT,
            last_error TEXT
        );
        INSERT OR IGNORE INTO poll_status (id) VALUES (1);
        """
    )
    conn.commit()


def record_status(conn, success, error=None):
    """Stamp poll_status so the API can compute feed_healthy."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if success:
        conn.execute(
            "UPDATE poll_status SET last_success_utc=?, last_attempt_utc=?, "
            "last_error=NULL WHERE id=1",
            (now, now),
        )
    else:
        conn.execute(
            "UPDATE poll_status SET last_attempt_utc=?, last_error=? WHERE id=1",
            (now, str(error)[:500]),
        )
    conn.commit()


def insert_pings(conn, pings):
    """Insert pings, skipping any whose timestamp already exists. Returns count."""
    inserted = 0
    for ts, lat, lon, elev_m in pings:
        cur = conn.execute(
            "INSERT OR IGNORE INTO locations (timestamp, lat, lon, elevation_m) "
            "VALUES (?, ?, ?, ?)",
            (ts, lat, lon, elev_m),
        )
        if cur.rowcount > 0:
            inserted += 1
    conn.commit()
    return inserted


# --- Entry point -------------------------------------------------------------
def main():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    try:
        try:
            ensure_schema(conn)
        except sqlite3.Error as e:
            log.error("DB schema init failed: %s", e)
            return 1

        try:
            kml = fetch_feed(FEED_URL)
        except requests.RequestException as e:
            # Network error or 5xx. Not a crash — cron will retry in 15 min.
            log.error("Feed fetch failed: %s", e)
            record_status(conn, success=False, error=e)
            return 0

        if not kml or not kml.strip():
            log.warning("Feed returned an empty body")
            record_status(conn, success=False, error="empty feed body")
            return 0

        try:
            pings = parse_placemarks(kml)
        except ET.ParseError as e:
            log.error("Malformed XML in feed: %s", e)
            record_status(conn, success=False, error=e)
            return 0

        inserted = insert_pings(conn, pings)
        # A successful fetch+parse is "healthy" even with 0 new rows (no
        # movement, or every ping already seen).
        record_status(conn, success=True)
        if inserted:
            log.info("Inserted %d new ping(s) (%d parsed)", inserted, len(pings))
        else:
            log.info("No new pings (%d parsed)", len(pings))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
