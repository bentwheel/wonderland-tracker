# Wonderland Trail Live Tracker

A public live-location tracker for Cameron's Wonderland Trail thru-hike
(Mount Rainier, **June 27 – July 5, 2026**), published at
`cslester.com/wonderland-2026`.

Data flows: Garmin inReach → MapShare KML feed → a cron poller on wavebeam →
SQLite → an Express API → a Leaflet frontend that polls every 5 minutes.

```
inReach Messenger Plus ─► Garmin satellites ─► MapShare KML feed (public)
                                                        │
                              (wavebeam cron: poll every 15 min) poll_mapshare.py
                                                        │
                                            SQLite: locations + photos
                                                        │
                                       Node/Express API (server.js)
                                                        │
                                  cslester.com/wonderland-2026 (Leaflet, polls 5 min)
```

## Layout

| Path | What |
|---|---|
| `poller/poll_mapshare.py` | Cron worker: fetch KML, parse, dedupe, insert. **Never stores message text.** |
| `poller/requirements.txt` | Python deps (`requests`). |
| `api/server.js` | Express API — 4 endpoints + static `/photos`. |
| `api/db.js` | Opens SQLite, applies schema (WAL mode). |
| `api/schema.sql` | Tables: `locations`, `photos`, `poll_status`. |
| `api/migrate.js` | Idempotent schema apply (`node migrate.js`). |
| `api/.env.example` | Template for the secrets file. |
| `public/wonderland-2026/index.html` | The tracker page. |
| `public/wonderland-2026/tracker.js` | Map, polling, snap-to-route, progress, photos, failure UI. |
| `public/wonderland-2026/tracker.css` | Styles (incl. pulsing marker). |
| `public/wonderland-2026/trail.gpx` | Real Gaia export (~6,200 route points). Falls back to a camp-stub if absent. |
| `public/wonderland-2026/admin/index.html` | Ugly-but-functional phone upload form. |
| `deploy/` | systemd unit, cron, nginx snippet, `verify.sh`, `DEPLOY.md`. |
| `data/` | Runtime DB + photos (gitignored). |

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/location/current` | Latest ping + `age_seconds` + `feed_healthy`. |
| GET | `/api/location/recent?hours=24` | Breadcrumb of recent pings. |
| POST | `/admin/upload` | Token-protected photo upload (multipart). |
| GET | `/api/photos` | Photo list for the strip. |
| GET | `/api/health` | Liveness check. |

## Run locally (for inspection before deploy)

```bash
# API
cd api
npm install
node migrate.js
ADMIN_UPLOAD_TOKEN=dev-token CORS_ORIGIN=http://localhost:8080 node server.js
# -> tracker-api listening on :8788

# Poller (one shot; hits the live MapShare feed)
cd ../poller
python3 -m venv venv && ./venv/bin/pip install -r requirements.txt
TRACKER_DB_PATH=../data/locations.db ./venv/bin/python poll_mapshare.py

# Frontend: serve public/ statically, e.g.
cd ../public && python3 -m http.server 8080
# then open http://localhost:8080/wonderland-2026/
# (set CONFIG.API_BASE = 'http://localhost:8788' in tracker.js for cross-origin local dev)
```

## Deployment

Server deployment is performed by Cicero on wavebeam following
[`deploy/DEPLOY.md`](deploy/DEPLOY.md). **This build stops short of deployment**
— nothing here touches the server.

## Design decisions worth knowing

- **Privacy:** the poller reads only `<when>` and `<coordinates>` from each KML
  Placemark. The `Text:` message field is never parsed, so it can't leak into
  the DB. (Brief design principle #4.)
- **Feed health:** the poller stamps a `poll_status` row on every run; the API
  reports `feed_healthy=false` if there's been no successful poll in >30 min.
- **Progress / snap-to-route** runs in the browser on each poll against the real
  GPX. The Gaia route measures ~85.7 mi (smoothed centerline), so the frontend
  uses that as the percentage denominator (bar completes at the finish) while
  scaling the *displayed* mileage to the 94.1-mi headline. If `trail.gpx` is
  missing it falls back to a camp-stub and shows "Awaiting trail data".
- **Max-progress latch:** progress is kept in `localStorage` (`maxProgressMi`) so
  the bar never jumps backward when a ping snaps to the wrong lobe of the loop.
- **API base URL:** `CONFIG.API_BASE` is `''` (same-origin) by default, assuming
  the nginx proxy. Set it if the API is on a different host. See OPEN QUESTIONS
  in DEPLOY.md.

## Known limitations / open items

- API listens on **8788** (8787 is taken by RStudio Server on wavebeam).
- HEIC conversion depends on `sharp` building with libheif on wavebeam; the API
  falls back to storing raw bytes if it can't convert.
- "Approximate location" is derived from the nearest camp, not named trail
  features — good enough for MVP, no POI dataset wired in.
- "Highest point today" is the max elevation among today's pings, not a named
  summit.
