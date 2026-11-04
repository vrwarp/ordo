# Design 12: Hub

`apps/hub`: Node 22, TypeScript, Fastify for HTTP, `ws` for WebSocket, better-sqlite3 in
WAL mode, a job queue for media work, all in one container behind DSM's reverse proxy. Inside the
container the hub runs as two supervised processes (see Processes, and design/25 "Hub").

## Responsibilities

1. Serve the four browser apps as static files, with per-origin routing by `Host`.
2. Library CRUD with revisions and search deltas.
3. Live state: run the shared reducer, journal events, broadcast deltas, hold the clock.
4. Media pipeline: ingest, hash, transcode, poster, loudness, PPTX and PDF rendering, Google Fonts fetch.
5. Service cache manifests.
6. Auth: PIN sessions, output tokens, rate limiting.
7. Backups and restore.
8. Health, logs, diagnostics export.

## Processes

```
tini
 └── supervisor (main.js)                  no network, no SQLite; restarts children, relays IPC
      ├── library process (main.js __child library)   127.0.0.1:<ephemeral>, secret-gated
      │     HTTP API (library, media, imports, settings, auth PIN flows, backups, diagnostics)
      │     ordo.db, job queue, ffmpeg/pdftoppm/soffice children, CPU worker-thread pool
      └── live process (main.js __child live)         ORDO_PORT: the front door
            /ws, live API, output config, manifest, files of the live playlist, the built apps,
            live.db (journal, snapshots, cached library copies), proxy to the library process
```

**Why**: the live service is the only part the service depends on at 10:00 on Sunday. A runaway import,
an out-of-memory transcode or a native crash in the library process cannot take it down; a crash of the
live process costs about a second (restart from its snapshot) while outputs hold their last frame and the
operator rides it out on the fallback bus.

**Supervisor** (`src/supervisor.ts`): starts the library process, then the live process. Each child sends
a heartbeat every 500 ms; a child that exits, or is silent for 5 s (live) or 60 s (library, which may run a
long synchronous `VACUUM INTO`), is killed and restarted after 100, 200, 400, 800, 1000 ms, at most five
times a minute. Until a child reports ready it may be silent for up to 30 s (a cold boot on a slow NAS
loads the bundle and opens SQLite before its first heartbeat); only then does the stall timeout apply. A
child whose supervisor vanishes while it is still starting exits at once rather than linger holding the
port. Past the budget a failed library process stays down (`/health` reports `library: failed`,
the service keeps running, library calls answer 503), and a failed live process ends the supervisor with
exit code 1 so the container's restart policy takes over. The supervisor relays three things and replays
the last of each to a restarted child: the library's address (to the live process), the live process's
edit locks and mode (to the library), and library changes (to the live process, which broadcasts them).
`<data>/supervisor.json` holds pids, states and restart counts. SIGTERM: both children get SIGTERM,
SIGKILL after 5 s. If the supervisor itself is killed, the live process writes its snapshot and exits at
once (like a crash: no goodbyes), the library process stops its jobs (re-queued on the next start).

