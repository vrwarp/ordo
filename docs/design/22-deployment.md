# Design 22: Deployment

## Overview

| Piece           | Where                                            | How                                                                                                                               |
| --------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Hub image       | Docker Hub `vrwarp/ordo-hub`                     | Pushed by `docker-publish.yml` on merge to `main` (`edge`, `sha-*`) and on tags `v*`; `docker-pr.yml` dry-runs every pull request |
| Hub container   | Synology NAS, Container Manager, Compose project | Pulled by tag; manual upgrade                                                                                                     |
| TLS and routing | DSM reverse proxy                                | One rule per hostname to `ordo-hub:8080`, WebSocket headers enabled                                                               |
| Certificate     | DSM certificate store                            | Let's Encrypt wildcard for `*.<venue>.synology.me` issued by DSM, assigned to the reverse proxy rules                             |
| Presentation PC | Windows 11, Chrome stable                        | Hosts entries, Chrome policies, PWA install, auto-login                                                                           |

## Hostnames to verify first (M1 task 1)

The design depends on `op`, `hub`, `out1`..`out6` and `stage` under `<venue>.synology.me`
resolving to the NAS and on a wildcard certificate covering them.

1. In DSM, Control Panel, External Access, DDNS: confirm the synology.me hostname and that
   subdomain resolution works by resolving `op.<venue>.synology.me` from outside the LAN.
2. In DSM, Security, Certificate: add a Let's Encrypt certificate for
   `*.<venue>.synology.me` (DSM offers the wildcard option for its DDNS names).
3. If subdomains do not resolve or the wildcard is refused, fallback: register a domain at
   a provider with an API (Cloudflare), CNAME `*.ordo.<domain>` to the DDNS name, and
   issue the wildcard through DSM or through a Caddy sidecar with the DNS-01 plugin. The
   rest of the design is unchanged; only `ORDO_DOMAIN` differs.

## Compose

```yaml
services:
  ordo-hub:
    image: vrwarp/ordo-hub:v0.1.0
    container_name: ordo-hub
    restart: unless-stopped
    environment:
      ORDO_DOMAIN: <venue>.synology.me
      ORDO_TRUSTED_PROXY: 172.16.0.0/12 # DSM reverse proxy source on the bridge network
      ORDO_TZ: America/Los_Angeles
      ORDO_PORT: "8080"
    volumes:
      - /volume1/docker/ordo/data:/data
    ports:
      - "127.0.0.1:8080:8080"
    mem_limit: 4g # honoured by `docker compose up`; deploy.resources.limits is swarm-only
```

`ORDO_TZ` seeds the venue time zone on first run; afterwards Settings → General → Time zone
is the single source for countdowns and the nightly backup.

Backups land in `/volume1/docker/ordo/data/backups`, which the venue's Hyper Backup task
includes. The data folder also holds `ordo.db` (the library), `live.db` (the live journal and snapshots and
the live process's copies of the library; not part of a backup, and its library copies are cleared by a
restore), `supervisor.json` (process states), `media/`, `fonts/`, `uploads/` and `tmp/`; deploy/README
lists them.

## DSM reverse proxy rules

For each hostname (`op`, `hub`, `stage`, `out1`..`out6`): source `HTTPS`, hostname
`<name>.<venue>.synology.me`, port 443, HSTS on; destination `HTTP localhost 8080`.
Custom headers: enable the WebSocket preset (`Upgrade` and `Connection`) on every rule,
plus `X-Forwarded-Proto https` and `X-Forwarded-Host $host`. Set the proxy timeout to
3600 s so WebSockets are not cut.

The hub routes by `Host`: `op` serves `apps/operator`, `out<k>` serves `apps/output`
with the output index, `stage` serves `apps/stage`, `hub` serves the API and files.

Two hub processes do not change these rules: the live process owns port 8080 and passes library requests
to the library process inside the container (design/12 "Processes"), so DSM keeps one rule per hostname
to `localhost 8080`. During a library-process restart (about half a second) library calls answer
`503 library_unavailable` with `Retry-After: 1`; `/ws`, the live API and output file fills are not
affected.

## Processes in the container

`ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/apps/hub/dist/main.js"]`. `main.js` is the supervisor,
which starts `main.js __child library` and `main.js __child live` (one bundle; `cpu.worker.js` beside it
is the worker-thread entry). tini reaps zombies and forwards `SIGTERM` to the supervisor, which stops both
children (SIGKILL after 5 s); `docker stop` therefore finishes in under 10 s (compose sets
`stop_grace_period: 15s` for margin). A child that crashes is restarted within a second, at most five
times a minute; a live process past that budget ends the container (exit 1) and `restart: unless-stopped`
brings it back. `docker exec ordo-hub cat /data/supervisor.json` shows pids, states and restart counts.
`ORDO_SINGLE_PROCESS=1` runs the hub as one process (debugging only). `ORDO_CPU_WORKERS` (default 1) sizes
the parsing worker pool. The memory cap (`mem_limit`) covers both processes; the library process is the
one that can grow (imports, LibreOffice), and if the kernel kills it the live service is untouched.

## Image

Multi-stage Dockerfile: `node:22-bookworm-slim` build stage running `pnpm install
--frozen-lockfile` and `pnpm build`; runtime stage adds `ffmpeg`, `poppler-utils`,
`libreoffice-impress` (no GUI packages), `fonts-dejavu`, and copies `apps/hub/dist` and
the built browser apps. Runs as a non-root user under tini, entrypoint the supervisor. Health check
`GET /api/v1/health` (answered by the live process; it reports the library process state too).
Image size target under 1.5 GB (LibreOffice dominates).

## CI and release

- Every push and pull request (`ci.yml`): lint, typecheck, unit tests, Playwright. `pnpm audit`
  runs too but never fails the build (`continue-on-error`); a weekly scheduled workflow
  (`audit.yml`, Mondays) reports advisories on its own.
- Every pull request (`docker-pr.yml`): the image is built for amd64 and arm64 without
  pushing, and the amd64 image is started and must pass its health check.
- Merge to `main` (`docker-publish.yml`): push `edge` and `sha-<commit>`.
- Tag `vX.Y.Z` (`docker-publish.yml`): push `vX.Y.Z` and `latest`; create a GitHub release
  with the changelog.
- Upgrades at the venue: change the tag in Compose and redeploy, never on a Saturday
  evening or Sunday. The operator top bar shows the hub version; a mismatch with the app
  bundle (same image, so only possible with a stale tab) reloads the tab.

## Presentation PC setup

1. Windows 11, local account with auto-login, no sleep, display power never off, Windows
   Update active hours set to weekdays. Set each display to 1920x1080 at 60 Hz and
   "Extend".
2. Chrome stable. Verify `chrome://gpu` reports WebGPU hardware accelerated; if not,
   update the GPU driver, or set `chrome://flags/#enable-unsafe-webgpu` as a last resort
   and record it.
3. Hosts file: `<NAS LAN IP>  hub.<venue>.synology.me op.<venue>.synology.me stage.<venue>.synology.me out1.<venue>.synology.me … out6.<venue>.synology.me`.
4. Chrome policies (registry or `chrome://policy` via a local policy file):
   `RestoreOnStartup` off, `SessionRestore` prompt off, `BackgroundModeEnabled` off,
   `UpdatesSuppressed` for Saturday 18:00 to Sunday 14:00, `DefaultPopupsSetting` allow
   for `op.<venue>.synology.me`, `WindowManagementAllowedForUrls` and
   `WebHidAllowedForUrls` where supported.
   Autoplay with sound: the output windows start video and audio without a click, which
   Chrome's autoplay policy only allows on origins with enough "media engagement" or on
   an allow-list. Set the `AutoplayAllowlist` policy to the output origins
   (`https://out1.<venue>.synology.me` … `out6`, and `stage.<venue>.synology.me`), or
   `AutoplayAllowed` for the whole profile. Without it an output falls back to muted
   playback and reports `audio blocked by autoplay policy: click the output window` in
   its health error (the operator's diagnostics show it); a click on the window unmutes.
   For a development PC the command-line flag `--autoplay-policy=no-user-gesture-required`
   does the same. Confirm at `chrome://policy` that the policy is applied before the
   first service.
5. Install the operator origin as a PWA (Chrome menu, Install) so it launches as its own
   window; pin it to the taskbar; set it to launch at login.
6. Grant and remember permissions once: Window Management, HID (Stream Deck), MIDI,
   microphone (for audio device labels; no capture is used).
7. Open the operator, click Launch outputs, place each output on its screen; the
   placement is saved.
8. Print the service checklist.
9. ProPresenter stays installed with the same playlist prepared; its outputs are not
   launched. The checklist's last-resort section describes the switch.

## Audio interface

Any class-compliant multichannel USB interface. Install the vendor driver if required for
multichannel on Windows (Chrome uses WASAPI shared mode; the device must expose all
channels on one endpoint). Verify in Settings, Audio that the channel count is as expected.
