'use strict';

// Wonderland Trail tracker API (Express).
//
// Endpoints:
//   GET  /api/location/current        latest ping + age + feed health
//   GET  /api/location/recent?hours=  breadcrumb of recent pings
//   POST /admin/upload                token-protected photo upload (multipart)
//   GET  /api/photos                  photo list for the strip
//   GET  /api/health                  trivial liveness check (for DEPLOY curl)
// Static:
//   /photos/<file>                    uploaded photos
//
// Config via environment (see deploy/tracker-api.service):
//   PORT                default 8787
//   ADMIN_UPLOAD_TOKEN  required for uploads (no default — uploads 401 without it)
//   TRACKER_DB_PATH     default ../data/locations.db
//   PHOTO_DIR           default ../data/photos
//   CORS_ORIGIN         default https://cslester.com

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const exifr = require('exifr');

const db = require('./db');

// sharp handles EXIF rotation, resizing, and HEIC->JPEG. It's the recommended
// path but depends on libvips/libheif being present. Load it defensively so the
// API still boots (and falls back to storing raw bytes) if it's unavailable.
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.warn(
    '[startup] sharp not available — photos will be stored as-is, no HEIC->JPEG conversion'
  );
}

// 8788, not 8787 — 8787 is already taken on wavebeam (RStudio Server).
const PORT = parseInt(process.env.PORT, 10) || 8788;
const ADMIN_TOKEN = process.env.ADMIN_UPLOAD_TOKEN || '';
const PHOTO_DIR =
  process.env.PHOTO_DIR || path.join(__dirname, '..', 'data', 'photos');
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'https://cslester.com';
const FEED_HEALTHY_MAX_AGE_S = 30 * 60; // feed_healthy=false if no poll success in 30 min
const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB — generous for phone photos

fs.mkdirSync(PHOTO_DIR, { recursive: true });

if (!ADMIN_TOKEN) {
  console.warn(
    '[startup] ADMIN_UPLOAD_TOKEN is not set — /admin/upload will reject every request'
  );
}

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: CORS_ORIGIN }));

// Photos are content-addressed (uuid filenames), so they're safe to cache hard.
app.use(
  '/photos',
  express.static(PHOTO_DIR, { maxAge: '7d', immutable: true })
);

// --- Prepared statements -----------------------------------------------------
const qLatest = db.prepare(
  'SELECT timestamp, lat, lon, elevation_m FROM locations ORDER BY timestamp DESC LIMIT 1'
);
const qStatus = db.prepare('SELECT last_success_utc FROM poll_status WHERE id = 1');
const qRecent = db.prepare(
  'SELECT timestamp, lat, lon, elevation_m FROM locations WHERE timestamp >= ? ORDER BY timestamp ASC'
);
// All pings (the trip is ~20–80 rows total) — used to place a photo at the ping
// closest in time to when it was taken.
const qAllLocs = db.prepare('SELECT lat, lon, timestamp FROM locations');
// Sort by captured_at (when the photo was taken). COALESCE handles older rows
// that predate the captured_at column (fall back to upload time).
const qPhotos = db.prepare(
  'SELECT id, filename, caption, uploaded_at, ' +
    'COALESCE(captured_at, uploaded_at) AS captured_at, associated_lat, associated_lon ' +
    'FROM photos ORDER BY COALESCE(captured_at, uploaded_at) DESC LIMIT 50'
);
const qInsertPhoto = db.prepare(
  'INSERT INTO photos ' +
    '(filename, original_filename, caption, captured_at, associated_lat, associated_lon, file_size_bytes) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
);

// Route region anchors for the EXIF-GPS sanity check. These are the 9 itinerary
// points (8 camps + Longmire trailhead). We accept EXIF coordinates only if
// they're within GEO_NEAR_ROUTE_MI of one of these. At a 50-mile tolerance this
// is indistinguishable from checking every dense GPX trackpoint (the route is
// never close to 50 mi from a camp), and it avoids depending on trail.gpx being
// present on the API host (it ships in public/, deployed separately).
// Keep in sync with the ITINERARY/TRAILHEAD coordinates in tracker.js.
const ROUTE_ANCHORS = [
  [46.74974, -121.81235], // Longmire (trailhead/exit)
  [46.78196, -121.83297], [46.83571, -121.87753], [46.91147, -121.89313],
  [46.95063, -121.79990], [46.91570, -121.75044], [46.91129, -121.66002],
  [46.86617, -121.65843], [46.77204, -121.62402],
];
const GEO_NEAR_ROUTE_MI = 50;