**Routing** (`src/liveproc.ts`, `src/proxy.ts`): the live process listens on `ORDO_PORT` and answers
itself `/ws`, `/api/v1/{live, live/events, actions, cache/manifest, output/config, auth/me, health}`,
`/api/v1/files/<hash>` for files it knows (the live playlist's media and fonts, every font, the logo) and
every non-API path (the built apps). Everything else under `/api/v1` is streamed to the library process
over loopback. We chose the live process as the front door rather than the supervisor so the supervisor
stays free of network input, and rather than two DSM rules so the deployment is unchanged. The proxy is
deliberately small (one request in, one out, bodies streamed both ways, no retries) and has its own tests.
Its failure modes: library down or restarting → `503 library_unavailable` with `Retry-After: 1`, sent
without forwarding anything (the request body is drained, so the client may simply retry); library dies
after receiving part of a request but before answering → the same 503, though part of the body was
already sent (an upload must start again; the multipart temp file it left is removed when the library
starts); library dies mid-response → the client connection is reset; library silent for 120 s on an open
request → 504.

**Read your writes**: the library's answer to every write carries the library sequence after it
(`x-ordo-library-seq`, stripped before the client sees it); the proxy holds that answer until the live
process has applied the changes up to that sequence (its context copy refreshed, the delta broadcast), at
most 2.5 s. So a `PUT /settings/looks` followed at once by an output's `GET /output/config` sees the new
look. The proxy rebuilds `X-Forwarded-For/Host/Proto` from what the live
process trusted and adds the per-boot internal secret; the library process trusts forwarding headers
from loopback only together with that secret and refuses any request without it, so nothing else on the
host can talk to it.

**Data between them**: the live process keeps its journal and snapshots in its own `live.db`. It reads
the library only through `GET /internal/context` (all settings with tokens, fonts, logo) and `GET
/internal/golive/<playlist>` (fetched when the operator goes live), and keeps the last copy of each in
`live.db`, so a library outage blocks neither a reconnect nor a GO, and a goLive of a playlist fetched
before still works. Library changes are applied in order: a batch touching the context (settings, fonts,
the logo media) first refreshes the copy (bounded by the 1.5 s fetch timeout), and only then is the delta
broadcast, so an output that refetches its config on the delta gets the new look. Outputs and the stage
receive ids only, for settings, fonts and the logo. A context refresh that is not part of a delta (the
library came back; the first refresh after a live-process restart) sends outputs and the stage a
settings-only delta so they refetch; they also refetch on every `welcome`.

goLive against the library: a library that is merely restarting is waited for up to 1.5 s. If it stays
down, or is up but does not answer within 1.5 s (stalled), a cached copy is used and the goLive carries a
`degraded` entry (cue -1) naming the copy's time ("Went live from the copy of this playlist saved 3 days
ago …"), so the operator sees it is not the current playlist. Without a cached copy the goLive is
refused: "The library did not answer; try Go live again in a moment" (stalled), "The library is
restarting; try Go live again in a moment" (down), or, when the library has failed for good, a reason
naming that. A playlist the library says does not exist is "not found".
Sessions live in ordo.db, which the live process opens directly (WAL readers never wait for the library;
its sliding-expiry writes use a 50 ms busy timeout and are skipped when busy; it never checkpoints).
Output tokens come from the context copy; a rotated or removed token closes that output's sockets.

**One process** for tests and debugging: `createHub()` (in-process, the hub tests use it) and
`node main.js --single` / `ORDO_SINGLE_PROCESS=1` run the same modules in one process with ordo.db
holding the live tables.

**CPU work** (`src/pool.ts`, `src/cpu.worker.ts`): ProPresenter decode (including its RTF), PPTX text
extraction and font table parsing run on a worker-thread pool in the library process (`ORDO_CPU_WORKERS`,
default 1). Each task has a timeout (pro7 15 min, pptx 2 min, font 15 s); a stuck or aborted task
terminates its worker and the next task gets a fresh one. Each worker has its own small heap (512 MB old
generation, 64 MB young): a runaway parse fails within seconds inside its worker, with "… needs more
memory than an import may use (512 MB) …", instead of growing the library process towards the container's
memory limit. Only a worker that cannot start at all falls
back to inline parsing; a worker that dies while working fails that task.

## HTTP API

All under `https://hub.<venue>.synology.me/api/v1`. JSON bodies validated with the
`packages/domain` schemas. Errors are `{ error: { code, message } }`.

| Method and path                                                                                                        | Role                                                 | Purpose                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /auth/pin`                                                                                                       | none                                                 | Exchange a PIN for a session cookie; returns the role                                                |
| `POST /auth/logout`                                                                                                    | any                                                  | End session                                                                                          |
| `GET /library/snapshot?since=<seq>`                                                                                    | edit, operate                                        | Full snapshot or deltas of presentations, playlists, media, fonts, themes, looks, outputs            |
| `GET                                                                                                                   | POST                                                 | PUT                                                                                                  | DELETE /presentations[/:id]` | edit | CRUD; PUT requires `rev` and returns 409 on mismatch |
| `GET /presentations/:id/revisions`, `POST /presentations/:id/restore/:rev`                                             | edit                                                 | Version history                                                                                      |
| `GET                                                                                                                   | POST                                                 | PUT                                                                                                  | DELETE /playlists[/:id]`     | edit | CRUD; live playlist returns 423 Locked on PUT        |
| `POST /media` (multipart, resumable via `Upload-Offset`)                                                               | edit                                                 | Upload; returns media in `uploaded` state                                                            |
| `GET /media/:id`, `PUT /media/:id`, `DELETE /media/:id`                                                                | edit                                                 | Metadata                                                                                             |
| `GET /files/:hash`                                                                                                     | output token or any role                             | Content-addressed file delivery with long cache headers and range support                            |
| `POST /fonts/upload`, `POST /fonts/google { family }`, `GET /fonts`                                                    | edit                                                 | Fonts                                                                                                |
| `POST /import/pro7` (zip or NAS path), `POST /import/songselect` (file or text), `POST /import/document` (pptx or pdf) | edit                                                 | Import jobs; return a job id                                                                         |
| `GET /jobs/:id`                                                                                                        | edit                                                 | Job state and log                                                                                    |
| `GET                                                                                                                   | PUT /settings/{looks,outputs,audio,keymap,surfaces}` | operate                                                                                              | Settings                     |
| `POST /outputs/:id/token/rotate`                                                                                       | operate                                              | New output token                                                                                     |
| `GET /live`                                                                                                            | operate, output                                      | Current live state (full)                                                                            |
| `POST /live/events`                                                                                                    | operate                                              | Submit live events over HTTP (used by surfaces' HTTP bridge and tests); WebSocket is the normal path |
| `GET /cache/manifest`                                                                                                  | operate, output                                      | The live service cache manifest                                                                      |
| `GET /health`, `GET /diagnostics/export`                                                                               | operate                                              | Hub health; zip of logs, journal tail, settings                                                      |
| `POST /backup/run`, `GET /backup/list`                                                                                 | operate                                              | Backups                                                                                              |

## WebSocket

`wss://hub.<venue>.synology.me/ws`. Authenticated by the session cookie (operator,
stage) or `?token=` (outputs). Message schemas in `packages/protocol`
([design/13](13-protocol.md)). One socket per window.

