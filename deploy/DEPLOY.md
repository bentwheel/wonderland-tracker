# DEPLOY.md — Wonderland Tracker Deployment Runbook

This deployment is split between two actors because **Cicero has no sudo/root**:

- **Cameron (root):** a few one-time host-prep steps that require root — creating
  & owning the app directory, installing the systemd unit, and the nginx config.
- **Cicero (unprivileged):** everything else — copying files, Python venv, npm
  install, DB migration, the `.env` secret, the user-crontab poller, and all
  verification. None of Cicero's steps use `sudo`.

The steps are ordered and labeled **[CAMERON-ROOT]** or **[CICERO]**. They
interleave — follow them top to bottom. Cicero: **stop and ask Cameron** if any
step fails or needs a judgment call; do not improvise around an error or reach
for sudo.

Target layout on **wavebeam**:

```
/opt/wonderland-tracker/        (created by Cameron, chowned to Cicero's user)
├── poller/   (poll_mapshare.py, requirements.txt, venv/)
├── api/      (server.js, db.js, migrate.js, schema.sql, package.json, .env)
├── data/     (locations.db, photos/, poller.log)   — runtime, gitignored
└── deploy/   (this file + unit/cron/nginx artifacts)
public/wonderland-2026/  → served by the cslester.com static pipeline (Cameron)
```

---

## ⚠️ Open questions for Cameron (resolve before the relevant step)

1. **Is cslester.com served by nginx on this same box (wavebeam)?**
   - **YES →** do Step 8 (nginx proxy); frontend stays same-origin, no CORS.
   - **NO** (hosted elsewhere) → skip Step 8. Cameron sets `CONFIG.API_BASE` in
     `public/wonderland-2026/tracker.js` and `API_BASE` in
     `public/wonderland-2026/admin/index.html` to the API's public URL, exposes
     the API publicly, and keeps `CORS_ORIGIN=https://cslester.com`.
2. **Existing nginx server block** for cslester.com — Cameron provides it so the
   Step 8 proxy blocks merge cleanly (TLS/server_name not guessed here).

---

## Step 0 — [CICERO] Report identity & environment

Cicero runs these and reports the output back to Cameron. The username/group and
node path are needed for the root steps.

```bash
id -un          # the service username (Cameron puts this in the systemd unit)
id -gn          # the primary group
which node      # node path (for the systemd ExecStart)
node --version  # expect v18+
python3 --version
echo "package is at: $(pwd)"   # where the build package currently lives
```

If `node` is older than v18, **stop** — better-sqlite3/sharp need a modern Node.

---

## Step 1 — [CAMERON-ROOT] Create and hand over the app directory

Using the username/group Cicero reported in Step 0 (call it `CUSER:CGROUP`):

```bash
sudo mkdir -p /opt/wonderland-tracker/data/photos
sudo chown -R CUSER:CGROUP /opt/wonderland-tracker
```

That's it for root, for now. The directory is now fully owned by Cicero's user,
so every remaining app step is unprivileged.

---

## Step 2 — [CICERO] Place the build files

Copy the package contents into the now-owned directory (adjust `SOURCE` to the
path reported in Step 0, e.g. `/tmp/wonderland-tracker-build`):

```bash
SOURCE=/tmp/wonderland-tracker-build
cp -r "$SOURCE/poller" /opt/wonderland-tracker/
cp -r "$SOURCE/api"    /opt/wonderland-tracker/
cp -r "$SOURCE/deploy" /opt/wonderland-tracker/
# (public/ is NOT copied here — it goes through Cameron's static pipeline, Step 9.)
ls -la /opt/wonderland-tracker
```

---

## Step 3 — [CICERO] Python venv for the poller

```bash
cd /opt/wonderland-tracker/poller
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
```

Smoke-test once (creates the DB, fetches the live feed):

```bash
TRACKER_DB_PATH=/opt/wonderland-tracker/data/locations.db \
  ./venv/bin/python poll_mapshare.py
```

Expected: `No new pings (N parsed)` or `Inserted N new ping(s)`. A network error
is logged but exits 0 — note it for Cameron but continue.

---

## Step 4 — [CICERO] Node deps + DB migration

```bash
cd /opt/wonderland-tracker/api
npm install --omit=dev
TRACKER_DB_PATH=/opt/wonderland-tracker/data/locations.db node migrate.js
```

Expected: `Migration complete: schema.sql applied.`

