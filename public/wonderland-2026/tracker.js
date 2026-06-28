/* Wonderland Trail tracker — frontend logic.
 *
 * Responsibilities:
 *   - Draw the Leaflet map: USGS topo basemap, trail polyline (from trail.gpx),
 *     8 camp markers, a red "route traversed" fill, pulsing current-position marker.
 *   - Poll the API every 5 min for current location, recent breadcrumb, photos.
 *   - Snap the current ping to the trail to compute % progress + elevation gained.
 *   - Render the status panel, progress bar, fast facts, and failure-mode UI.
 *
 * No framework, no build step. Plain ES2017+ in one file. Comments are intentionally
 * thorough because this gets debugged on a phone over LTE.
 */

'use strict';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG = {
  // Where the API lives.
  //  - '' (empty) => same-origin relative URLs (/api/...). Use this when the
  //    nginx snippet reverse-proxies /api, /admin, /photos to the Node service
  //    on the same domain as this page. THIS IS THE DEFAULT and the simplest.
  //  - Otherwise set the API's full origin, e.g. 'https://wavebeam.example.net'
  //    (and the API's CORS_ORIGIN must allow this page's origin).
  API_BASE: '',
  POLL_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
  TRAIL_TOTAL_MI: 94.1,
  TRAIL_TOTAL_GAIN_FT: 27154,
  OFF_ROUTE_THRESHOLD_MI: 0.3,
  // The Wonderland is a loop: the trailhead is ~0 mi from BOTH mile 0 and the
  // mile-~85 finish, so a pure nearest-vertex snap is ambiguous there (and at
  // any spot the trail nearly touches itself). When we know roughly where we
  // already are, we add a tiny continuity cost (cost-miles per along-route mile
  // of deviation) to break those ties toward the lobe we're actually on. Kept
  // small so it only decides near-ties, never overriding real geographic
  // closeness.
  SNAP_CONTINUITY_W: 0.005,
  // Bump when the progress-computation logic changes. On load, a mismatch with
  // the stored 'progressSchema' clears the localStorage high-water mark so every
  // viewer drops any stale/poisoned latch (e.g. a bogus 100% snapped at the
  // trailhead) without a server change or any data being touched.
  PROGRESS_SCHEMA: '2',
  BREADCRUMB_HOURS: 48,
  // Trip window (America/Los_Angeles calendar dates, inclusive). Drives the
  // pre-trip / active / post-trip UI states.
  TRIP_START_KEY: '2026-06-27',
  TRIP_END_KEY: '2026-07-05',
  // Geofence for test pings sent outside the trip window: if a ping is farther
  // than this from any GPX point, we don't snap it — we flag it as a test ping.
  GEOFENCE_TEST_MI: 5,
  // A real Gaia export has thousands of trackpoints. The stub trail.gpx (camps
  // connected linearly) has only a handful. If we load fewer than this, we treat
  // the route as a stub and disable progress/elevation numbers (show 0% / —).
  MIN_REAL_ROUTE_POINTS: 50,
  TZ: 'America/Los_Angeles',
};

// Hardcoded itinerary, keyed by America/Los_Angeles calendar date.
// Coordinates extracted from Gaia GPS (visualization-grade).
const ITINERARY = {
  '2026-06-27': { day: 1, camp: "Devil's Dream",   lat: 46.78196, lon: -121.83297 },
  '2026-06-28': { day: 2, camp: 'Klapatche Park',   lat: 46.83571, lon: -121.87753 },
  '2026-06-29': { day: 3, camp: 'S. Mowich River',  lat: 46.91147, lon: -121.89313 },
  '2026-06-30': { day: 4, camp: 'Carbon River',     lat: 46.95063, lon: -121.79990 },
  '2026-07-01': { day: 5, camp: 'Mystic',           lat: 46.91570, lon: -121.75044 },
  '2026-07-02': { day: 6, camp: 'Sunrise Camp',     lat: 46.91129, lon: -121.66002 },
  '2026-07-03': { day: 7, camp: 'Summerland',       lat: 46.86617, lon: -121.65843 },
  '2026-07-04': { day: 8, camp: 'Nickel Creek',     lat: 46.77204, lon: -121.62402 },
  '2026-07-05': { day: 9, camp: 'Longmire (exit)',  lat: 46.74974, lon: -121.81235 },
};
const TOTAL_DAYS = 9;