Broadcast fan-out keeps per-socket queues; if an output's queue exceeds 100 messages the
hub sends a full `live.state` instead of deltas and resets the queue.

Command validation on the hub (`live.ts`):

- Event schemas are strict (unknown keys are rejected, not stripped) and bounded: `at` is a
  finite non-negative number, `cueIndex`/`sectionIndex` are small non-negative integers,
  `ttlMs` is at most a day.
- An operator `at` outside `[now − 500 ms, now + 2 s]` of the hub clock is replaced by
  `now + 33 ms` and logged: a bad clock-offset estimate must never seek a video or skew a
  timer.
- `media.ended` and `audio.ended` are believed only from the audio-master output
  (`outputs[].audioMaster`, exactly one, enforced by `PUT /settings/outputs`); other
  outputs and the stage display are rejected. With no master configured any output is
  believed.
- `preview` (prd/03 "Send to preview") is relayed from the operator to the one output named
  in `to`, with `from: "operator"` stamped, exactly like `rtc.signal`.

`GET /library/snapshot?since=<seq>` answers with `{ seq, since, changes[] }` from the
`library_changes` log (the last 20,000 seqs) when it still covers `since`; otherwise, and
when `since` is absent, with the full snapshot.

Shutdown (`SIGTERM`): stop the backup timer, abort jobs (their child processes get
`SIGKILL` through the abort signal), snapshot the live state, send `bye` on every socket
and terminate the sockets without waiting for a close handshake, close HTTP. Every step is
bounded, so the process exits within about 2 s even with a frozen client; `main.ts` keeps a
5 s backstop.

## Storage

SQLite file at `/data/ordo.db`, WAL mode, `synchronous=NORMAL`. Tables: `presentations`,
`presentation_revisions`, `playlists`, `media`, `files`, `fonts`, `themes`, `looks`,
`outputs`, `settings`, `sessions`, `auth_attempts`, `jobs`, `job_attempts`, `library_changes`,
`uploads`. Migrations with a simple numbered-SQL runner; every migration is idempotent and tested.

`/data/live.db` (live process only): `live_journal (seq, at, cmd_id, kind, event_json)`,
`live_snapshot (singleton)`, `live_snapshot_prev` (the two snapshots before it) and `live_kv` (the cached
library context and goLive bundles). On its first start the live process copies the journal and snapshot
over from ordo.db, where the one-process hub kept them. In one-process mode the same tables live in
ordo.db.

**Validated restore**: on start the live service takes the newest snapshot that parses, passes
`isLiveStateShape` and has no `checkInvariants` violation, trying the current one and then the two
previous ones; it then replays the journal after it and stops (with a logged warning, never an exception)
at the first row that does not parse, is not a live event, does not apply, or leads to an unsound state.
With nothing usable it starts idle. Warnings are in the diagnostics export (`hub.json`, `live.restoreWarnings`),
and a restore that skipped something writes a fresh snapshot right away. A snapshot is only written from
a state that passes the same checks; an operator state offered by `live.adopt` must pass them too.

**Jobs that crash their process**: every start of a job is counted in `job_attempts`. A job found
`running` at startup (its process died under it) is re-queued, unless it has been started three times
already: then it fails for good with "Stopped 3 times while this job was running", and a media item it
was processing is marked failed. A clean shutdown does not count as an attempt.

