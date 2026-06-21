# DEPLOY.md — Wonderland Tracker Deployment Runbook

This deployment is split between two actors because **Cicero has no sudo/root**:

- **Cameron (root):** a few one-time host-prep steps that require root — creating
  & owning the app directory, installing the systemd unit, and symlinking the web
  root. (nginx is already configured on wavebeam — see the resolved note below.)
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
public/wonderland-2026/  → symlinked into the cslester.com web root (Step 9)
```

---

## ✅ Resolved: cslester.com IS served by nginx on wavebeam

Confirmed by Cameron. Implications:
- **Do Step 8b** (nginx proxy). The frontend stays same-origin (`CONFIG.API_BASE`
  stays `''`), so there is no CORS concern.
- **Serve the frontend straight from the repo:** point the nginx web root for
  `/wonderland-2026` at `/opt/wonderland-tracker/public/wonderland-2026` (or
  symlink it). Then `git pull` updates the live site with no copy step.

Still needed from Cameron: **the existing cslester.com nginx `server { }` block**,
so the Step 8b proxy `location` blocks and the `/wonderland-2026` root merge
cleanly (TLS/server_name are not guessed here).

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

Using the username/group Cicero reported in Step 0 (call it `CUSER:CGROUP`).
Create the directory EMPTY (so `git clone` can populate it in Step 2):

```bash
sudo mkdir -p /opt/wonderland-tracker
sudo chown CUSER:CGROUP /opt/wonderland-tracker
```

That's it for root, for now. The directory is now fully owned by Cicero's user,
so every remaining app step is unprivileged.

---

## Step 2 — [CICERO] Clone the repository

The whole deployment is a git repo; the repo root IS `/opt/wonderland-tracker`.
Clone it into the empty directory from Step 1:

```bash
git clone https://github.com/bentwheel/wonderland-tracker.git /opt/wonderland-tracker
ls -la /opt/wonderland-tracker
```

This populates `poller/`, `api/`, `public/`, `deploy/`, and an empty `data/photos/`.
Runtime files (`data/locations.db`, uploaded photos, `api/.env`) are gitignored and
created in later steps.

> Updating later is just `git -C /opt/wonderland-tracker pull` — see
> "Updating the deployment" near the end of this file.

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
PORT=8788
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
./verify.sh                       # checks 127.0.0.1:8788
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
curl -fsS http://127.0.0.1:8788/api/health    # -> {"ok":true}
```

### 8b. nginx — already configured on wavebeam

cslester.com's nginx already proxies `/api/`, `/admin/upload`, and `/photos/` to
`127.0.0.1:8788`. **No nginx change is needed on the existing host.** (Just
confirm the API is answering on 8788 via the curl above.) The
`nginx-snippet.conf` in this repo is reference-only — see the note at its top.

---

## Step 9 — [CAMERON-ROOT] Publish the frontend (symlink the web root)

cslester.com is served from this box, with its document root holding a
`wonderland-2026/` directory. Point that directory at the repo's copy so future
`git pull`s update the live site with no copy step. Back up the existing v1
directory first:

```bash
# WEBROOT = cslester.com document root (e.g. the path holding index.html).
WEBROOT=<cslester.com document root>
sudo mv "$WEBROOT/wonderland-2026" "$WEBROOT/wonderland-2026.v1.bak"   # keep a backup
sudo ln -s /opt/wonderland-tracker/public/wonderland-2026 "$WEBROOT/wonderland-2026"
# Ensure nginx (www-data) can traverse/read the repo's public files:
chmod -R o+rX /opt/wonderland-tracker/public
```

Verify in a browser at `https://cslester.com/wonderland-2026`. Asset links carry
a `?v=` query string for cache-busting; bump it on a breaking change.

> `trail.gpx` is a STUB (camps connected by straight lines). The progress bar
> stays disabled until you replace it with a real Gaia export at the same path.

---

## Step 10 — [CICERO] Final verification through the public origin

After Cameron finishes Step 8, re-run verify against the live service and the
public origin, and report all output:

```bash
cd /opt/wonderland-tracker/deploy
BASE=http://127.0.0.1:8788 ./verify.sh         # via systemd service
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

## Updating the deployment (git pull)

When new code is pushed to GitHub, redeploying is a pull + dependency refresh +
restart. The pull and install are unprivileged [CICERO]; only the service
restart needs root [CAMERON].

```bash
# [CICERO] Pull latest and refresh the API:
cd /opt/wonderland-tracker
git pull --ff-only
cd api
npm install            # only strictly needed if package.json changed; safe to always run
node migrate.js        # applies any new schema columns (idempotent)
```
```bash
# [CAMERON-ROOT] Restart the service to pick up the new API code:
sudo systemctl restart tracker-api.service
curl -fsS http://127.0.0.1:8788/api/health
```

Frontend updates (`public/wonderland-2026/`) land in the repo via the same
`git pull`. How they reach the live site depends on Open Question 1:
- **cslester.com served on wavebeam:** point the web root for `/wonderland-2026`
  at `/opt/wonderland-tracker/public/wonderland-2026` (or symlink it). Then a
  `git pull` updates the site directly — no copy step. Remember to cache-bust
  (the asset links use `?v=` query strings; bump them on a breaking change).
- **cslester.com hosted elsewhere:** publish `public/wonderland-2026/` through
  Cameron's existing pipeline as usual.

> If `git pull` reports local changes blocking the merge (e.g. someone edited a
> file on the server), STOP and ask Cameron — don't force or discard.

---

## Operational notes

- **Restart API after a code change:** `sudo systemctl restart tracker-api.service` [CAMERON], or restart the manual instance [CICERO].
- **Reset a stuck progress bar:** the latched maximum lives in the browser's
  `localStorage` (`maxProgressMi` and `maxGainFt`) — Cameron clears those keys on
  his phone; no server action.
- **Backups:** photos + DB live under `/opt/wonderland-tracker/data/` (gitignored).

## Requires Cameron's judgment — NOT for Cicero

- Whether the map/UI "looks right" (visual inspection).
- Replacing the stub `trail.gpx` with the real Gaia export.
- The cslester.com hosting topology (Open Question 1) and nginx server block (2).
- Anything needing root (Steps 1, 8) — by design, those are Cameron's.