// A photo is placed at the ping closest in time to when it was taken, as long as
// that ping is within this many hours of the photo's capture time. Pings arrive
// continuously over satellite, so by upload time the capture-time position is
// usually already recorded. Beyond this window (e.g. last year's photos, or a
// long satellite gap) we don't guess a location. Override via env.
const PHOTO_TIME_MATCH_MS =
  (parseFloat(process.env.PHOTO_TIME_MATCH_HOURS) || 6) * 3600 * 1000;

// --- Helpers -----------------------------------------------------------------
function isFeedHealthy(lastSuccessUtc) {
  if (!lastSuccessUtc) return false;
  const ageS = (Date.now() - Date.parse(lastSuccessUtc)) / 1000;
  return Number.isFinite(ageS) && ageS <= FEED_HEALTHY_MAX_AGE_S;
}

function cutoffIso(hours) {
  const d = new Date(Date.now() - hours * 3600 * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); // match stored "...:00Z" form
}

function toIso(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.7613; // earth radius in miles
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearRoute(lat, lon) {
  return ROUTE_ANCHORS.some(
    ([rlat, rlon]) => haversineMi(lat, lon, rlat, rlon) <= GEO_NEAR_ROUTE_MI
  );
}

// Pull capture time + GPS from image EXIF. Works on JPEG and HEIC (exifr reads
// HEIC metadata even when sharp can't decode the pixels). Never throws.
async function readExif(buffer) {
  let capturedAt = null;
  let gps = null;
  try {
    const meta = await exifr.parse(buffer, ['DateTimeOriginal', 'CreateDate']);
    const dt = meta && (meta.DateTimeOriginal || meta.CreateDate);
    if (dt instanceof Date && !isNaN(dt.getTime())) capturedAt = toIso(dt);
  } catch (e) {
    console.warn('[upload] EXIF date parse failed:', e.message);
  }
  try {
    const g = await exifr.gps(buffer);
    if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
      gps = { lat: g.latitude, lon: g.longitude };
    }
  } catch (e) {
    console.warn('[upload] EXIF gps parse failed:', e.message);
  }
  return { capturedAt, gps };
}

// Find the location ping closest in time to `iso`, but only if it's within
// PHOTO_TIME_MATCH_MS. Returns { lat, lon } or null. With ≤ ~80 rows a linear
// scan in JS is trivial and sidesteps any SQLite date-format quirks.
function nearestPingByTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const r of qAllLocs.all()) {
    const diff = Math.abs(Date.parse(r.timestamp) - t);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best && bestDiff <= PHOTO_TIME_MATCH_MS ? { lat: best.lat, lon: best.lon } : null;
}

// --- Routes ------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/location/current', (req, res) => {
  const row = qLatest.get();
  const status = qStatus.get();
  const feedHealthy = isFeedHealthy(status && status.last_success_utc);

  res.set('Cache-Control', 'public, max-age=60');

  if (!row) {
    return res.json({
      timestamp: null,
      lat: null,
      lon: null,
      elevation_m: null,
      age_seconds: null,
      feed_healthy: feedHealthy,
    });
  }

  const ageSeconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(row.timestamp)) / 1000)
  );
  res.json({
    timestamp: row.timestamp,
    lat: row.lat,
    lon: row.lon,
    elevation_m: row.elevation_m,
    age_seconds: ageSeconds,
    feed_healthy: feedHealthy,
  });
});

app.get('/api/location/recent', (req, res) => {
  let hours = parseInt(req.query.hours, 10);
  if (!Number.isFinite(hours) || hours <= 0) hours = 24;
  hours = Math.min(hours, 24 * 14); // clamp to two weeks

  const rows = qRecent.all(cutoffIso(hours));
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ count: rows.length, locations: rows });
});