Files under `/data/media/<hh>/<hash>.<ext>`, `/data/fonts/`, `/data/uploads/` (temporary),
`/data/backups/`.

## Media pipeline

A single in-process job queue (one video job at a time, two light jobs concurrently;
the NAS CPU is shared with other services). Jobs are persisted in `jobs` so a restart
resumes them.

| Job               | Tool                                                                                                                                                                           | Output                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `probe`           | `ffprobe`                                                                                                                                                                      | duration, dimensions, alpha, audio channels |
| `transcode-video` | `ffmpeg -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -g 60 -movflags +faststart -c:a aac -b:a 256k` scaled to fit 1920x1080, fps capped at 60                          | delivery MP4                                |
| `transcode-alpha` | `ffmpeg -c:v libvpx-vp9 -pix_fmt yuva420p`                                                                                                                                     | delivery WebM with alpha                    |
| `gif`             | ffmpeg: animated GIF to H.264 loop (opaque) or VP9 alpha (transparent); still GIF to PNG                                                                                       | delivery file                               |
| `poster`          | ffmpeg frame at 1 s, 640x360 JPEG                                                                                                                                              | poster                                      |
| `audio`           | ffmpeg loudnorm measurement, AAC 256k delivery                                                                                                                                 | delivery and LUFS                           |
| `pdf-render`      | `pdftoppm -r 144 -png` then scale to 1920x1080                                                                                                                                 | one PNG media per page                      |
| `pptx-render`     | `soffice --headless --convert-to pdf` then `pdf-render`                                                                                                                        | PNGs                                        |
| `pptx-text`       | unzip `ppt/slides/slideN.xml`, read `<a:t>` runs and `<a:off>/<a:ext>` in EMU, convert to logical px                                                                           | ExtractedText[] per slide                   |
| `pro7-import`     | `packages/importers` (protobuf decode) in a `worker_threads` worker; zip uploads are streamed from disk, media entries spilled to `tmp/`, documents capped at 256 MB in memory | presentations, playlists, media uploads     |
| `font-google`     | fetch the family's CSS from Google Fonts with a desktop UA, download referenced woff2 files, store as `Font` rows                                                              | fonts                                       |

The Docker image includes `ffmpeg`, `poppler-utils` and LibreOffice (`libreoffice-impress`
with a minimal font set plus the venue's uploaded fonts mounted so PPTX renders use them).

Import jobs are resumable: `pro7-import` records every media id, presentation id and
playlist id it wrote in its job payload and skips them when the job is re-queued after a
crash or restart; `document` records the stored page images the same way. ProPresenter
presentations and playlists are saved under their ProPresenter UUIDs, so importing the same
library twice updates the earlier copies instead of duplicating them. `POST /import/pro7`
and `POST /import/document` answer 423 while a playlist is live. `tmp/` is wiped at
startup: everything in it belongs to a job that is re-queued anyway.

## Service cache manifest

On `goLive`, the hub walks the resolved playlist: every presentation's media (backgrounds,
images), every media item's delivery and poster, every font referenced by any text style
or look, the logo, holding slides, and the look definitions. It writes
`{ seq, files: [{ hash, bytes, mime }], presentations: [...], looks: [...] }` and
announces it. The manifest is immutable for the live session.

## Auth

- PIN hashes with Argon2id. Sessions in SQLite with role, device fingerprint
  (user agent hash), expiry. Cookie `ordo_session`, `HttpOnly; Secure; SameSite=Lax;
  Domain=.<venue>.synology.me` so one login covers the operator and stage origins.
- Output tokens: 32 random bytes base64url, stored hashed, one per output, carried as
  `?token=` on the output URL and the WebSocket.
- Rate limiter keyed by forwarded client IP for `/auth/pin`.
- Role checks are route-level decorators; tests assert every route declares one.

## Backups