> **sharp / HEIC note:** `npm install` pulls `sharp` for HEIC→JPEG. If it fails
> to install on this box, the API still runs — it just stores photos as-is
> (HEIC won't display in non-Safari browsers). Note any sharp error for Cameron;
> don't block on it.

---

## Step 5 — [CICERO] Create the API secrets file (.env)

```bash
TOKEN=$(openssl rand -hex 24)
tee /opt/wonderland-tracker/api/.env >/dev/null <<EOF
ADMIN_UPLOAD_TOKEN=$TOKEN
PORT=8787
TRACKER_DB_PATH=/opt/wonderland-tracker/data/locations.db
PHOTO_DIR=/opt/wonderland-tracker/data/photos
CORS_ORIGIN=https://cslester.com
EOF
chmod 600 /opt/wonderland-tracker/api/.env
echo "ADMIN_UPLOAD_TOKEN is: $TOKEN"
```

**Report the token back to Cameron** (he pastes it into the admin upload page).
Don't post it anywhere public.

---

## Step 6 — [CICERO] Install the poller into the user crontab (no root)

```bash
( crontab -l 2>/dev/null | grep -v 'poll_mapshare.py' ; \
  grep -v '^#' /opt/wonderland-tracker/deploy/poller.cron ) | crontab -
crontab -l    # confirm the */15 line is present
```

Within 15 min, `/opt/wonderland-tracker/data/poller.log` should start filling.

---

## Step 7 — [CICERO] Bring up the API and verify it (before it's a service)

The permanent systemd service is a root step (Step 8b). To verify the app now
without root, run the API in the background as yourself:

```bash
cd /opt/wonderland-tracker/api
set -a; . /opt/wonderland-tracker/api/.env; set +a
nohup node server.js > /opt/wonderland-tracker/data/api-manual.log 2>&1 &
echo "started api pid $!"
sleep 2
cd /opt/wonderland-tracker/deploy
chmod +x verify.sh
./verify.sh                       # checks 127.0.0.1:8787
```

Report the full `verify.sh` output to Cameron. Then **stop this manual instance**
so the systemd service (Step 8b) can take over the port:

```bash
pkill -f 'node server.js'         # or: kill the pid printed above
```

---

## Step 8 — [CAMERON-ROOT] Make the API permanent + put it behind nginx

### 8a. systemd service

Edit `/opt/wonderland-tracker/deploy/tracker-api.service` first:
- replace `__SERVICE_USER__` with the username Cicero reported in Step 0,
- set `ExecStart=` to the node path Cicero reported (`which node`).

Then:

```bash
sudo cp /opt/wonderland-tracker/deploy/tracker-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tracker-api.service
sudo systemctl status tracker-api.service --no-pager
curl -fsS http://127.0.0.1:8787/api/health    # -> {"ok":true}
```

### 8b. nginx (only if cslester.com is on this box — see Open Question 1)

Merge the three `location` blocks from
`/opt/wonderland-tracker/deploy/nginx-snippet.conf` into the existing cslester.com
`server { }` block, then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

If cslester.com is hosted elsewhere, skip this and set `API_BASE` in the
frontend instead (Open Question 1).

---

## Step 9 — [CAMERON] Publish the frontend

Deploy `public/wonderland-2026/` (`index.html`, `tracker.js`, `tracker.css`,
`trail.gpx`, `admin/index.html`) through the existing cslester.com pipeline so the
page is live at `https://cslester.com/wonderland-2026`.

> `trail.gpx` is a STUB (camps connected by straight lines). The progress bar
> stays disabled until you replace it with a real Gaia export at the same path.

---

## Step 10 — [CICERO] Final verification through the public origin

After Cameron finishes Step 8, re-run verify against the live service and the
public origin, and report all output:

```bash
cd /opt/wonderland-tracker/deploy
BASE=http://127.0.0.1:8787 ./verify.sh         # via systemd service
BASE=https://cslester.com   ./verify.sh         # via nginx (only if Step 8b done)
```

---

## Log inspection (when something's wrong)

```bash
# API (once it's a systemd service — needs root to read the journal):
sudo journalctl -u tracker-api.service -n 100 --no-pager   # [CAMERON]
# API (manual instance from Step 7 — no root):
tail -n 100 /opt/wonderland-tracker/data/api-manual.log    # [CICERO]

# Poller (no root):
tail -n 100 /opt/wonderland-tracker/data/poller.log        # [CICERO]

# Poller status + ping count (no root):
sqlite3 /opt/wonderland-tracker/data/locations.db 'SELECT * FROM poll_status;'
sqlite3 /opt/wonderland-tracker/data/locations.db 'SELECT COUNT(*), MAX(timestamp) FROM locations;'
```

---

## Operational notes

- **Restart API after a code change:** `sudo systemctl restart tracker-api.service` [CAMERON], or restart the manual instance [CICERO].
- **Reset a stuck progress bar:** it lives in the browser's `localStorage`
  (`maxProgressMi`) — Cameron clears it on his phone; no server action.
- **Backups:** photos + DB live under `/opt/wonderland-tracker/data/` (gitignored).

## Requires Cameron's judgment — NOT for Cicero

- Whether the map/UI "looks right" (visual inspection).
- Replacing the stub `trail.gpx` with the real Gaia export.
- The cslester.com hosting topology (Open Question 1) and nginx server block (2).
- Anything needing root (Steps 1, 8) — by design, those are Cameron's.
