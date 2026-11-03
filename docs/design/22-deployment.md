# Design 22: Deployment

## Overview

| Piece           | Where                                            | How                                                                                                   |
| --------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Hub image       | Docker Hub `vrwarp/ordo-hub`                     | Built and pushed by GitHub Actions on tags `v*` and on `main` as `edge`                               |
| Hub container   | Synology NAS, Container Manager, Compose project | Pulled by tag; manual upgrade                                                                         |
| TLS and routing | DSM reverse proxy                                | One rule per hostname to `ordo-hub:8080`, WebSocket headers enabled                                   |
| Certificate     | DSM certificate store                            | Let's Encrypt wildcard for `*.<venue>.synology.me` issued by DSM, assigned to the reverse proxy rules |
| Presentation PC | Windows 11, Chrome stable                        | Hosts entries, Chrome policies, PWA install, auto-login                                               |

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
    deploy:
      resources:
        limits: { memory: 4g }
```

Backups land in `/volume1/docker/ordo/data/backups`, which the venue's Hyper Backup task
includes.

## DSM reverse proxy rules

For each hostname (`op`, `hub`, `stage`, `out1`..`out6`): source `HTTPS`, hostname
`<name>.<venue>.synology.me`, port 443, HSTS on; destination `HTTP localhost 8080`.
Custom headers: enable the WebSocket preset (`Upgrade` and `Connection`) on every rule,
plus `X-Forwarded-Proto https` and `X-Forwarded-Host $host`. Set the proxy timeout to
3600 s so WebSockets are not cut.

The hub routes by `Host`: `op` serves `apps/operator`, `out<k>` serves `apps/output`
with the output index, `stage` serves `apps/stage`, `hub` serves the API and files.

## Image

Multi-stage Dockerfile: `node:22-bookworm-slim` build stage running `pnpm install
--frozen-lockfile` and `pnpm build`; runtime stage adds `ffmpeg`, `poppler-utils`,
`libreoffice-impress` (no GUI packages), `fonts-dejavu`, and copies `apps/hub/dist` and
the built browser apps. Runs as a non-root user. Health check `GET /api/v1/health`.
Image size target under 1.5 GB (LibreOffice dominates).

## CI and release

- Every push: lint, typecheck, unit tests, Playwright, Docker build (no push).
- `main`: push `edge`.
- Tag `vX.Y.Z`: push `vX.Y.Z` and `latest`; create a GitHub release with the changelog.
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