A nightly job at 03:00 venue time (`settings.general.timeZone`, the same zone countdowns
use; `ORDO_TZ` only seeds it on first run and stands in if it is unusable): `VACUUM INTO
/data/backups/ordo-<date>.db`, plus a `media-manifest-<date>.json` listing hashes and paths
(media files are already immutable and deduplicated, so the manifest plus the media
directory is the backup). The database is vacuumed into `<name>.partial` and renamed when
complete (the manifest likewise), so an interrupted run never leaves a file under a backup's
name; leftover `.partial` files are removed by the next run. The timer is armed strictly
after the current run with a minimum delay of a minute, and a run is skipped when today's
file already exists and passes `integrity_check` (a restart after 03:00); a file that fails
it is removed and the backup taken again. Retention 30 days; the `ordo-pre-restore-*.db` copies that `restore` keeps are
capped at the newest three. `ordo-hub restore <date>` stops the service, swaps the
database, and verifies every manifest hash exists. `live.db` (the live journal, snapshots
and the live process's copies of the library) is not part of a backup: the live state is
not restored, and a restore clears the cached library copies in `live.db` so the live
process fetches the restored library's settings and output tokens when it starts.

## Logging and diagnostics

Pino JSON logs to stdout (Docker captures); each line carries `proc` (`supervisor`, `live`, `library`).
A ring buffer of the last 2,000 lines per process is exported by `/diagnostics/export` (`logs.ndjson`
from the library process, `logs-live.ndjson` from the live process) together with the last 500 journal
events, settings without secrets, the health table, the process states and restart counts, restore
warnings, the goLive quarantine list, socket limit closures and the CPU pool counters. `GET /health`
adds `library` (the library process state as the live process sees it) and `processes`.

## Bad data at the boundary

Design/25's table, as implemented in the hub:

- **HTTP bodies**: every body schema is `.strict()` at the top level (unknown keys are 400) and bounded
  (string lengths, array sizes, numeric ranges). Entities may echo the server's `rev`, `createdAt` and
  `updatedAt`. The domain schemas carry generous bounds (ids 200 chars, text 20,000, 1,000 objects per
  slide, 5,000 slides per section, coordinates ±100,000, colours 0..255 and alpha 0..1, durations a day).
- **WebSocket from clients**: 64 KiB per message (an operator's `live.adopt` and `preview` up to 16 MiB),
  a token bucket of 50 messages refilled at 50/s per socket. A socket that breaks a limit gets
  `bye too-large` or `bye rate-limited` and close 1008; others are unaffected.
- **goLive**: every presentation is validated against the schema. A slide that fails is replaced by an
  empty slide with the same id, a presentation whose own fields are broken keeps its valid sections, one
  that cannot be read becomes empty, an invalid playlist item is skipped. The service still goes live and
  `resolved.degraded: { cueIndex, reason, presentationId?, slideId? }[]` lists what was quarantined (one
  entry per affected cue, `cueIndex` -1 when nothing shows it); the operator displays it. Missing
  presentations and media that is not ready still refuse the goLive.
- **Files**: images up to 16384×16384, video and audio up to 4 h, video up to 8K (7680×4320), GIFs up to
  20,000 frames, font files up to 256 tables, 4 MiB per table read, 64 MiB of WOFF2 table data. A file
  beyond a limit fails its media job with the reason and is not retried automatically.
- **Settings**: read through their schema with defaults for missing fields (a document with a bad field
  keeps its valid fields; an invalid look or output is dropped from the list); writes check exactly one
  enabled audio master, unique `out<k>` host indices, unique look ids, and that every output's look exists.
- **Journal and snapshots**: validated restore (Storage).

## Configuration

Environment variables: `ORDO_DOMAIN` (`<venue>.synology.me`), `ORDO_DATA=/data`,
`ORDO_TRUSTED_PROXY` (DSM's address), `ORDO_TZ`, `ORDO_PORT=8080`,
`ORDO_ALLOWED_HOSTS` (optional extra host names), `ORDO_CPU_WORKERS` (worker threads for
CPU-heavy parsing, 1 to 8, default 1), `ORDO_SINGLE_PROCESS=1` (one process instead of the
supervisor and its two children; development and diagnosis), `ORDO_LOG_LEVEL`, and for
development and tests only `ORDO_DEV_PIN` and `ORDO_APPS_DIR`. The supervisor sets
`ORDO_INTERNAL_SECRET`, `ORDO_LIBRARY_URL`, `ORDO_LIVE_URL` and `ORDO_LIVE_LOCKS` for its
children; they are not configuration. First run with no PINs serves a setup
page on the operator origin that sets both PINs; the setup page is disabled once PINs
exist.

The hub answers only for hosts it knows: `ORDO_DOMAIN` and any label under it, `localhost`
and its labels, `127.0.0.1`/`::1`, and `ORDO_ALLOWED_HOSTS`; anything else gets `421` on
HTTP and on the WebSocket upgrade. Behind the trusted proxy the browser's host arrives in
`X-Forwarded-Host`, which the hub uses for the allow-list, app routing and the CSP
`connect-src`; from any other peer the header is ignored.