app.get('/api/photos', (req, res) => {
  const rows = qPhotos.all();
  const photos = rows.map((r) => ({
    id: r.id,
    url: `/photos/${r.filename}`,
    caption: r.caption,
    uploaded_at: r.uploaded_at,
    captured_at: r.captured_at,
    associated_lat: r.associated_lat,
    associated_lon: r.associated_lon,
  }));
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ count: photos.length, photos });
});

// --- Photo upload ------------------------------------------------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

function requireAdmin(req, res, next) {
  const auth = req.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : '';
  // Constant-time-ish compare; both sides non-empty. If no token is configured,
  // reject everything (fail closed).
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/admin/upload', requireAdmin, upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no "photo" field in request' });

  const id = crypto.randomUUID();
  const caption =
    req.body && typeof req.body.caption === 'string'
      ? req.body.caption.slice(0, 500)
      : null;

  // Read EXIF from the ORIGINAL bytes (before any sharp conversion strips it).
  const { capturedAt, gps } = await readExif(req.file.buffer);
  // captured_at: EXIF capture time, else fall back to upload time.
  const capturedAtValue = capturedAt || toIso(Date.now());

  // Place the photo where it was TAKEN, not where it was uploaded:
  //   1. EXIF GPS, if present and plausibly on the route (exact).
  //   2. else the ping closest in time to capture (within PHOTO_TIME_MATCH_MS).
  //   3. else no location (better than pinning it to wherever you had signal).
  let assocLat = null;
  let assocLon = null;
  let gpsSource = 'none';
  if (gps && nearRoute(gps.lat, gps.lon)) {
    assocLat = gps.lat;
    assocLon = gps.lon;
    gpsSource = 'exif';
  } else {
    if (gps) {
      console.warn(`[upload] EXIF GPS ${gps.lat},${gps.lon} is >50 mi from route — ignoring`);
    }
    const match = nearestPingByTime(capturedAtValue);
    if (match) {
      assocLat = match.lat;
      assocLon = match.lon;
      gpsSource = 'time-match';
    }
  }
  console.log(`[upload] captured_at=${capturedAtValue} placement=${gpsSource}`);

  // Try the nice path: normalize to a right-sized, EXIF-rotated JPEG.
  try {
    const filename = `${id}.jpg`;
    let outBuf = req.file.buffer;
    if (sharp) {
      outBuf = await sharp(req.file.buffer)
        .rotate() // honor EXIF orientation from phones
        .resize({ width: 2000, height: 2000, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    }
    fs.writeFileSync(path.join(PHOTO_DIR, filename), outBuf);

    const info = qInsertPhoto.run(
      filename,
      req.file.originalname || null,
      caption,
      capturedAtValue,
      assocLat,
      assocLon,
      outBuf.length
    );
    return res.json({
      id: info.lastInsertRowid,
      url: `/photos/${filename}`,
      gps_source: gpsSource,
      associated_lat: assocLat,
      associated_lon: assocLon,
    });
  } catch (err) {
    // Most likely sharp couldn't decode a HEIC on this box (no libheif).
    // Fall back to storing the original bytes so the upload still succeeds.
    console.error('[upload] conversion failed, storing raw:', err.message);
    try {
      const ext = path.extname(req.file.originalname || '').toLowerCase() || '.bin';
      const filename = `${id}${ext}`;
      fs.writeFileSync(path.join(PHOTO_DIR, filename), req.file.buffer);
      const info = qInsertPhoto.run(
        filename,
        req.file.originalname || null,
        caption,
        capturedAtValue,
        assocLat,
        assocLon,
        req.file.buffer.length
      );
      return res.json({
        id: info.lastInsertRowid,
        url: `/photos/${filename}`,
        gps_source: gpsSource,
        associated_lat: assocLat,
        associated_lon: assocLon,
        warning: 'stored without conversion (HEIC may not display in non-Safari browsers)',
      });
    } catch (err2) {
      console.error('[upload] raw fallback failed:', err2.message);
      return res.status(500).json({ error: 'upload failed' });
    }
  }
});

// Multer errors (e.g. file too large) arrive here.
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'file too large (max 30 MB)' });
  }
  console.error('[error]', err && err.message);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`tracker-api listening on :${PORT} (CORS origin: ${CORS_ORIGIN})`);
});
