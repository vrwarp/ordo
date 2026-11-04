# ordo

A browser-native live presentation system for venues: lyrics, slides, media, lower thirds and a stage display,
run entirely in Google Chrome from a URL, with a small hub service on the venue NAS. Zero install on the
presentation computer, zero dropped frames on the audience screens.

Status: all three prototype milestones are implemented and tested in CI-like conditions. The WebGPU output
path and the zero-dropped-frame target still need verification on the venue PC (see
[Before the first service](#before-the-first-service)).

- [docs/README.md](docs/README.md): product requirements, technical design and decision records
- [docs/milestones.md](docs/milestones.md): the milestones and their rehearsal gates
- [deploy/README.md](deploy/README.md): installing the hub on a Synology NAS

## Layout

| Path                  | What                                                                           |
| --------------------- | ------------------------------------------------------------------------------ |
| `apps/hub`            | Node hub: API, WebSocket live service, SQLite library, media pipeline, backups |
| `apps/operator`       | Operator app: live view, editor, library, playlists, settings (React)          |
| `apps/output`         | Output window: WebGPU compositor with render and asset workers                 |
| `apps/stage`          | Stage display (DOM)                                                            |
| `packages/domain`     | Entity schemas, cue expansion, lyric parsing, default looks                    |
| `packages/protocol`   | WebSocket messages and the HTTP API contract                                   |
| `packages/live-state` | The shared pure live-state reducer and action mapping                          |
| `packages/client`     | Hub connection, clock sync, fallback bus, output link                          |
| `packages/renderer`   | Shared 2D text rasterizer and the WebGPU / Canvas 2D compositors               |
| `packages/cache`      | Service cache (OPFS, Cache API)                                                |
| `packages/audio`      | Web Audio channel-matrix engine and preview player                             |
| `packages/surfaces`   | Keyboard, Stream Deck (WebHID) and MIDI drivers                                |
| `packages/importers`  | ProPresenter 7, SongSelect and PPTX importers                                  |
| `tools/soak`          | Soak test that measures dropped frames over a long run                         |
| `e2e`                 | Playwright end-to-end tests                                                    |

## Development

Requires Node 22, pnpm 10, and ffmpeg, poppler-utils and LibreOffice for the media pipeline.

```bash
pnpm install
```

```bash
pnpm build
```

```bash
ORDO_DEV_PIN=246810 pnpm dev
```

Then open `http://op.localhost:8080` in Chrome. With `ORDO_DOMAIN=localhost` (the dev default) every role
has its own origin (`out1.localhost`, `stage.localhost`), just as at the venue, because Chrome resolves
`*.localhost` to this machine. `ORDO_DEV_PIN` sets the operate PIN; the edit PIN is the same digits reversed.

The hub serves the built apps from `apps/*/dist`. Rebuild an app with `pnpm --filter @ordo/operator build`
(or `output`, `stage`) after changing it.

### Checks

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm e2e
```

The end-to-end suite starts its own hubs. It covers outputs and the stage following a service, token
enforcement, a volunteer building and running a service in the operator UI, and a hub killed mid-service with
the operator carrying the outputs until the restarted hub adopts the state.

### Hub configuration

| Variable                  | Default                | Meaning                                                                                                                                                  |
| ------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORDO_DOMAIN`             | `localhost`            | Domain under which `op`, `out1`..`out6`, `stage` and `hub` live                                                                                          |
| `ORDO_DATA`               | `./.data`              | SQLite database, media, fonts, backups                                                                                                                   |
| `ORDO_PORT` / `ORDO_HOST` | `8080` / `0.0.0.0`     | Listen address                                                                                                                                           |
| `ORDO_TRUSTED_PROXY`      | none                   | CIDRs whose `X-Forwarded-*` headers are trusted (the DSM reverse proxy)                                                                                  |
| `ORDO_TZ`                 | `UTC`                  | Venue time zone for backups and countdowns                                                                                                               |
| `ORDO_APPS_DIR`           | repo `apps/`           | Where the built apps are                                                                                                                                 |
| `ORDO_IMPORT_ROOTS`       | `/data/import:/import` | NAS folders the ProPresenter import may read                                                                                                             |
| `ORDO_DEV_PIN`            | none                   | Sets the PINs automatically (development and tests only)                                                                                                 |
| `ORDO_LOG_LEVEL`          | `info`                 | Log level                                                                                                                                                |
| `ORDO_ALLOWED_HOSTS`      | none                   | Extra host names the hub answers besides the domain, `localhost` and loopback (comma or space separated, e.g. the NAS's LAN IP); others get 421          |
| `ORDO_SINGLE_PROCESS`     | unset                  | `1` runs the hub as one process instead of the supervisor with a live and a library process (same as `node main.js --single`; development and diagnosis) |
| `ORDO_CPU_WORKERS`        | `1`                    | Worker threads (1 to 8) in the library process for CPU-heavy parsing (ProPresenter, PowerPoint, fonts); each has a 512 MB heap                           |

## Release

Pushing to `main` publishes `vrwarp/ordo-hub:edge` to Docker Hub; a `vX.Y.Z` tag publishes that version and
`latest`. The workflow needs the repository secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.

## Before the first service

These cannot be verified in CI and are the rehearsal gates in [docs/milestones.md](docs/milestones.md):

1. On the venue PC, `chrome://gpu` reports WebGPU as hardware accelerated, and each output's diagnostics overlay
   (Ctrl+Shift+D) shows the `webgpu` compositor rather than `2d`.
2. A 60-minute soak on the venue PC passes:

   ```bash
   pnpm soak --hub https://op.<venue>.synology.me --pin <operate pin> --playlist "<name>" --minutes 60
   ```

3. Synology DDNS resolves the role subdomains and DSM issues the wildcard certificate (deploy/README.md).
4. A volunteer runs a full rehearsal alone from the printed checklist (operator app, Checklist).
