# Deploying the ordo hub on a Synology NAS

The hub is a single container (`vrwarp/ordo-hub`) that serves the API, the WebSocket and the operator,
output and stage apps. TLS is terminated by DSM's reverse proxy. Background: `docs/design/22-deployment.md`
and `docs/design/21-security.md`.

## 1. Hostnames and certificate (do this first)

The apps run on separate origins under your DDNS name, written `<venue>.synology.me` below:

| Host                                 | Serves                     |
| ------------------------------------ | -------------------------- |
| `op.<venue>.synology.me`             | Operator app (also `hub.`) |
| `out1.` … `out6.<venue>.synology.me` | Output windows             |
| `stage.<venue>.synology.me`          | Stage display              |

1. DSM, Control Panel, External Access, DDNS: confirm the name and that `op.<venue>.synology.me` resolves
   from outside the LAN.
2. DSM, Control Panel, Security, Certificate: add a Let's Encrypt certificate for `<venue>.synology.me`
   with the wildcard `*.<venue>.synology.me`. If DSM refuses the wildcard, see design/22 for the
   Cloudflare fallback. Only `ORDO_DOMAIN` changes.

## 2. Data folder

Create `/volume1/docker/ordo/data`. The container runs as uid 1000 (`node`), so give that uid write
access (File Station, Properties, Permission, or `sudo chown -R 1000:1000 /volume1/docker/ordo/data`
over SSH). Inside it the hub creates `ordo.db`, `media/`, `fonts/`, `uploads/`, `tmp/` and `backups/`.

Include `/volume1/docker/ordo/data` in the venue's Hyper Backup task. The nightly backups in
`backups/` plus the content-addressed `media/` and `fonts/` folders make up a complete backup.

## 3. Compose project

Container Manager, Project, Create, with `deploy/compose.yaml` from this repo. Set:

| Variable             | Value                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `ORDO_DOMAIN`        | `<venue>.synology.me`                                                                                                                      |
| `ORDO_TRUSTED_PROXY` | `172.16.0.0/12` (requests from DSM's reverse proxy arrive from the Docker bridge). Only these addresses may set `X-Forwarded-For`/`-Proto` |
| `ORDO_TZ`            | The venue's IANA time zone, e.g. `America/Los_Angeles`                                                                                     |
| `ORDO_PORT`          | `8080`                                                                                                                                     |
| `ORDO_IMPORT_ROOTS`  | Optional, colon separated. Folders `POST /import/pro7 {path}` may read from (default `/data/import:/import`)                               |

The container publishes only `127.0.0.1:8080`, so the hub is reachable only through the reverse proxy.
Never set `ORDO_DEV_PIN` in production.

## 4. DSM reverse proxy rules

Control Panel, Login Portal, Advanced, Reverse Proxy. Create one rule per hostname: `op`, `hub`,
`stage`, `out1` … `out6`.

| Field                                  | Value                                                               |
| -------------------------------------- | ------------------------------------------------------------------- |
| Source protocol / hostname / port      | HTTPS / `<name>.<venue>.synology.me` / 443, enable HSTS             |
| Destination protocol / hostname / port | HTTP / `localhost` / 8080                                           |
| Custom header (Create, WebSocket)      | adds `Upgrade: $http_upgrade` and `Connection: $connection_upgrade` |
| Custom header                          | `X-Forwarded-Proto: https`                                          |
| Custom header                          | `X-Forwarded-Host: $host`                                           |
| Advanced Settings, proxy timeouts      | 3600 s (connect, send and read), so WebSockets are not cut          |
| Advanced Settings, max body size       | large enough for video uploads, or use the resumable upload API     |

Assign the wildcard certificate to every rule (Security, Certificate, Settings).

The hub picks the app by the `Host` label: `op`/`hub` serve the operator, `out<k>` serve the output app,
`stage` serves the stage display. Every host serves `/api/v1/*` and `/ws`. A plain-HTTP request that comes
through the trusted proxy is redirected to HTTPS.

## 5. First run

Open `https://op.<venue>.synology.me`. While no PINs exist, the operator shows first-run setup, which sets
the Operate PIN and the Edit PIN (6 to 12 digits, different from each other). Setup is disabled once the
PINs exist. To change PINs later, an Operate session calls `PUT /api/v1/auth/pins`.

Five wrong PINs from one IP lock that IP out for 15 minutes. Fifty wrong PINs across all IPs lock the
whole login for 15 minutes. Lockouts are logged with the IP.

## 6. Presentation PC hosts entries

The presentation PC must reach the hub when the WAN is down. Add one line to
`C:\Windows\System32\drivers\etc\hosts` (open Notepad as administrator), using the NAS's LAN address:

```
192.168.1.10  hub.<venue>.synology.me op.<venue>.synology.me stage.<venue>.synology.me out1.<venue>.synology.me out2.<venue>.synology.me out3.<venue>.synology.me out4.<venue>.synology.me out5.<venue>.synology.me out6.<venue>.synology.me
```

Check it with `ping op.<venue>.synology.me`, which must answer from the LAN address. DSM's reverse proxy
listens on the LAN too, and the wildcard certificate still matches.

Chrome policies, the PWA install and the rest of the PC setup are in design/22, "Presentation PC setup".

## 7. Backups and restore

- Nightly at 03:00 `ORDO_TZ`, the hub runs `VACUUM INTO /data/backups/ordo-YYYY-MM-DD.db` and writes
  `media-manifest-YYYY-MM-DD.json`, which lists every content hash. Backups are kept for 30 days.
- Operate role: `POST /api/v1/backup/run` makes an on-demand backup and `GET /api/v1/backup/list` lists
  them.
- Restore (never during a service):

  ```sh
  docker compose stop ordo-hub
  docker compose run --rm ordo-hub restore 2026-11-01        # or a file name: ordo-2026-11-01.db
  docker compose start ordo-hub
  ```

  `restore` checks the backup's integrity and verifies every media hash in the manifest, then keeps the
  current database as `backups/ordo-pre-restore-<time>.db` before swapping. If any media file is missing
  or its content differs, it refuses to restore. Add `--force` to restore anyway.

## 8. Upgrades

Change the image tag in the project and redeploy. Never upgrade on a Saturday evening or a Sunday. Jobs
that were running (transcodes, imports) resume after the restart. The live state is restored from its
snapshot and journal.

## 9. Diagnostics

`GET /api/v1/diagnostics/export` (Operate role) downloads a zip containing the last 2,000 log lines, the
last 500 live journal events, the settings with tokens stripped, and the output health table. Container
logs are JSON lines (`docker logs ordo-hub`). Output tokens are redacted from logged URLs.

## Building the image

```sh
docker build -t vrwarp/ordo-hub:dev .
docker run --rm -p 8080:8080 -e ORDO_DOMAIN=localhost -v "$PWD/.data:/data" vrwarp/ordo-hub:dev
```

Then open `http://op.localhost:8080`. Chrome resolves `*.localhost` to loopback, so the role origins work
without a reverse proxy.

## Local development

```sh
pnpm install
pnpm --filter @ordo/hub dev       # tsx watch; ORDO_DATA=./.data, ORDO_DOMAIN=localhost by default
ORDO_DEV_PIN=111111:222222 pnpm --filter @ordo/hub dev   # pre-set Operate and Edit PINs (dev only)
```
