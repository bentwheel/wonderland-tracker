# Handoff — kicking off the deploy with Cicero

This is Cameron's cheat-sheet for handing the build to Cicero on wavebeam.
(It is NOT deployed to the server — it just helps you start the conversation.)

Adjust these placeholders to your real values:
- `CICERO_USER` — the Linux user Cicero runs as (e.g. `cicero`)
- `wavebeam` — your SSH target for the server (WireGuard host/alias/IP)

---

## 1. Get the files onto wavebeam, into Cicero's home

From your Mac (over WireGuard). This copies the package to /tmp, then places it
in Cicero's home owned by Cicero so Cicero can read everything:

```bash
# From your Mac:
rsync -av /Users/cslester/Projects/wonderland-tracker/wonderland-tracker-build \
  wavebeam:/tmp/

# Then on wavebeam (you have sudo):
sudo mv /tmp/wonderland-tracker-build /home/CICERO_USER/
sudo chown -R CICERO_USER:CICERO_USER /home/CICERO_USER/wonderland-tracker-build
```

Sanity check that Cicero can read it:

```bash
sudo -u CICERO_USER head -5 /home/CICERO_USER/wonderland-tracker-build/deploy/DEPLOY.md
```

## 2. The three root steps you'll run (preview)

Cicero will prompt you for these at the right moments — you don't need to run
them upfront. Listed here so you know what's coming:

1. **Step 1 (after Cicero reports its user/group):**
   ```bash
   sudo mkdir -p /opt/wonderland-tracker/data/photos
   sudo chown -R CICERO_USER:CICERO_USER /opt/wonderland-tracker
   ```
2. **Step 8a (after Cicero finishes the app install + first verify):** edit
   `deploy/tracker-api.service` (`__SERVICE_USER__` → CICERO_USER; set
   `ExecStart=` to the node path Cicero reports), then:
   ```bash
   sudo cp /opt/wonderland-tracker/deploy/tracker-api.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now tracker-api.service
   ```
3. **Step 8b (nginx — only if cslester.com is served on wavebeam):** merge
   `deploy/nginx-snippet.conf` into your cslester.com server block, then
   `sudo nginx -t && sudo systemctl reload nginx`.

You also publish the frontend (`public/wonderland-2026/`) through your normal
cslester.com pipeline (Step 9) — Cicero doesn't touch that.

## 3. Paste this to Cicero in Discord to start

> Hi Cicero — new deployment task. The build package is in your home directory at
> `~/wonderland-tracker-build`.
>
> Before doing anything, read `~/wonderland-tracker-build/deploy/DEPLOY.md` in
> full. Important context:
> - This deploy is split between you (unprivileged) and me (root). **You have no
>   sudo.** Do not use sudo or try to work around missing permissions — when a
>   step needs root, hand it to me.
> - The runbook tags each step **[CICERO]** (you do it) or **[CAMERON-ROOT]** (you
>   give me the exact commands and wait for my confirmation before continuing).
>
> Start now with **Step 0**: run the identity/environment commands and report the
> outputs back to me — your username (`id -un`), group (`id -gn`), node path
> (`which node`), node/python versions, and where the package lives.
>
> Then tell me exactly what to run for **Step 1** (the root `mkdir`/`chown`),
> filled in with the username/group you just reported, and wait for me to confirm
> it's done before continuing.
>
> Work through the rest of the runbook in order: do each [CICERO] step yourself,
> and pause at each [CAMERON-ROOT] step to give me the commands. **Stop and ask me
> if anything fails or needs a judgment call** — don't improvise. When you create
> the upload token (Step 5), report it to me. Send me the full output of
> `verify.sh`. Do **not** deploy the frontend (`public/`) — I handle that myself.