// Longmire is both the start (day 1) and the finish (day 9 exit). Single source
// of truth for the trailhead marker and the stub route's start point.
const TRAILHEAD = { lat: 46.74974, lon: -121.81235 };

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------
const MI_PER_M = 1 / 1609.344;
const FT_PER_M = 3.280839895;

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const meters = 2 * R * Math.asin(Math.sqrt(a));
  return meters * MI_PER_M;
}

// ---------------------------------------------------------------------------
// Date / time helpers (all "today" logic is in America/Los_Angeles)
// ---------------------------------------------------------------------------
function laDateKey(date) {
  // en-CA gives YYYY-MM-DD; timeZone pins it to Pacific.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function laClockTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.TZ,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

function laLongDate(dateKey) {
  // dateKey is 'YYYY-MM-DD'; render as "Tue Jun 30, 2026" without TZ drift by
  // treating it as a noon-UTC instant (safe for date-only display).
  const d = new Date(dateKey + 'T12:00:00Z');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CONFIG.TZ,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(d);
}

function relativeTime(seconds) {
  if (seconds == null) return 'unknown';
  const m = Math.round(seconds / 60);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h} hr ${rem} min ago` : `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function relativeFromIso(iso) {
  const secs = (Date.now() - Date.parse(iso)) / 1000;
  return relativeTime(secs);
}

// ---------------------------------------------------------------------------
// Trip phase (pre-trip / active / post-trip) — by America/Los_Angeles date
// ---------------------------------------------------------------------------
// 'YYYY-MM-DD' keys compare correctly as plain strings, so no Date math needed.
function tripPhase(todayKey) {
  if (todayKey < CONFIG.TRIP_START_KEY) return 'pre';
  if (todayKey > CONFIG.TRIP_END_KEY) return 'post';
  return 'active';
}

// Whole days from one 'YYYY-MM-DD' key to another (treated as UTC midnights).
function daysBetween(fromKey, toKey) {
  const a = Date.parse(fromKey + 'T00:00:00Z');
  const b = Date.parse(toKey + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------
// Frame the map on the Wonderland route's extent right away (instead of a
// hardcoded center/zoom that then animated when the GPX loaded). These are the
// trail.gpx bounding box, rounded slightly OUTWARD so the initial fit is never
// tighter than the GPX — otherwise the post-load fit would have to zoom out.
// loadTrail() re-fits to the actual GPX bounds once loaded: for the real route
// that's the identical framing (no visible change); for a different GPX (e.g.
// the St Helens test) it snaps cleanly into place. animate:false avoids any
// animated two-step.
const DEFAULT_BOUNDS = L.latLngBounds([[46.7519, -121.9127], [46.9716, -121.6050]]);
const FIT_OPTS = { padding: [20, 20], animate: false };
const map = L.map('map');
map.fitBounds(DEFAULT_BOUNDS, FIT_OPTS);

// USGS Topo — free, no API key, accurate for backcountry.
// TODO: swap to Mapbox Outdoors here for a more polished look (needs an API key).
L.tileLayer(
  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'USGS National Map', maxZoom: 16 }
).addTo(map);

// Layer handles populated later.
let progressLayer = L.layerGroup().addTo(map); // red "route traversed" overlay
let photoMarkersLayer = L.layerGroup().addTo(map);
let currentMarker = null;
let routePoints = []; // [{ lat, lon, elev, cumDistMi, cumGainFt }]
let routeIsStub = true;
// Measured length/gain of the loaded GPX. The Gaia route is a smoothed centerline
// that measures shorter than the official 94.1 mi, so we use these GPX-measured
// totals as the true denominators (the bar reaches 100% at the finish) and scale
// the *displayed* mileage back up to the 94.1 headline. Default to the nominal
// figures until a real GPX loads.
let routeTotalMi = CONFIG.TRAIL_TOTAL_MI;
let routeTotalGainFt = CONFIG.TRAIL_TOTAL_GAIN_FT;

// Camp markers from the itinerary (skip day 9 — it's the Longmire exit, same as
// the trailhead; drawing it as a "camp" would be misleading). 8 numbered camps.
function drawCamps() {
  Object.keys(ITINERARY).forEach((key) => {
    const it = ITINERARY[key];
    if (it.day >= TOTAL_DAYS) return; // exit, not a camp
    const icon = L.divIcon({
      className: '',
      html: `<div class="camp-marker">${it.day}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    L.marker([it.lat, it.lon], { icon })
      .addTo(map)
      .bindPopup(`<strong>Night ${it.day}: ${it.camp}</strong><br>${laLongDate(key)}`);
  });
}

// Checkered-flag marker at Longmire marking the start/finish of the loop.
function drawTrailhead() {
  const icon = L.divIcon({
    className: '',
    html: '<div class="trailhead-marker">🏁</div>',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
  L.marker([TRAILHEAD.lat, TRAILHEAD.lon], { icon, zIndexOffset: 500 })
    .addTo(map)
    .bindPopup('<strong>Longmire</strong><br>Trailhead — start &amp; finish');
}

// ---------------------------------------------------------------------------
// Trail (GPX) loading
// ---------------------------------------------------------------------------
async function loadTrail() {
  try {
    const resp = await fetch('trail.gpx', { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`trail.gpx HTTP ${resp.status}`);
    const text = await resp.text();
    routePoints = parseGpxToRoutePoints(text);
  } catch (e) {
    console.warn('Could not load trail.gpx, falling back to linear camp stub:', e.message);
    routePoints = stubRouteFromCamps();
  }

  routeIsStub = routePoints.length < CONFIG.MIN_REAL_ROUTE_POINTS;

  // Use the GPX's own measured totals as denominators (so the bar completes).
  if (!routeIsStub) {
    const last = routePoints[routePoints.length - 1];
    if (last && last.cumDistMi > 0) {
      routeTotalMi = last.cumDistMi;
      routeTotalGainFt = last.cumGainFt;
    }
  }

  if (routePoints.length >= 2) {
    const latlngs = routePoints.map((p) => [p.lat, p.lon]);
    const line = L.polyline(latlngs, {
      color: CONFIG.TRIP_COLOR || '#2874a6',
      weight: 3,
      opacity: 0.9,
    }).addTo(map);
    // Center/zoom on whatever route is actually loaded — overrides the default
    // view, so dropping in the St Helens test GPX (or any GPX) frames itself
    // correctly. Same FIT_OPTS (and no animation) as the initial fit, so for the
    // real route this lands on the identical framing with no visible jump.
    map.fitBounds(line.getBounds(), FIT_OPTS);
  }
  if (routeIsStub) {
    console.info('Trail is a STUB (camps connected linearly). Progress disabled until a real Gaia GPX is dropped in.');
  }
}

// Hand-rolled GPX parse: pull <trkpt lat lon> with optional <ele>, in order.
// Precompute cumulative distance (mi) and cumulative gain (ft, positive deltas only).
function parseGpxToRoutePoints(gpxText) {
  const doc = new DOMParser().parseFromString(gpxText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('GPX parse error');

  // Prefer track points; fall back to route points if that's what the file has.
  let pts = Array.from(doc.getElementsByTagName('trkpt'));
  if (pts.length === 0) pts = Array.from(doc.getElementsByTagName('rtept'));

  const out = [];
  let cumDistMi = 0;
  let cumGainFt = 0;
  let prev = null;
  for (const pt of pts) {
    const lat = parseFloat(pt.getAttribute('lat'));
    const lon = parseFloat(pt.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const eleEl = pt.getElementsByTagName('ele')[0];
    const elev = eleEl ? parseFloat(eleEl.textContent) : null; // meters

    if (prev) {
      cumDistMi += haversineMi(prev.lat, prev.lon, lat, lon);
      if (prev.elev != null && elev != null && elev > prev.elev) {
        cumGainFt += (elev - prev.elev) * FT_PER_M;
      }
    }
    const p = { lat, lon, elev, cumDistMi, cumGainFt };
    out.push(p);
    prev = p;
  }
  return out;
}

// Stub: connect the camps (and trailhead) in order. Inaccurate distances — used
// only so the map shows *something* before the real GPX is provided.
function stubRouteFromCamps() {
  const keys = Object.keys(ITINERARY).sort();
  const pts = [];
  let cumDistMi = 0;
  let prev = null;
  // start at the trailhead
  const start = { lat: TRAILHEAD.lat, lon: TRAILHEAD.lon, elev: null };
  const seq = [start, ...keys.map((k) => ({ lat: ITINERARY[k].lat, lon: ITINERARY[k].lon, elev: null }))];
  for (const s of seq) {
    if (prev) cumDistMi += haversineMi(prev.lat, prev.lon, s.lat, s.lon);
    pts.push({ lat: s.lat, lon: s.lon, elev: null, cumDistMi, cumGainFt: 0 });
    prev = s;
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Snap-to-route
// ---------------------------------------------------------------------------
// anchorMi: our last known position in trail miles, used to disambiguate the
// loop (see CONFIG.SNAP_CONTINUITY_W). Pass null (the default) when there's no
// prior context — then this is the original pure nearest-vertex snap, so the
// off-route test and every existing caller behave exactly as before.
function snapToRoute(ping, anchorMi = null) {
  if (!routePoints.length) return { offRoute: true, distanceMi: Infinity };

  let minDist = Infinity; // nearest vertex by geography; drives the off-route test
  let best = null; // chosen vertex: geographically close, tie-broken by continuity
  for (let i = 0; i < routePoints.length; i++) {
    const p = routePoints[i];
    const d = haversineMi(ping.lat, ping.lon, p.lat, p.lon);
    if (d < minDist) minDist = d;
    if (d > CONFIG.OFF_ROUTE_THRESHOLD_MI) continue;
    const cost =
      anchorMi == null ? d : d + CONFIG.SNAP_CONTINUITY_W * Math.abs(p.cumDistMi - anchorMi);
    if (!best || cost < best.cost) best = { cost, rp: p };
  }

  if (minDist > CONFIG.OFF_ROUTE_THRESHOLD_MI || !best) {
    return { offRoute: true, distanceMi: minDist };
  }

  const rp = best.rp;
  return {
    offRoute: false,
    progressMi: rp.cumDistMi,
    progressPct: (rp.cumDistMi / CONFIG.TRAIL_TOTAL_MI) * 100,
    elevGainFt: rp.cumGainFt,
    nearestRoutePoint: rp,
  };
}

// Raw minimum distance (mi) from a ping to any route point. Used by the
// geofence guard outside the trip window. On a stub route this is coarse, but
// fine for a 5-mile threshold.
function minDistToRoute(ping) {
  let min = Infinity;
  for (const rp of routePoints) {
    const d = haversineMi(ping.lat, ping.lon, rp.lat, rp.lon);
    if (d < min) min = d;
  }
  return min;
}

// Scale a GPX-measured distance up to the canonical 94.1-mi headline, so the
// displayed mileage reads in "official" miles while the percentage (computed
// against routeTotalMi elsewhere) still completes at the finish.
function toHeadlineMi(gpxMi) {
  return gpxMi * (CONFIG.TRAIL_TOTAL_MI / routeTotalMi);
}

// Persist max progress + the matching elevation gain so neither jumps backward
// when backtracking (e.g. retrieving forgotten gear) or when a ping snaps to the
// wrong lobe of the loop. Reset support: clear localStorage 'maxProgressMi' and
// 'maxGainFt'.
function readMaxProgress() {
  const v = parseFloat(localStorage.getItem('maxProgressMi'));
  return Number.isFinite(v) ? v : 0;
}
function writeMaxProgress(mi) {
  localStorage.setItem('maxProgressMi', String(mi));
}
function readMaxGain() {
  const v = parseFloat(localStorage.getItem('maxGainFt'));
  return Number.isFinite(v) ? v : 0;
}
function writeMaxGain(ft) {
  localStorage.setItem('maxGainFt', String(ft));
}

// Furthest on-route point across a set of pings (the recent breadcrumb). Lets a
// first-time viewer who loads mid-backtrack still see the true high-water mark,
// not just the current (lower) position. Returns { progressMi, elevGainFt } or
// null if no ping is on the route.
function bestProgress(pings) {
  // Walk the breadcrumb in time order, carrying our last known mile forward as
  // the snap anchor, so each fix resolves to the lobe we're actually on instead
  // of the far side of the loop. Seed at the trailhead (mile 0). A pace gate
  // drops any single fix implying superhuman speed — that's a bad snap, not
  // real movement — so one wild ping can't poison the high-water mark.
  const chrono = pings
    .filter((p) => p && p.lat != null)
    .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  let anchorMi = 0;
  let prevTime = null;
  let best = null;
  for (const p of chrono) {
    const s = snapToRoute(p, anchorMi);
    if (s.offRoute) continue;
    const t = p.timestamp != null ? new Date(p.timestamp).getTime() : null;
    if (prevTime != null && t != null && s.progressMi > anchorMi) {
      const hrs = Math.max((t - prevTime) / 3.6e6, 0);
      // ~4 mph is a strong thru-hiker pace; allow a generous 6 mph + 0.5 mi slack.
      if (s.progressMi - anchorMi > 6 * hrs + 0.5) {
        prevTime = t; // time advances, but reject the implausible jump
        continue;
      }
    }
    anchorMi = s.progressMi;
    if (t != null) prevTime = t;
    if (!best || s.progressMi > best.progressMi) {
      best = { progressMi: s.progressMi, elevGainFt: s.elevGainFt };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function nearestCampName(ping) {
  let best = null;
  let bestD = Infinity;
  for (const key of Object.keys(ITINERARY)) {
    const it = ITINERARY[key];
    const d = haversineMi(ping.lat, ping.lon, it.lat, it.lon);
    if (d < bestD) { bestD = d; best = it.camp; }
  }
  return best ? { camp: best, distMi: bestD } : null;
}

// style: 'normal' (active, pulsing red), 'test' (pre-trip, blue test ping),
// or 'final' (post-trip, frozen finish marker).
function renderCurrentMarker(ping, style) {
  style = style || 'normal';
  const cls =
    style === 'test' ? 'test-marker' : style === 'final' ? 'final-marker' : 'pulse-marker';
  const icon = L.divIcon({
    className: '',
    html: `<div class="${cls}"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
  if (currentMarker) {
    currentMarker.setLatLng([ping.lat, ping.lon]);
  } else {
    currentMarker = L.marker([ping.lat, ping.lon], { icon, zIndexOffset: 1000 }).addTo(map);
  }
  currentMarker.setIcon(icon); // update icon too, in case the phase/style changed
  const label = style === 'test' ? 'Test ping' : style === 'final' ? 'Final position' : 'Last fix';
  currentMarker.bindPopup(
    `${label}: ${laClockTime(new Date(ping.timestamp))}<br>` +
    `${ping.lat.toFixed(4)}, ${ping.lon.toFixed(4)}` +
    (ping.elevation_m != null ? `<br>${Math.round(ping.elevation_m * FT_PER_M)} ft` : '')
  );
}

// Color the GPX route red from the trailhead up to the furthest point reached
// (progressMi, in GPX miles); the rest stays the base blue ("trail yet to come").
// This follows the actual trail geometry, so irregular polling never draws
// "crow-flies" lines across switchbacks, and off-route pings are simply ignored.
function renderRouteProgress(progressMi) {
  progressLayer.clearLayers();
  if (!routePoints.length || !(progressMi > 0)) return;

  // Furthest route index whose cumulative distance is within progress.
  let idx = 0;
  for (let i = 0; i < routePoints.length; i++) {
    if (routePoints[i].cumDistMi <= progressMi) idx = i;
    else break;
  }
  if (idx < 1) return;

  const traversed = routePoints.slice(0, idx + 1).map((p) => [p.lat, p.lon]);
  L.polyline(traversed, { color: '#e53935', weight: 4, opacity: 0.95 })
    .addTo(progressLayer)
    .bringToFront();
}

function updateProgressBar(snap, phase) {
  const fill = document.getElementById('progress-fill');
  const label = document.getElementById('progress-label');
  const ffProgress = document.getElementById('ff-progress');
  const ffElev = document.getElementById('ff-elev');

  // Pre-trip: no progress yet — count down to the start instead.
  if (phase === 'pre') {
    const n = daysBetween(laDateKey(new Date()), CONFIG.TRIP_START_KEY);
    fill.style.width = '0%';
    label.textContent = `Trip starts in ${n} day${n === 1 ? '' : 's'}`;
    ffProgress.textContent = 'Not started';
    ffElev.textContent = '—';
    return;
  }

  // Post-trip: completed summary. achievedGpxMi is in GPX miles; if we have real
  // tracked progress use it, otherwise assume the full route was completed.
  if (phase === 'post') {
    const achievedGpxMi =
      !routeIsStub && readMaxProgress() > 0 ? readMaxProgress() : routeTotalMi;
    const pct = Math.min(100, (achievedGpxMi / routeTotalMi) * 100);
    const displayedMi = toHeadlineMi(achievedGpxMi);
    fill.style.width = `${pct.toFixed(0)}%`;
    label.textContent = `Trip complete — ${displayedMi.toFixed(1)} of ${CONFIG.TRAIL_TOTAL_MI} mi`;
    ffProgress.textContent =
      `${displayedMi.toFixed(1)} of ${CONFIG.TRAIL_TOTAL_MI} mi (${Math.round(pct)}%)`;
    ffElev.textContent = `${Math.round(routeTotalGainFt).toLocaleString()} ft`;
    return;
  }

  // Active trip below.
  if (routeIsStub) {
    fill.style.width = '0%';
    label.textContent = `Awaiting trail data — ${CONFIG.TRAIL_TOTAL_MI} mi total`;
    ffProgress.textContent = 'Awaiting trail GPX';
    ffElev.textContent = '—';
    return;
  }

  // Distance + elevation are latched to their maximum so they never shrink — on
  // a backtrack, an off-route excursion, or a bad snap. `snap.best` is the
  // furthest on-route point across the recent breadcrumb; localStorage carries
  // the high-water mark across reloads. All values are GPX miles; pct uses the
  // GPX total (so it reaches 100%) while the displayed distance scales to 94.1.
  let maxMi = readMaxProgress();
  let maxGain = readMaxGain();
  if (snap.best) {
    maxMi = Math.max(snap.best.progressMi, maxMi);
    maxGain = Math.max(snap.best.elevGainFt, maxGain);
    writeMaxProgress(maxMi);
    writeMaxGain(maxGain);
  }

  const pct = Math.min(100, (maxMi / routeTotalMi) * 100);
  const displayedMi = toHeadlineMi(maxMi);
  const figure = `${displayedMi.toFixed(1)} of ${CONFIG.TRAIL_TOTAL_MI} mi (${Math.round(pct)}%)`;
  fill.style.width = `${pct.toFixed(1)}%`;

  // If the *current* fix is off-route, flag it but keep showing the held max.
  if (snap.curOffRoute) {
    label.textContent = `Off route — max ${figure}`;
    ffProgress.textContent = `Off route (max ${displayedMi.toFixed(1)} mi)`;
  } else {
    label.textContent = figure;
    ffProgress.textContent = figure;
  }
  ffElev.textContent =
    `${Math.round(maxGain).toLocaleString()} ft of ${Math.round(routeTotalGainFt).toLocaleString()} ft`;
}

function updateFastFacts(current, todayItin, recentLocations, phase) {
  // Tonight's camp + distance to it (active trip only).
  const ffCamp = document.getElementById('ff-camp');
  if (phase === 'pre') {
    ffCamp.textContent = '—';
  } else if (phase === 'post') {
    ffCamp.textContent = 'Finished — Longmire';
  } else if (todayItin) {
    const dist =
      current && current.lat != null
        ? haversineMi(current.lat, current.lon, todayItin.lat, todayItin.lon)
        : null;
    ffCamp.textContent =
      todayItin.camp + (dist != null ? ` (${dist.toFixed(1)} mi away)` : '');
  } else {
    ffCamp.textContent = 'Off-itinerary';
  }

  // Highest point today: max elevation among today's pings (best we can do
  // without a named-feature dataset). Converted to feet.
  const ffHigh = document.getElementById('ff-high');
  const todayKey = laDateKey(new Date());
  let maxElevM = null;
  for (const loc of recentLocations) {
    if (loc.elevation_m == null) continue;
    if (laDateKey(new Date(loc.timestamp)) !== todayKey) continue;
    if (maxElevM == null || loc.elevation_m > maxElevM) maxElevM = loc.elevation_m;
  }
  ffHigh.textContent =
    maxElevM != null ? `${Math.round(maxElevM * FT_PER_M).toLocaleString()} ft` : '—';
}

// geo (optional, pre/post only): { distMi, offTrail } from the geofence check.
function updateStatusText(current, phase, geo) {
  const dayLine = document.getElementById('day-line');
  const pingLine = document.getElementById('ping-line');
  const approxLine = document.getElementById('approx-line');

  const todayKey = laDateKey(new Date());
  const todayItin = ITINERARY[todayKey];

  // Day line per phase.
  if (phase === 'pre') {
    const n = daysBetween(todayKey, CONFIG.TRIP_START_KEY);
    dayLine.textContent =
      `Trip starts in ${n} day${n === 1 ? '' : 's'} · ${laLongDate(CONFIG.TRIP_START_KEY)}`;
  } else if (phase === 'post') {
    dayLine.textContent =
      `Trip complete · ${laLongDate(CONFIG.TRIP_START_KEY)} – ${laLongDate(CONFIG.TRIP_END_KEY)}`;
  } else if (todayItin) {
    dayLine.textContent = `Day ${todayItin.day} of ${TOTAL_DAYS} · ${laLongDate(todayKey)}`;
  } else {
    dayLine.textContent = laLongDate(todayKey);
  }

  if (!current || current.timestamp == null) {
    pingLine.textContent = phase === 'pre' ? 'No test pings yet.' : 'No location pings yet.';
    pingLine.classList.remove('stale');
    approxLine.textContent = '';
    return { todayItin };
  }

  const ageH = current.age_seconds / 3600;
  const clock = laClockTime(new Date(current.timestamp));
  const pingLabel =
    phase === 'pre' ? 'Last test ping' : phase === 'post' ? 'Final fix' : 'Last ping';
  pingLine.textContent = `${pingLabel}: ${clock} (${relativeTime(current.age_seconds)})`;
  // Muted "stale" styling for 4–12 hr old pings is only meaningful mid-trip.
  pingLine.classList.toggle('stale', phase === 'active' && ageH >= 4 && ageH <= 12);

  // Location line.
  if (phase === 'active') {
    const near = nearestCampName(current);
    approxLine.textContent = near
      ? `Approximate location: near ${near.camp} (${near.distMi.toFixed(1)} mi)`
      : '';
  } else if (geo && geo.offTrail) {
    // Geofence guard: outside the window AND >5 mi off route — don't snap.
    approxLine.textContent = 'Off trail (test ping)';
  } else {
    const label = phase === 'pre' ? 'Test ping' : 'Final position';
    const near = nearestCampName(current);
    approxLine.textContent = near
      ? `${label} — near ${near.camp} (${near.distMi.toFixed(1)} mi)`
      : label;
  }

  return { todayItin };
}

// Failure-mode banners/footer per the brief's table.
function updateFailureUI(current, phase) {
  const banner = document.getElementById('banner');
  const footer = document.getElementById('footer-status');
  banner.hidden = true;
  banner.className = 'banner';
  footer.textContent = '';

  if (!current) return;

  if (current.feed_healthy === false) {
    footer.textContent = 'Data feed unavailable (system issue, not Cameron).';
  }

  if (current.age_seconds == null) return;
  // Stale-ping banners only make sense during the active trip — a long gap
  // before the start or after the finish is expected, not a problem.
  if (phase !== 'active') return;
  const ageH = current.age_seconds / 3600;
  const todayKey = laDateKey(new Date());

  if (ageH > 24 && todayKey === '2026-07-04') {
    banner.hidden = false;
    banner.classList.add('danger');
    banner.textContent = `Extended communication gap on Panhandle Gap day — no ping in ${Math.floor(ageH)} hours.`;
  } else if (ageH > 12) {
    banner.hidden = false;
    banner.classList.add('warn');
    banner.textContent = `No ping in ${Math.floor(ageH)} hours.`;
  } else if (ageH >= 4) {
    // Handled as muted ping text in updateStatusText; no banner needed.
  }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
function photoUrl(url) {
  // API returns '/photos/<file>'. Prefix with API_BASE if cross-origin.
  return CONFIG.API_BASE ? CONFIG.API_BASE + url : url;
}

function renderPhotos(photos) {
  const section = document.getElementById('photo-section');
  const strip = document.getElementById('photo-strip');
  photoMarkersLayer.clearLayers();
  if (!photos || photos.length === 0) {
    section.hidden = true; // hide entirely when empty (per brief)
    return;
  }
  section.hidden = false;
  strip.innerHTML = '';
  photos.slice(0, 10).forEach((p) => {
    const wrap = document.createElement('div');
    wrap.className = 'photo-thumb';
    const img = document.createElement('img');
    img.src = photoUrl(p.url);
    img.alt = p.caption || 'trail photo';
    img.loading = 'lazy';
    wrap.appendChild(img);
    if (p.caption) {
      const cap = document.createElement('div');
      cap.className = 'cap';
      cap.textContent = p.caption;
      wrap.appendChild(cap);
    }
    const when = document.createElement('div');
    when.className = 'when';
    // Show time since the photo was TAKEN (captured_at), not uploaded.
    when.textContent = relativeFromIso(p.captured_at || p.uploaded_at);
    wrap.appendChild(when);
    wrap.addEventListener('click', () => openLightbox(photoUrl(p.url), p.caption || ''));
    strip.appendChild(wrap);
  });

  // Drop a camera marker on the map at each photo's coordinates; tap opens the
  // lightbox. Only photos that have associated coordinates get a marker.
  photos.forEach((p) => {
    if (p.associated_lat == null || p.associated_lon == null) return;
    const icon = L.divIcon({
      className: '',
      html: '<div class="photo-marker">📷</div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    const m = L.marker([p.associated_lat, p.associated_lon], { icon }).addTo(photoMarkersLayer);
    m.on('click', () => openLightbox(photoUrl(p.url), p.caption || ''));
  });
}

function openLightbox(src, caption) {
  const lb = document.getElementById('lightbox');
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox-caption').textContent = caption;
  lb.hidden = false;
}
document.getElementById('lightbox').addEventListener('click', function () {
  this.hidden = true;
  document.getElementById('lightbox-img').src = '';
});

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------
async function apiGet(pathname) {
  const resp = await fetch(CONFIG.API_BASE + pathname, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`${pathname} -> HTTP ${resp.status}`);
  return resp.json();
}

async function poll() {
  try {
    const [current, recent, photoResp] = await Promise.all([
      apiGet('/api/location/current'),
      apiGet(`/api/location/recent?hours=${CONFIG.BREADCRUMB_HOURS}`),
      apiGet('/api/photos').catch(() => ({ photos: [] })), // photos are non-critical
    ]);

    const todayKey = laDateKey(new Date());
    const phase = tripPhase(todayKey);

    // Geofence guard: only outside the active window, and only when we have a
    // ping. >5 mi from any route point => treat as an off-trail test ping.
    let geo = null;
    if (current && current.lat != null && phase !== 'active') {
      const distMi = minDistToRoute(current);
      geo = { distMi, offTrail: distMi > CONFIG.GEOFENCE_TEST_MI };
    }

    const { todayItin } = updateStatusText(current, phase, geo);
    updateFailureUI(current, phase);

    const locations = (recent && recent.locations) || [];

    // Furthest on-route point across the recent breadcrumb + current fix. Drives
    // both the progress bar (active only) and the red route-fill (all phases).
    // Off-route pings (e.g. a stray Seattle test ping) don't snap, so they're
    // ignored here — no more crow-flies lines.
    const allRecent = (current && current.lat != null ? [current] : []).concat(locations);
    const best = bestProgress(allRecent);
    const curOffRoute = current && current.lat != null ? snapToRoute(current).offRoute : false;

    if (current && current.lat != null) {
      const markerStyle = phase === 'pre' ? 'test' : phase === 'post' ? 'final' : 'normal';
      renderCurrentMarker(current, markerStyle);
    }
    updateProgressBar(phase === 'active' ? { best, curOffRoute } : null, phase);
    updateFastFacts(current && current.lat != null ? current : null, todayItin, locations, phase);

    // Red "route traversed" fill. Shown in every phase (incl. the pre-trip St
    // Helens test), so the climb traces the trail itself, not raw GPS dots.
    let progressMi = best ? best.progressMi : 0;
    if (phase === 'active') progressMi = Math.max(progressMi, readMaxProgress());
    else if (phase === 'post') progressMi = Math.max(progressMi, readMaxProgress()) || routeTotalMi;
    renderRouteProgress(progressMi);

    renderPhotos(photoResp && photoResp.photos);
  } catch (e) {
    console.error('Poll failed:', e);
    const footer = document.getElementById('footer-status');
    footer.textContent = 'Could not reach the tracker API. Retrying…';
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// One-time reset of the progress high-water mark when the progress logic
// changes (see CONFIG.PROGRESS_SCHEMA). Clears any stale/poisoned latch for
// every viewer on their next load — no server change, no ping data touched.
// Runs before the first poll so the corrected math starts from a clean slate.
try {
  if (localStorage.getItem('progressSchema') !== CONFIG.PROGRESS_SCHEMA) {
    localStorage.removeItem('maxProgressMi');
    localStorage.removeItem('maxGainFt');
    localStorage.setItem('progressSchema', CONFIG.PROGRESS_SCHEMA);
  }
} catch (e) {
  /* localStorage unavailable (private mode, etc.) — nothing to migrate */
}

drawCamps();
drawTrailhead();
loadTrail().then(poll);
setInterval(poll, CONFIG.POLL_INTERVAL_MS);
