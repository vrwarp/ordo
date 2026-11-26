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
loads the bundle and opens SQLite before its first heartbeat); only then does the stall timeout apply.
Silent starts have their own budget, since the crash budget alone would never catch them (two kills a
minute at a 30 s grace, with a hung child holding the port between them): a child killed at the end of
its start grace that is silent again on the next start, with no ready in between, is failed at that
second kill. Once a child has come up in this supervisor's lifetime its boot time is known, and a later
start gets three times that boot (at least 5 s, never below the stall timeout) instead of the full 30 s,
so a restart that hangs is noticed in seconds. A
child whose supervisor vanishes while it is still starting exits at once rather than linger holding the
port. Past the budget a failed library process stays down (`/health` reports `library: failed`,
the service keeps running, library calls answer 503), and a failed live process ends the supervisor with
exit code 1 so the container's restart policy takes over. The supervisor relays four things and replays
the last of each to a restarted child: the library's address (to the live process), the live process's
edit locks and mode (to the library), library changes (to the live process, which broadcasts them), and
the library's size (`stats`, to the live process, for `GET /health`; the library process measures it at
start and 3 s after a change that is not only job progress).
`<data>/supervisor.json` holds pids, states and restart counts. SIGTERM: both children get SIGTERM,
SIGKILL after 5 s. If the supervisor itself is killed, the live process writes its snapshot and exits at
once (like a crash: no goodbyes), the library process stops its jobs (re-queued on the next start).

**Routing** (`src/liveproc.ts`, `src/proxy.ts`): the live process listens on `ORDO_PORT` and answers
itself `/ws`, `/api/v1/{live, live/summary, live/events, actions, cache/manifest, output/config, auth/me, health}`,
`/api/v1/files/<hash>` for files it knows (the live playlist's media, geometry and decoration files and
fonts, every font, the logo) and
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
/internal/golive/<playlist>` (fetched when the operator goes live, beside the running service: "Going live
prepared beside the running service" below), and keeps the context and the last 8 goLive copies in
`live.db` (one `live_kv` row per copy, `bundle:<playlist>`, written after its goLive applied), so a library
outage blocks neither a reconnect nor a GO, and a goLive of a playlist fetched before still works. Library changes are applied in order: a batch touching the context (settings, fonts,
and the media the settings name: the logo and the looks' holding images, `contextMediaIds`) first refreshes
the copy (bounded by the 1.5 s fetch timeout), and only then is the delta broadcast, so an output that
refetches its config on the delta gets the new look. Outputs and the stage receive ids only, for settings,
fonts and those media. Any other media change (a photo upload: uploaded, processing, ready) neither
refreshes the copy nor reaches the outputs (design/28 P0; before, every media change counted while no logo
was set). A context refresh that is not part of a delta (the
library came back; the first refresh after a live-process restart) sends outputs and the stage a
settings-only delta so they refetch; they also refetch on every `welcome`.

goLive against the library: a library that is merely restarting is waited for up to 1.5 s. The goLive copy
then has 1.5 s to its response headers (`FETCH_TIMEOUT_MS`), after which its body may take as long as it
keeps arriving: no bytes for 1.5 s (`PROGRESS_TIMEOUT_MS`) ends it, and so does a 30 s ceiling
(`BUNDLE_CEILING_MS`); a copy over 64 MiB is not read (its service would be refused, W58). If the library
stays down, or is up but does not answer in time (stalled), a cached copy is used and the goLive carries a
`degraded` entry (cue -1) naming the copy's time ("Went live from the copy of this playlist saved 3 days
ago …"), so the operator sees it is not the current playlist. Without a cached copy the goLive is
refused: "The library did not answer; try Go live again in a moment" (stalled), "The library is
restarting; try Go live again in a moment" (down), or, when the library has failed for good, a reason
naming that. A playlist the library says does not exist is "not found".

**Going live prepared beside the running service** (design/29 §2.3 M8): a goLive is prepared before it
enters the live process's command queue, so GO, Next and Clear sent meanwhile apply to the running service
at once (before, every command behind a goLive waited for its fetch, up to about 3 s). The operator first
calls `POST /live/prepare` (design/13 "Prepare before goLive"), which starts the fetch above; the copy's
bytes go, without a copy on the loop (shared memory), to a worker thread (`src/golive-worker.ts`, one,
started on first use, gone after a minute idle; heap 1 GiB; a check past 60 s is abandoned and its worker
terminated) that parses them, checks and quarantines every presentation (`quarantinePresentation` through
`resolvePlaylist`, as the loop did), resolves, serialises the resolved copy once and hashes that buffer:
its SHA-256 is the copy's `resolvedId` (design/29 M2). The operator sends goLive once the prepare reports
`ready` (or `failed`: the goLive is then refused with its reason); the goLive applies at once with one
`JSON.parse` of the prepared buffer. A goLive that arrives without a prepare (an older operator, the
`/actions` bridge, a test) prepares itself the same way, outside the queue; goLives keep their order among
themselves, and End service keeps its order with them (a goLive sent before it and still being prepared is
cancelled: "Go live cancelled by End service"). A prepared copy not used within 10 s is dropped; only the
latest prepare's copy is kept ready, and at most two prepares are in flight (each holds its copy, up to
64 MiB, in the live process), a third refused with a reason. The in-process source (`createHub`, `--single`)
still resolves on its loop.
Sessions live in ordo.db, which the live process opens directly (WAL readers never wait for the library;
its sliding-expiry writes use a 50 ms busy timeout and are skipped when busy; it never checkpoints).
Output tokens come from the context copy; a rotated or removed token closes that output's sockets.
Until the live process has a context copy at all (it started before the library and has never fetched
one, or a restore cleared the copies) it cannot tell a valid token from a revoked one, so a socket
arriving with a token then gets `bye retry`, which the client treats as an ordinary reconnect (back in
0.5 to 5 s), not `bye unauthorized`, which it treats as revoked credentials (minutes of back-off and an
"output revoked" notice to the operator).

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
back to inline parsing (never for a PowerPoint deck: that import fails instead, design/27 §12); a worker
that dies while working fails that task.

## HTTP API

All under `https://hub.<venue>.synology.me/api/v1`. JSON bodies validated with the
`packages/domain` schemas. Errors are `{ error: { code, message } }`. "Lowest cap" is the lowest session cap
the route accepts (design/28 §3.2); a capped session below it gets 403 `cap`.

| Method and path                                                                                                        | Role                     | Lowest cap                                                  | Purpose                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/pin`                                                                                                       | none                     | view                                                        | Exchange a PIN for a session cookie; returns the role. `{ pin, remember?, cap? }`: with `cap` `light` or `view` (a phone, design/28 §3.2) the answer is `{ role: 'edit', cap }` whatever PIN matched, a one-hour capped session, never remembered (the device cookie is cleared); no `cap` or `full`: as before |
| `GET /auth/me`                                                                                                         | none                     | view                                                        | `{ role, setupRequired, version, domain, cap?, caps }`: `cap` for a capped session; `caps` (`['full','light','view']`) signed in or not, absent from an older hub                                                                                                                                               |
| `POST /auth/logout`                                                                                                    | any                      | view                                                        | End session                                                                                                                                                                                                                                                                                                     |
| `GET /library/snapshot?since=<seq>`                                                                                    | edit, operate            | view                                                        | Full snapshot or deltas of presentations, playlists, media, fonts, themes, looks, outputs                                                                                                                                                                                                                       |
| `GET`, `POST`, `PUT`, `DELETE /presentations[/:id]`                                                                    | edit                     | view (GET), light (POST, PUT), full (DELETE)                | CRUD; PUT requires `rev` and returns 409 on mismatch. A capped session's save (design/28 §3.2) is compared with the stored version per slide id when its `rev` matches: a change to `midiCues`, `pptx` or `source` is 403 `cap` with `field` and `slideId`                                                      |
| `GET /presentations/:id/revisions`, `POST /presentations/:id/restore/:rev`                                             | edit                     | light                                                       | Version history                                                                                                                                                                                                                                                                                                 |
| `GET`, `POST`, `PUT`, `DELETE /playlists[/:id]`                                                                        | edit                     | view (GET), light (POST, PUT), full (DELETE)                | CRUD; live playlist returns 423 Locked on PUT. A capped session's save is compared per item id when its `rev` matches: `keepBackground`, `audioMediaId`, `countdownTimer`, media items' `loop`, `onEnd`, `audio`, and action and timer items are 403 `cap` with `field` and `itemId`                            |
| `POST /media` (multipart, resumable via `Upload-Offset`)                                                               | edit                     | light (with `POST`, `GET` and `PATCH /media/uploads[/:id]`) | Upload; returns media in `uploaded` state. An SVG may come with its still (part `raster`, see "Media pipeline"); a bad one is 400 `bad_raster`                                                                                                                                                                  |
| `PUT /media/:id/still` (multipart, part `raster`)                                                                      | edit                     | light                                                       | An SVG's still sent after the SVG (the resumable upload carries none): checked as at upload; 409 when the SVG has one or its job runs, 400 `bad_raster`, 413 over 96 MB                                                                                                                                         |
| `GET /media/:id`, `PUT /media/:id`, `DELETE /media/:id`                                                                | edit                     | view (GET), light (PUT; per field), full (DELETE)           | Metadata; `DELETE` of media that stored presentations or playlists use answers 409 `media_in_use` naming them (`presentations`, `playlists`), unless `?force=1`. From a capped session `PUT` changes name and tags only (`loop`, `isBackground`, `audio`: 403 `cap` with `field`)                               |
| `GET /files/:hash`                                                                                                     | output token or any role | view                                                        | Content-addressed file delivery with long cache headers and range support; an SVG as `Content-Disposition: attachment` (design/21)                                                                                                                                                                              |
| `POST /fonts/upload`, `POST /fonts/google { family }`, `GET /fonts`                                                    | edit                     | full (`GET /fonts`: view)                                   | Fonts. `DELETE /fonts/:id` of a face the live playlist draws with answers 423 "This font is used by the live playlist" (design/28 P0; the live process reports the frozen copy's font ids with its locks, as for media)                                                                                         |
| `POST /import/pro7` (zip or NAS path), `POST /import/songselect` (file or text), `POST /import/document` (pptx or pdf) | edit                     | full                                                        | Import jobs; return a job id. `document`: form field `renderer`, `native` by default (editable slides, `pptx-native`, design/27), `libreoffice` or `pptx-preview` (page pictures); native options `extendBackgrounds`, `transitionSounds` (`1`/`0`)                                                             |
| `GET /jobs/:id`                                                                                                        | edit                     | full                                                        | Job state and log                                                                                                                                                                                                                                                                                               |
| `POST /presentations/:id/pptx-reference`                                                                               | edit                     | full                                                        | 'Show PowerPoint picture': queues `pptx-reference` (design/27 §5); body `{ showPicture? }` (slide ids switched to the picture, ≤ 5,000; absent: all); 423 while live                                                                                                                                            |
| `GET /presentations/:id/pptx-reimport`, `POST /presentations/:id/pptx-reimport`                                        | edit                     | full                                                        | 'Re-import from PowerPoint' (design/27 §11): `GET` answers the plan (each slide's kind and action, nothing written); `POST` queues `pptx-reimport` (202) with `{ slideIds?, reset?, keep? }` (strict, ≤ 5,000 ids each); 400 `no_pptx` without a stored deck, 423 while live                                    |
| `POST /presentations/:id/slides/:slideId/make-editable`                                                                | edit                     | full                                                        | 'Make editable' on an imported page: a legacy PowerPoint page or a native import's LibreOffice page whose deck is stored is rebuilt (202, the `pptx-reimport` job of that slide; a page again gets its text boxes); any other page (a PDF, a deck gone) gets text boxes over its picture (200); 423 while live  |
| `GET`, `PUT /settings/{looks,outputs,audio,keymap,surfaces,phones}`                                                    | operate                  | view (GET), full (PUT)                                      | Settings; `GET` also for edit (outputs without tokens). `phones`: the Phones switch (design/28 P0), `{ enabled }`, off by default                                                                                                                                                                               |
| `POST /outputs/:id/token/rotate`                                                                                       | operate                  | full                                                        | New output token                                                                                                                                                                                                                                                                                                |
| `GET /live`                                                                                                            | operate, output          | full                                                        | Current live state (full)                                                                                                                                                                                                                                                                                       |
| `GET /live/summary`                                                                                                    | edit, operate            | view (`liveLabel` left out below full)                      | What an edit-profile device needs: `{ seq, mode, playlistId?, playlistName?, liveLabel?, lockedPresentationIds }` (no tokens, no full state; answered by the live process)                                                                                                                                      |
| `POST /live/events`                                                                                                    | operate                  | full                                                        | Submit live events over HTTP (used by surfaces' HTTP bridge and tests); WebSocket is the normal path                                                                                                                                                                                                            |
| `POST /live/prepare`                                                                                                   | operate                  | full                                                        | Prepare a playlist's goLive beside the running service: `{ playlistId, saved?, seen? }` → its progress (design/13 "Prepare before goLive", design/29 M8); answered by the live process                                                                                                                          |
| `GET /cache/manifest`                                                                                                  | operate, output          | full                                                        | The live service cache manifest                                                                                                                                                                                                                                                                                 |
| `GET /health`, `GET /diagnostics/export`                                                                               | operate                  | view (`/health`), full (`/diagnostics/export`)              | Hub health; zip of logs, journal tail, settings                                                                                                                                                                                                                                                                 |
| `POST /backup/run`, `GET /backup/list`                                                                                 | operate                  | full                                                        | Backups                                                                                                                                                                                                                                                                                                         |

<!-- m9:lo-detect -->
_M9 (design/27, track `lo-detect`): LibreOffice is optional._ `GET /capabilities` (edit, operate) answers
what the hub's server tools allow (`HubCapabilities` in `@ordo/protocol`: LibreOffice's state and version,
`pdf`, the `documents` extensions, `pptx.{pictures, reference, referencePdf, art}`); the operator offers only
that. `POST /import/document` takes .pptx, .ppsx, .potx and .pptm as PowerPoint, refuses .ppt, .pps, .odp and
.key with 415 `unsupported` and a save-as hint, and answers 501 `libreoffice_unavailable` for
`renderer=libreoffice` without LibreOffice and 501 `pdf_unavailable` for a PDF without pdftoppm (the upload
removed first). `POST /presentations/:id/pptx-reference` also takes multipart with one PDF (PowerPoint's own
export, ≤ 256 MB, field `showPicture` a JSON array): the reference pictures then come from its pages
(pdftoppm, pdfinfo), with no LibreOffice; its JSON form answers 501 `libreoffice_unavailable` on a hub
without LibreOffice. The diagnostics zip holds `capabilities.json`.
<!-- /m9:lo-detect -->

<!-- store-2:capabilities -->
_The pre-render switch (r2b sub-wave 3, track `store-2`)._ `GET /capabilities` also carries `prerender: { state, setting }`
(`HubCapabilities` in `@ordo/protocol`): `state` is the hub's EFFECTIVE answer about pictures of heavy slides, `'on'` or
`'off'`, and `setting` is what `ORDO_PRERENDER` said (`'auto'`, `'on'`, `'off'`: Configuration). An operator reads the
state, never the domain constant (a tab of another build would disagree); a hub from before the field gives none, which
reads as off, and the Pages demo answers off. The public `GET /health` carries `prerender: 'on' | 'off'` (a state: no
tool name, no version); the diagnostics zip's `capabilities.json` carries the field too.
<!-- /store-2:capabilities -->

<!-- prerender-store:routes -->
_Pre-rendered slides (r2b sub-wave 2, design/29 §1.3), all edit role, `full` cap (a capped phone session gets 403
`cap`), each of the storing ones first checked against the free-space floor (507 `disk`, "Storage" below)._

| Route                                               | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /files/slide/:hash`                            | A slide page (at most 500 objects and 256 KiB of canonical JSON) or its head (at most 129 pages, 16 MiB of pages together, 20,000 objects), checked in the CPU pool and stored as an `application/json` file named by what is stored; 201 new, 200 known; 400 `bad_name`, `bad_page`, `bad_head`; 409 `pages_missing` (the first 20 pages the hub lacks); 413 `slide_too_large`                                                                                                                            |
| `PUT /presentations/:id/prerenders/:key?size=`      | A picture (PNG or WebP, not animated, exactly 3840x2160, 1920x1080 or 640x360, at most 32 MiB; the 413 closes the connection); the first picture of a key and size wins, a baker's second is dropped (200 `dropped`), the operator's replaces; 400 `bad_size`, `bad_picture`; 404; 409 `unknown_key` (the key is in no kept revision); 503 `paused_during_service` with `Retry-After` (during a service only the live service's own current keys are taken); 507 `budget` (past the 1 GiB below) or `disk` |
| `GET /presentations/:id/prerenders`                 | `{ keys: [{ slideId, key, standbyId, sizes, madeBy?, at? }], failures, budget: { usedBytes, limitBytes } }` (at most 5,000 keys; no library change is emitted)                                                                                                                                                                                                                                                                                                                                             |
| `DELETE /presentations/:id/prerenders/:key[?size=]` | "Make picture again": the key's pictures and its failure go, and so do their files when no other row names them; 423 while the presentation is live; 204                                                                                                                                                                                                                                                                                                                                                   |
| `POST /presentations/:id/prerenders/:key/failed`    | `{ reason, madeBy? }`: a baker's remembered failure of a key (listed, not retried until deleted); 409 `unknown_key`                                                                                                                                                                                                                                                                                                                                                                                        |

A presentation save names a pre-rendered slide's head (`prerender.file.ref`) only when the hub has it (409 `slide_files_missing`
otherwise, naming the missing hashes) and computes the keys of the saved revision in the pool before it is
written (`prerender_keys`, with the signature that lets a font or media change recompute only what it affects). The
goLive bundle lists each slide's head, pages and shape files, the keys of the presentation's current revision and its
pictures (`slideHeads`, `prerenderKeys`, `prerenders`): the fields are absent when nothing is pre-rendered.
A save that changes the simple copy of a slide kept as a slide file (the same `prerender.file.ref`, other objects) answers
409 `stand_in_stale` with the first 20 `slides`: the picture and its key come from the file, so a changed copy would show
stale content (checked against the stored version only for a save that holds such a slide and whose `rev` is the stored one;
its notes, timing and the other slides stay savable).
<!-- /prerender-store:routes -->

<!-- store-2:routes -->
With `ORDO_PRERENDER=off` the picture `PUT` answers 503 `prerender_off` ("Pictures of heavy slides are turned off on this hub.",
no `Retry-After`, the body drained) before any other refusal, and the listing, the `DELETE` and the `failed` route keep
answering. The `PUT` reads an optional `kind` query: `slide` (the default, and the only one made yet) or nothing; any other
value answers 400 `bad_kind` ("Only pictures of slides are made yet") before the presentation, the size and the key are looked
at. A slide file's head naming more media, shape files or font families than a head row keeps (20,002, 20,000 and 2,048: what a
20,000-object slide can name) is refused 413 `slide_uses_too_many`, never cut; the head row holds the whole lists, and
a goLive lists the head and its shape files but no slide pages while `GOLIVE_SLIDE_PAGES` is false (no screen reads one).
<!-- /store-2:routes -->

## WebSocket

`wss://hub.<venue>.synology.me/ws`. Authenticated by the session cookie (operator,
stage) or `?token=` (outputs). Message schemas in `packages/protocol`
([design/13](13-protocol.md)). One socket per window.

Broadcast fan-out keeps per-socket queues; if an output's queue exceeds 100 messages the
hub sends a full `live.state` instead of deltas and resets the queue.

A library delta is serialised once (design/28 P0): operate sockets get the whole batch, edit sockets
(capped ones included) the same string unless the batch carries the outputs with their tokens, when a
second string without tokens is built for them; outputs and the stage get ids only, for what their config
holds. Before P0 every batch was stringified twice on the live process's main thread (37 ms together for one
4 MiB deck on the test machine); the bytes each socket receives are unchanged
(`apps/hub/test/phones-broadcast.test.ts` compares them with the old code).

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
  in `to`, with `from: "operator"` stamped, exactly like `rtc.signal`. The editor no longer sends it
  (removed from the UI in #7, deliberately); the relay stays.

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
`outputs`, `settings`, `sessions`, `capped_sessions`, `auth_attempts`, `auth_global_failures`, `jobs`,
`job_attempts`, `library_changes`, `revision_summaries` (one small row per kept presentation revision for
the History list, migration 15, below),
`uploads`, `media_hashes` (the SHA-256 media hash index: imports find media with the same content without
scanning `media`; its `content` rows are kept by triggers on `media`, its `source` rows record the deck
part a prepared picture was made from, design/20 "Pictures of the native import"). Migrations with a
simple numbered-SQL runner; every migration is idempotent and tested.

**Revision summaries** (migration 15, `apps/hub/src/revisions.ts`; design/28 P2, the title only). A revision
is a full copy of its presentation (up to the 8 MiB budget), so listing them used to parse every kept
revision: 57 revisions of 8 MiB took 5.4 s and a 2.2 GiB peak in the library process. `GET
/presentations/:id/revisions` now reads `revision_summaries (presentation_id, rev, title_json, saved_by,
saved_at)`, written in the same transaction as the revision (`savePresentation`), and never reads a
revision's JSON: the keys come from the index of `presentation_revisions` and the rest from the summary. The
title is kept as its JSON string literal, so what the list answers is `JSON.parse` of it, exactly the string
the old reading gave. A side table rather than a column (a column's `ALTER TABLE` cannot be re-applied, and
the migration test re-applies every migration), with three triggers on `presentation_revisions` that delete
a summary when its row is replaced, edited or deleted, whoever does it: an older hub that opens the folder
(it ignores the table) writes revisions as it always did, and a summary is never wrong or left behind. A
revision with no summary (an older hub saved it, or the backfill has not reached it) is read once, one row at
a time, inside SQLite: the first 16 KiB of its JSON are scanned for the top-level `"title"` (where a stored
presentation keeps it, third), then the first 1 MiB, then SQLite's own parse (`json -> '$.title'`), and only
for what none of them answers (a title that is not a string, no title) the old parse of that one body; the
summary is recorded. The backfill (`RevisionTitleBackfill`, library process only, 2 minutes after the start)
makes the summaries of the revisions that have none: slices of at most 5 ms, a rest of four times the slice
between them, never while a service is live, resumable (a revision with a summary is not read again). The
migration copies nothing. Revision caps (design/28 P2's 200 rows) and the retention (50 revisions or 30 days)
are unchanged.

`/data/live.db` (live process only): `live_journal (seq, at, cmd_id, kind, event_json)`,
`live_snapshot (singleton)`, `live_snapshot_prev` (the two snapshots before it), `live_resolved` (the running
service's resolved copy, once, in two verified rows) and `live_cues` (its cue list, once, in one verified row: both in
"The running service by reference") and `live_kv` (the cached library context and goLive bundles). On its first start the live process copies the journal and snapshot
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

**Jobs that wait for the live lock**: a job that must not write a presentation while it is in the live
playlist (ADR 0007), such as the PowerPoint follow-ups `pptx-lo` and `pptx-reference` and the re-import `pptx-reimport`, throws `JobDeferred`
instead of running: it goes back to `queued` with a log line ("waiting: the presentation is live …") and
is not started again before its delay (30 s, doubling per deferral to 15 min; kept in the payload). A
deferral is not a crashed attempt. The delay lives in the process only: after a restart the job runs at
once and defers itself again if the presentation is still live. Work a job finished before deferring
(stored pictures) is a resume pair in its payload, so LibreOffice does not run twice for it.

Files under `/data/media/<hh>/<hash>.<ext>`, `/data/fonts/`, `/data/uploads/` (temporary),
`/data/backups/`.

<!-- prerender-store:storage -->
**Pre-rendered slides** (migration 14, design/29 §1.3; all tables `IF NOT EXISTS`, nothing copied, so a hub of the
version before opens the folder at 14 and ignores them, and an update again scans the revisions it missed):
`slide_heads` and `slide_head_pages` (a head's index: bytes, object count, the files and media it uses, its pages
in order), `prerender_keys` (per revision, slide and key: the stand-by id and a signature), `prerenders` (a picture
per presentation, key and size, with the slide's stand-by id; the first upload wins), `prerender_failures`,
`file_refs`, `refs_scanned` and `collect_marks` (below). A slide page, a head, a shape or mask or decoration file
and a client scene are `files` rows of mime `application/json` under `media/<hh>/<hash>.json`, named by the SHA-256
of their canonical bytes; a picture is a `files` row of its own mime, shared between rows of equal bytes.

_The references index._ `file_refs(presentation_id, hash, first_rev, last_rev)` holds, as **intervals of
revisions**, every content file a saved presentation names (a `ref` of a shape, mask or decoration or of a
pre-rendered slide's file, and the files of a slide's `uses`): found by a text scan of the JSON string the save
already built (no parse), extended or opened in the save's own transaction, cleared by `pruneRevisions` and by a
delete. A 2,000-file presentation saved 50 times is 2,000 rows. A file is named while an interval of it reaches the
oldest revision still kept; a head names its pages and its `uses` while the head is named; a picture row names its
picture. `Library.fileReferenced` asks this index with the current rows. Revisions saved before the index
(`refs_scanned` marks the ones scanned) are read once by a **backfill**: raw text, one revision at a time in
slices of at most 20 ms with 100 ms of sleep per 10 revisions, two minutes after the start, resumable, never while
a service is live.

_Collection._ A file nothing names is kept for **31 days: the backups' 30 and the night after them** (`COLLECT_DELAY_DAYS` = the
nightly backups' `RETENTION_DAYS` + 1; a test fails if the delay is lowered below it), so the manifest of any backup
that can still be restored finds it, the backup of the night the file was first seen unnamed included (with exactly
the retention that backup and the sweep fell on the same night). The library process runs one pass a day at 04:00 venue time (after the 03:00 backup) and one 10
minutes after the start, in slices of at most 5 ms (a save in the middle of a pass waits for one slice and no
more: measured at 1.6 to 1.7 times its quiet 95th percentile in a sweep and 2.1 to 2.7 times, at most 25 ms, in the
marking pass), never while a service is live, before the backfill is done or
before it has been told the service's state. Only `application/json` files are candidates (never a media original,
delivery, poster, font, deck or PDF). A pass marks the unnamed (`collect_marks.since` is the delay's clock), clears
the mark of a file named again (a save, a page or head upload even of one the hub already has, a file stored again or a
pass that finds it named), and
deletes the files marked for the whole delay: heads first (their index rows go in the same transaction as their
`files` row, then their pages are named by nothing), each after a last check of everything that names a file and of
unfinished jobs, and of its own mark (still there and old enough: a file stored again since the scan lost it), inside
the one synchronous transaction that deletes its row, so a save or an import cannot slip in between; the blob is
removed after and a missing blob is no error. A wall clock that has jumped since the last pass (it moved by other
than the monotonic clock did, in this process or since a pass of an earlier process of the same boot, or is before the
last pass's time by more than 6 hours) starts every mark again from now and logs it: a clock set right by the network
or by hand after a start without a battery is not 31 days of unnamed files. The monotonic clock is the system's uptime,
which counts the nights a machine sleeps (a process's own clock would not, and a hub that sleeps 8 hours a night would
start every mark again every night); the clock sample of each pass is kept in `meta.collect_clock` with the boot's id
(Linux's `boot_id`), because a reboot starts a monotonic clock of its own and nothing then tells a wrong clock of the
earlier boot from a right one (the pass of a boot whose clock was wrong and set right by a reboot is the case that no
test sees: a follow-up for the decision to turn `on`). A clock before 2026 has not been set, and a pass on it marks
nothing and deletes nothing. Pictures of a key in no kept revision whose stand-by is no current slide's are a cache and
go at the pass, their file with them when no other row names it. `ORDO_COLLECT=report` (the default) records the
marks and logs one line a pass (`collection run`: counts and bytes that `on` would delete) and deletes nothing;
`on` deletes; `off` runs nothing. `GET /health` carries `collectedFiles`, `collectedBytes` and `lastCollectAt`;
`meta.collect_last_run` holds the last pass.
<!-- /prerender-store:storage -->

## Media pipeline

A single in-process job queue (one video job at a time, two light jobs concurrently;
the NAS CPU is shared with other services). Jobs are persisted in `jobs` so a restart
resumes them.

**Jobs paced while live** (design/28 P0, `pacing.ts`, `jobs.ts`). A heavy job (video and animated-GIF
transcodes, `document`, `pptx-lo`, `pptx-reference`) is held while a service is live and for
`ORDO_PACE_GRACE_MS` (default 2 minutes) after End service: when **Phones** is on
(`settings.phones.enabled`), every one; with it off, only those queued during a capped (phone) request or by a
job that was (`job_paced`, migration 13: a media upload, a resumable upload's completion, the PowerPoint
follow-up a save queues), so a phone never starts heavy work during a service. Held jobs are left out in SQL,
so they never fill the queue's window and starve one that may run; a held job carries `waiting: 'service'` in
its job changes and its media stays `uploaded`. A heavy job running at goLive that the rule now holds is
stopped and queued again without counting an attempt (media back to `uploaded`; it starts again from the
beginning after the service). While live no pacing timer runs; after End service one wakes the queue at the
end of the grace (at most 2^31-1 ms ahead). With Phones on, light tools (stills, images, audio) run under
`nice -n 19` with `-threads 1` while live. The library process applies the live locks before its queue
starts (`ORDO_LIVE_LOCKS`), so a library restarted during a service keeps held jobs held. Each handler runs in
its own job's scope, so a pump started inside a capped request never marks another session's jobs.
`PACE_EXEMPT` (empty in P0) names a kind a running service needs. Phones off and no capped request: nothing
is held, nothing niced, no timer.

| Job                | Tool                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Output                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `probe`            | `ffprobe`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | duration, dimensions, alpha, audio channels                                               |
| `transcode-video`  | compliant untrimmed 8-bit progressive H.264 (`<= High`, `<= 1080p60`, square SAR, `<= 20 Mbps`, AAC `<= 2ch`) remuxes with `-c copy -movflags +faststart -map_metadata -1` (ADR 0016); otherwise `ffmpeg -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -g 60 -movflags +faststart -c:a aac -b:a 256k` scaled to fit 1920x1080, fps capped at 60; a trim (`Media.trim`, also editable via `PUT /media/:id/trim`) is read with `-ss`/`-to` before `-i` | delivery MP4, `sourceDurationMs`                                                          |
| `transcode-alpha`  | `ffmpeg -c:v libvpx-vp9 -pix_fmt yuva420p`                                                                                                                                                                                                                                                                                                                                                                                                                  | delivery WebM with alpha                                                                  |
| `gif`              | ffmpeg: animated GIF to H.264 loop (opaque) or VP9 alpha (transparent); still GIF to PNG                                                                                                                                                                                                                                                                                                                                                                    | delivery file                                                                             |
| `svg`              | kept as uploaded; its still is the PNG the uploading client drew (`rasterizeSvg`), checked at upload and probed here (below)                                                                                                                                                                                                                                                                                                                                | delivery PNG or none; size of the still, else `svgRasterSizeFor`                          |
| `poster`           | ffmpeg frame at 1 s, 640x360 JPEG                                                                                                                                                                                                                                                                                                                                                                                                                           | poster                                                                                    |
| `audio`            | ffmpeg loudnorm measurement (also of video soundtracks), AAC 256k delivery                                                                                                                                                                                                                                                                                                                                                                                  | delivery and LUFS                                                                         |
| `pdf-render`       | `pdftoppm -r 144 -png` then scale to 1920x1080                                                                                                                                                                                                                                                                                                                                                                                                              | one PNG media per page                                                                    |
| `pptx-render`      | the render copy (pool task `pptx-render-copy`: shown slides only, External targets, macros and OLE binaries removed, outlines stripped), then `soffice --headless --convert-to pdf` hardened (design/21), then `pdf-render`                                                                                                                                                                                                                                 | PNGs                                                                                      |
| `pptx-text`        | part of `document`: `@ordo/pptx-scene` on the CPU pool (task `pptx-scene`, 150 slides per task; XML parts only in memory, media spilled and dropped), each slide's text objects in the page's 1920x1080 frame (uniform contain mapping), keyed by the slide each page shows (`pagesOf`: LibreOffice leaves hidden slides out)                                                                                                                               | ExtractedText[] per page, `textAligned`                                                   |
| `pptx-text-repair` | one-shot, queued at start-up while a stored legacy picture import has unchecked pages (boxes matched by list index before M3): re-reads the stored deck as `pptx-text` does, one revision per presentation; live-locked ones retried after End service, decks gone skipped (design/27 §11)                                                                                                                                                                  | re-keyed `textBoxes`, `textAligned`                                                       |
| `pptx-lo`          | heavy, after a native import (design/27 §5): render copy (art slides twice over forced white and yellow, picture-class slides, metafiles), soffice once, `pdftoppm -f k -l k` at 2 px per logical px, pool task `pptx-art` (alpha from the two pages, colour un-blended, cropped)                                                                                                                                                                           | transparent art, page and metafile pictures; version 2 of the presentation (one revision) |
| `pptx-reference`   | heavy, 'Show PowerPoint picture': render copy of every shown slide, soffice once, `pdftoppm` per page                                                                                                                                                                                                                                                                                                                                                       | `Slide.pptx.refMediaId`, `show: picture`                                                  |
| `pptx-reimport`    | light, 'Re-import from PowerPoint' (design/27 §11): the native import's steps on the stored deck (only the slides asked for), merged into the presentation: unedited native slides and legacy pages rebuilt, edited ones kept, ids, notes, timings, backgrounds, sections, arrangements and objects added in ordo kept; then `pptx-lo` for the slides that wait (earlier follow-ups' pictures reused)                                                       | one revision (`savedBy` `pptx-reimport`), or none when nothing changes                    |
| `pro7-import`      | `packages/importers` (protobuf decode) in a `worker_threads` worker, 500 documents per task so the worker's 512 MB heap bounds a task, not the library (the playlists are a last task against the index of every document decoded); zip uploads are streamed from disk, media entries spilled to `tmp/`, documents capped at 256 MB in memory                                                                                                               | presentations, playlists, media uploads                                                   |
| `font-google`      | fetch the family's CSS from Google Fonts with a desktop UA, download referenced woff2 files, store each unicode-range subset as a `Font` row with `unicodeRange` (at most 400 per family; then only the weights nearest 400 and 700), and drop the family's earlier Google faces                                                                                                                                                                            | fonts                                                                                     |

**SVG** (review 2026-11-13 R4, R5, R13). Outputs cannot decode an SVG (design/14 "Pictures that are SVGs"),
so an SVG's delivery is a PNG still: the operator draws the SVG through an `<img>` into a canvas at
`svgRasterSizeFor` (at least 1920 px on the longer side, at most 3840 wide and 16.7 MP) and posts it as part
`raster` of `POST /media` (one SVG with one still). An SVG over 24 MB goes through the resumable upload,
which carries the SVG alone; after its 201 the operator draws the still and sends it to
`PUT /media/:id/still` (part `raster`), which stores it as the delivery only for an SVG that has none (409
`has_still`; 409 `busy` while the item's job runs: the operator sends it again; 423 while the live playlist
uses the item), emits the media delta and processes the item again. Before anything is
stored the hub checks a still by its header: a PNG within those caps, at most 96 MB, of the shape the SVG's root
element declares (`svgIntrinsicSize` reads `width`, `height` and `viewBox` of the root only: never a
child's `stroke-width`, a percentage counts as none); anything else is 400 `bad_raster`. The media job
decodes the still's header with `ffprobe` and drops one that lies about its pixels (logged; the file is
released). An SVG without a still (a library from before, which keeps the advice to upload it again; a
client that could not draw it) keeps no delivery, and outputs draw it on their window, up to
`SVG_SCREEN_MAX_BYTES` (2 MB; a larger one is not shown, and the operator says so where it is picked). The item's `width` and `height` are the still's, else
`svgRasterSizeFor` with the browser's default 300x150 for an SVG that declares nothing. An animated SVG is
a still on the screens (its first frame).

The Docker image includes `ffmpeg`, `poppler-utils`, LibreOffice (`libreoffice-impress`
with a minimal font set plus the venue's uploaded fonts mounted so PPTX renders use them) and headless
Chromium for the pptx-preview PowerPoint renderer (design/20 "PPTX and PDF").

The native PowerPoint import (`pptx-native`, light; [design/27](27-pptx-native-renderer.md) §2) reads the
deck's XML into memory within its caps, parses and converts it on the CPU pool (a scan call, then batches
of at most 150 slides, 2 minutes each and 15 minutes of pool time per import), or takes the scene the
uploading browser parsed (`POST /import/document` part `clientScene`, design/27 §2 "Where the deck is
parsed"): the route drops a `clientScene` part over 32 MB before it is stored, the pool task
`pptx-client-scene` reads, parses and checks the stored scene off the event loop (`pptx/clientScene.ts`: a
zod schema with a bound on every list, string and part name; this hub's `CONVERTER_VERSION`, `M9_WRITES` and
LibreOffice state; every shape file checked again by its kind, `storedShapeFileOf`: a geometry file with
`geomFileOf`, an M9 decoration file with `decorFileOf`, and re-hashed), and any doubt about it
makes the hub parse the deck itself (the job's log says why); the scene file is released once version 1 is
saved or the import fails. Steps 3-5 are the import core's in `@ordo/importers` (`pptx-core.ts`,
`pptx-scan.ts`, `pptx-geoms.ts`, `pptx-pictures.ts`, `pptx-ladder.ts`), which the browser's parse and the Pages
demo share, so both paths store the same presentation. The job then stores the pictures the
slides use (recoloured pictures and tiled fills baked into new prepared pictures first: ffmpeg decodes the
source to RGBA at the size the bake needs, pool task `pptx-bake` applies the recipe and encodes a PNG, at
most 16 MP in and out and 60 s, deduplicated by the source's hash and the recipe; design/27 §4), and saves
version 1 of the presentation. In the same synchronous step it queues the heavy
`pptx-lo` follow-up for the slides that wait for LibreOffice, so that job never starts before version 1
exists and is queued before any clip job of the deck; version 1, that job and the import's resume point are
written in one transaction. The deck's clips are stored before the save without their `media` jobs
(`IngestOpts.queue: false`), and those jobs are queued in the same transaction right after `pptx-lo`, each
created at least a millisecond after the job before it (`JobQueue.enqueue` `after`): jobs of a class start in
creation order, and ids alone would order two jobs of one millisecond at random. The import never waits for
a clip's transcode; an import that fails after storing clips queues their jobs anyway. When the CPU pool cannot start, the import fails cleanly: a deck (or a
client scene) is never parsed on the event loop, and never handed to LibreOffice as uploaded. The follow-up retries a LibreOffice run that
fails (twice, deferred with backoff), then marks the slides it could not draw (`Slide.pptx.failed`, named by
goLive). A save from the editor (or a restored revision) that brings back slides still `pending` while no
follow-up is queued or running queues one, planned as the last one was and reusing its pictures.
`POST /presentations/:id/pptx-reference` joins a reference job already waiting for the presentation.

'Re-import from PowerPoint' (`pptx-reimport`, light) runs the same conversion again on the presentation's
stored deck (`buildNative`: the native job's steps without its save, only the deck slides a one-slide request
needs) and merges the result into the presentation as it is when the conversion ends, in one synchronous
step with its `pptx-lo` follow-up and the clips' media jobs (rules in `apps/hub/src/pptx/reimport.ts`). It
defers itself while the presentation is live (as the follow-ups do) and while a `pptx-lo` follow-up of the
presentation is queued or running (its plans name the slides as they are: 15 s, not counted); a re-import
that changes nothing saves nothing. A request equal to one queued or running joins it. Its pictures and clips
are resume pairs in its payload (`done`), as `pptx-native`'s. Editors take its revision over like a
follow-up's (`PPTX_JOB_SAVERS`).

Import jobs are resumable: `pro7-import` records every media id, presentation id and
playlist id it wrote in its job payload and skips them when the job is re-queued after a
crash or restart; `document` records the stored page images the same way; `pptx-native` records
[picture part, media id] pairs and the presentation id it chose before saving, so a re-run reuses the
stored pictures and never saves a second presentation. ProPresenter
presentations and playlists are saved under their ProPresenter UUIDs, so importing the same
library twice updates the earlier copies instead of duplicating them. `POST /import/pro7`
and `POST /import/document` answer 423 while a playlist is live. `POST /import/pro7` takes a zip, a single
`.pro`, `.proPlaylist` or `.probundle` upload, or a NAS path naming a folder or one such file or a library
zip (any other file 415); a single document is stat-ed before it is read and refused past 64 MB (413,
by the route and again by the job, as the zip and folder readers treat a file that size as media, not a
document), and a single NAS `.pro` takes the media of its folder (design/20 "ProPresenter"). `tmp/` is wiped at
startup: everything in it belongs to a job that is re-queued anyway.

## Service cache manifest

On `goLive`, the hub walks the resolved playlist: every presentation's media (backgrounds,
images), every media item's delivery and poster, every font referenced by any text style
or look, the logo, holding slides, and the look definitions. It writes
`{ seq, files: [{ hash, bytes, mime }], presentations: [...], looks: [...] }` and
announces it. The manifest is immutable for the live session.

Fonts on outputs (design/27 §10): the image installs the metric-compatible substitutes (Carlito, Caladea,
Liberation), the Noto script fallbacks and Inter from Debian packages. At every start the library process
registers them from `ORDO_FONTS_DIR` as `Font` rows with `source: 'bundled'`
(`apps/hub/src/fonts/bundled.ts`). It works idempotently by SHA-256, and the venue's own faces of the same
family, weight and style win. Every output receives every library font through `GET /output/config`
whatever the playlist, except the CJK fallback families. The manifest adds the script fallback families
of every script in the presentations' text, so CJK faces ship only with Han, Kana or Hangul text. The image
also installs Noto Sans CJK (`fonts-noto-cjk`'s Sans collections) for LibreOffice and the hub's measuring of CJK
table cells (design/27 §10); it is not a library font, and outputs never receive it.

## Auth

- PIN hashes with Argon2id. Sessions in SQLite with role, device fingerprint
  (user agent hash), expiry. Cookie `ordo_session`, `HttpOnly; SameSite=Lax; Path=/`, `Secure` behind
  https, host-only (no `Domain`; design 28 §4's correction of the earlier text). A capped session (design/28 §3.2, a phone's `cap: 'light'`) is a row of the side
  table `capped_sessions` (migration 11): role `edit` whatever PIN matched, its cap (`light`, `view`), the PIN
  that matched (`pin`: changing that PIN ends it, and changing the edit PIN ends every capped session), one hour
  sliding, never remembered; expired rows are pruned at
  the next capped sign-in. Every session lookup reads `sessions`, then `capped_sessions`, in both processes; a hub
  downgraded past migration 11 never finds a capped cookie (401). The principal carries the cap (`full` for a
  `sessions` row). Writes need a matching `Origin` when one is sent and the `x-ordo` header from capped sessions (and from
  full ones once Phones is on), design/21 "Transport and headers".
- Output tokens: 32 random bytes base64url, stored hashed, one per output, carried as
  `?token=` on the output URL and the WebSocket.
- Rate limiter keyed by forwarded client IP for `/auth/pin`.
- Role checks are route-level decorators; tests assert every route declares one, and its lowest cap
  (design/28 §3.2: `view`, `light` or `full`; `apps/hub/test/phones-routes.test.ts` holds the table). A
  capped session's cap is checked before its role (403 `cap` with `need`), so a phone on an operate route is
  told it is a phone; a route without a cap stops the process at startup and means `full` at run time. Full
  sessions, tokens and anonymous callers are never checked against a cap.

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
process fetches the restored library's settings and output tokens when it starts. A file collection deletes
(Storage, "Collection") was unnamed for at least the backups' retention, so it is listed by every backup that can
still be restored: the restored library finds every file its presentations name.

## Logging and diagnostics

Pino JSON logs to stdout (Docker captures); each line carries `proc` (`supervisor`, `live`, `library`).
A ring buffer of the last 2,000 lines per process is exported by `/diagnostics/export` (`logs.ndjson`
from the library process, `logs-live.ndjson` from the live process) together with the last 500 journal
events, settings without secrets, the health table, the process states and restart counts, restore
warnings, the goLive quarantine list, socket limit closures, the CPU pool counters and the library's size.
`GET /health` adds `library` (the library process state as the live process sees it), `processes` and
`librarySnapshotBytes`: the size of a full `GET /library/snapshot`, which every operator downloads
(design/27 §3.4). It is summed from the stored JSON in SQL (no entity is parsed; within a few bytes per
entity of the real answer), at most every few seconds; past 32 MiB the hub logs once that the library
needs archiving, or the summary-only snapshot that design/27 leaves as a follow-up. A year of weekly
17-slide imported sermon decks measures about 1.5 MB (the test keeps it under 6 MB).

## Bad data at the boundary

Design/25's table, as implemented in the hub:

- **HTTP bodies**: every body schema is `.strict()` at the top level (unknown keys are 400) and bounded
  (string lengths, array sizes, numeric ranges). Entities may echo the server's `rev`, `createdAt` and
  `updatedAt`. The domain schemas carry generous bounds (ids 200 chars, text 20,000, 1,000 objects per
  slide, 5,000 slides per section, coordinates ±100,000, colours 0..255 and alpha 0..1, durations a day).
- **WebSocket from clients**: 64 KiB per message (an operator's `live.adopt` and `preview` up to 16 MiB;
  the operator never sends either above 15 MiB, and a preview carries only the previewed slide's section,
  design/27 §3.4), a token bucket of 50 messages refilled at 50/s per socket. A socket that breaks a
  limit gets `bye too-large` or `bye rate-limited` and close 1008; others are unaffected.
- **goLive**: every presentation is validated against the schema. A slide that fails is replaced by an
  empty slide with the same id, a presentation whose own fields are broken keeps its valid sections, one
  that cannot be read becomes empty, an invalid playlist item is skipped. The service still goes live and
  `resolved.degraded: { cueIndex, reason, presentationId?, slideId? }[]` lists what was quarantined (one
  entry per affected cue, `cueIndex` -1 when nothing shows it); the operator displays it. Missing
  presentations and media that is not ready still refuse the goLive, except the clips and sounds that
  slides play in place (design/27 §8): those are left out with a `degraded` note at each cue of their
  slide, and the slide shows its poster.
- **Files**: images up to 16384×16384, video and audio up to 4 h, video up to 8K (7680×4320), GIFs up to
  20,000 frames, font files up to 256 tables, 4 MiB per table read, 64 MiB of WOFF2 table data. A file
  beyond a limit fails its media job with the reason and is not retried automatically.
- **Settings**: read through their schema with defaults for missing fields (a document with a bad field
  keeps its valid fields; an invalid look or output is dropped from the list); writes check exactly one
  enabled audio master, unique `out<k>` host indices, unique look ids, and that every output's look exists.
- **Journal and snapshots**: validated restore (Storage).

## The running service by reference

Design/29 §2.3 M2 (live-by-ref). The resolved copy of the running service (`state.resolved`, up to 32 MiB) is
named by its SHA-256 (`resolvedId`, the id golive-prepare's worker computes over the bytes it serialised) and kept
ONCE in two rows of `live.db`: `live_resolved (resolved_id, copy, bytes, json, saved_at)`, copy 0 and 1 holding the
same bytes, each verified against the id and its length on every read. Everything else names the copy:

- **The goLive's apply** (the take-over) writes the first row of the copy, the journal row
  `{"k":"goLive","resolvedId":...}`, the snapshot and the cue list's row in one transaction, then calls its listeners;
  the copy is parsed once from the prepared bytes, which the live service keeps as the copy's bytes. Nothing on the
  live loop serialises the copy again. The copy's second row is written in a transaction of its own after the loop has
  polled once more (two `setImmediate` hops): a GO pressed during the apply reaches its socket while the loop is
  held, and is read and applied by that poll before the second write, not behind it (measured at 20 MiB with real
  sockets, a GO 10 ms after the take-over: applied 288 ms after its press with the write beside the apply, 223-261 ms
  after: the apply's own time and nothing more). An event whose write fails (the data folder's disk is full) is not
  applied: every event is one transaction, the state and the copy it had are put back before the error reaches the
  caller, nothing is sent, and the next event follows with no gap in the seq (a failed goLive leaves the old
  service running; the operator's adopt that cannot be written is refused and the hub keeps its own state). The two
  callers that no client waits for catch it too, because an exception out of a timer or a message handler ends the live
  process (`main.ts`) in the middle of a service: the loop's auto-advance leaves the cue where it is, logs it (the first
  failure and then one in 30) and sends the same advance again after `ADVANCE_RETRY_MS` (2 s: never at once, the
  advance being overdue), and `applyHubEvent` (the library's `prerender.add`) applies nothing and warns, the picture
  staying in the library and the slide drawn live.
- **The snapshot** (at every goLive, End service and adopt, and every 5 s while the service changes) is the state
  without its copy and without its cue list, ending `,"cuesId":"<id>","resolvedId":"<id>"}`: a few kilobytes at any
  size. The cue list (about 360 bytes a cue: 3.1 MB at 20 MiB) is built once at the goLive and never changes, so it
  has a row of its own, `live_cues (cues_id, bytes, json, saved_at)`, `cues_id` the SHA-256 of its bytes, written
  once per cue list in the same transaction as the goLive's snapshot and never by a periodic snapshot (which wrote
  it twice before: its own row and the rotation's copy of the previous row, 10-19 ms at 6-20 MiB). The ids sit at
  fixed places at the end of the row, so the collection reads them without parsing it. An idle state, or any state
  with `ORDO_LIVE_BYREF=off`, is written whole as before.
- **Restore** reads both forms: a snapshot or goLive journal row that names a copy joins it from the rows (copy 0,
  else copy 1; a torn row is a warning, a copy neither row can give skips that snapshot for the previous one, and
  with none usable the service starts idle as before); the cue list is joined the same way, from its row when the
  SHA-256 of the row's bytes is the id and its length is `bytes`. A cue row that is torn or gone does not lose the
  service: the cue list is built from the copy as the goLive's reducer built it (the replay of a journal-only goLive
  does the same), with a warning, and the next snapshot writes the row again. A whole (older) snapshot or row, and
  the first by-name form with the cue list inside the snapshot, are read as they are and named at the next
  snapshot. The verified bytes are kept, so the first state sent after a restart serialises nothing.
- **Collection**: a copy's rows are deleted when the running service, a retained snapshot (the current and the two
  before it) and a goLive journal row newer than the oldest of those no longer name it, after each snapshot that
  rotated, each goLive, End service and adopt, and once at start: at most three ids, two rows each. A cue list's row
  goes the same way, named by the running service and the retained snapshots only (a replayed goLive builds its own
  from the copy): at most three rows.
- **On the wire** (design/13): every socket is sent the same encoded state message per variant; a socket that said
  in its hello or resync which copy it holds, or was written the copy, is sent the state without it (as big as the
  cue list); every other gets it whole once. The goLive delta stays whole (the copy is encoded once, from the
  prepared text). A resync that names nothing is always answered whole.
- **Roll-back**: a hub from before this reads a snapshot without its copy as invalid and starts idle, so rolling the
  hub back while a service runs does not bring that service back; update and roll back between services (the older
  hub opens the folder cleanly, it ignores the new table). `ORDO_LIVE_BYREF=off` writes and sends the whole forms for
  as long as a venue wants; a data folder written either way restores either way.

The one-process hub (tests, development) keeps its live tables in `ordo.db`; the live service creates
`live_resolved` and `live_cues` itself there (`LIVE_RESOLVED_SQL`, `LIVE_CUES_SQL`, no migration).

## Sizes

Imported PowerPoint slides are about ten times larger than picture slides, so every path that carries a
whole presentation has a budget (design/27 §3.4, `packages/domain/src/size.ts`):

- A native import stays within 8 MiB (4 MiB until the owner's answer of 2026-11-20, Q1.c): a slide over 64 KB, and every slide once the presentation passes its
  budget, becomes compact picture class (logged, counted on the import card).
  <!-- m9:ladder -->
  Since M9's budget ladder (`pptx/ladder.ts`, design/27 M9) a hub without LibreOffice makes no slide a
  picture for a budget: a slide over 64 KB as stored is re-gridded, then loses its largest text formatting,
  then its largest decorations (`fitSlideBudget`), the tail past 6 MiB (3 MiB before) is stored minimal (text, pictures,
  background), and what is left out is listed in `Slide.pptx.missing` and counted in the result's
  `simplified`. A hub with LibreOffice keeps LibreOffice's page instead for a slide over 64 KB that would lose
  formatting or decorations (picture class, as before M9; `ImportCore.pageForBudget`), so it never shows less
  than a hub without it; its tail is minimal too. A slide whose conversion fails keeps its text (the rescue).
  <!-- /m9:ladder -->
- The running service at goLive (design/29 D13): a resolved playlist over 32 MiB (`GOLIVE_MAX_BYTES`) is
  refused (W58: "This service is too large to go live (40 MB). Split the longest presentations into smaller
  ones."); one over 6 MiB (`GOLIVE_SLOW_BYTES`, the size whose first save on a screen passes the 33 ms GO
  lead; 3 MiB until the owner's answer of 2026-11-21, Q16.b, who wrote "6mb", read as 6 MiB) goes live with
  W59's critical line as a `degraded` entry (`cueIndex` -1): "Going live with this service takes a few
  seconds on the screens. Go live before the service starts." Both are defaults until a venue PC confirms
  them (owner question 14). The operator still never sends a hand-back above 15 MiB (design/17 "Hub
  returns"); the takeover warning above 12 MiB is gone (design/29 A10).
- `preview` carries only the previewed slide's section; the editor warns on save above 8 MiB and refuses
  above the 32 MiB body limit.
- Revisions are full copies (design/11 "Revisions"): an imported presentation of 1 MB edited often costs
  up to 50 MB of revision rows.
  At the 8 MiB budget that is up to 400 MB for one deck. The History list used to parse every kept revision
  (57 revisions of 8 MiB: 5.4 s and a 2.2 GiB peak in the library process, measured at the raise, design/27
  §3.4); it now reads a summary per revision ("Storage": `revision_summaries`) and no body, so what stays to
  watch is the disk, not the list.
- `GET /health` reports the library snapshot's size (Logging and diagnostics).
<!-- prerender-store:sizes -->
- **A presentation's files, 1 GiB** (design/29 A24, W29; `PRERENDER_BUDGET_BYTES`): the bytes of the files only its
  saved versions name (slide pages and heads, shape files and pictures, each file once; a file two presentations
  name counts for neither, so a duplicate costs nothing), read from the indexes. Past it a picture first drops the
  pictures of the oldest versions' keys (never a current key, never a current slide's stand-by); when that frees too
  little the picture is refused, 507 `budget` with `usedBytes` and `limitBytes`, and the screens draw the slide.
  Slide pages, heads and shape files are never refused for the budget (the only copy of a big slide); they count, so
  the picture routes feel them. The listing and `GET /health` (`budgetLimitBytes`, `budgetUsedBytes`: the largest
  presentation's) carry the numbers.
- **The free-space floor** (design/29 A25, W44): uploads, imports and picture and slide-file routes answer 507
  `disk` below the floor; saving, GO and the live process are never refused (Configuration, `ORDO_MIN_FREE_GB`).
<!-- /prerender-store:sizes -->

## Configuration

`ORDO_LIVE_BYREF` (`on` by default and when unset; `off`; any other value is on with a start-up warning): the
running service is kept and sent by reference ("The running service by reference" above). Read once at start.

<!-- store-2:config -->
`ORDO_PRERENDER` (`auto` by default and when unset; `on`; `off`; `1`, `true` and `yes` are on, `0`, `false` and `no` are off; any
other value is auto with a start-up warning): the release's one switch for pictures of heavy slides, read once at start by
each hub process (a change needs a restart). `auto` follows the release's own switch, the domain constant `PRERENDER_ON`; before
the release's switch commit it is the 0.10.0 hub (operators are told off, the picture line of a Go-live check is not judged, and
the store stays open: a picture is accepted and keys are computed). `on` turns the release's pictures on whatever the build
says. `off` closes what the release adds: a picture is refused (503 `prerender_off`), no key is computed (a save writes no key
row; the start-up scan of the next start that is not off fills what was saved meanwhile, two minutes after it starts), a
goLive lists no picture rows and no key set and judges no 'not pre-rendered yet' line, and operators are told off, so they
make no pictures. Nothing stored is deleted by off: records, picture rows and picture files stay, unused; each presentation's
1 GiB picture budget and the collection in report mode apply as before. The hub logs one plain sentence at start for off, and the
warning for a value it does not understand.
<!-- /store-2:config -->
<!-- import-whole:begin config -->
With `ORDO_PRERENDER` on, a hub that has LibreOffice still imports a heavy PowerPoint slide as before (the guard's cut, and
LibreOffice's art and page for what ordo cuts): heavy slides are kept whole only on a hub without LibreOffice. That is the
owner's question Q27 at its default b, which was chosen while the owner has not answered; the constant
`WHOLE_WITH_LIBREOFFICE` in `packages/importers/src/pptx-core.ts` is false (the operator's pinned copy is equal, a test holds
them so) and true would keep them whole on such a hub too (Q27.a). With the switch off nothing of this applies.
<!-- import-whole:end config -->

Environment variables: `ORDO_DOMAIN` (`<venue>.synology.me`), `ORDO_DATA=/data`,
`ORDO_TRUSTED_PROXY` (DSM's address), `ORDO_TZ`, `ORDO_PORT=8080`,
`ORDO_ALLOWED_HOSTS` (optional extra host names), `ORDO_CHROMIUM` and `ORDO_CHROMIUM_SANDBOX`
(the pptx-preview renderer's browser), `ORDO_CPU_WORKERS` (worker threads for
CPU-heavy parsing, 1 to 8, default 1), `ORDO_SINGLE_PROCESS=1` (one process instead of the
supervisor and its two children; development and diagnosis), `ORDO_LOG_LEVEL`, and for
development and tests only `ORDO_DEV_PIN` and `ORDO_APPS_DIR`. The supervisor sets
`ORDO_INTERNAL_SECRET`, `ORDO_LIBRARY_URL`, `ORDO_LIVE_URL` and `ORDO_LIVE_LOCKS` for its
children; they are not configuration. `ORDO_PACE_GRACE_MS` (default 120000): how long held heavy jobs keep
waiting after End service (design/28 P0, "Jobs paced while live" below). Settings that switch behaviour are settings, not environment
variables (design/24): `settings.phones.enabled` ("Phones are used during services", Settings → PINs, off by
default) makes the library process hold heavy jobs while a service is live and both processes need the
`x-ordo` header on writes from signed-in full sessions (design/28 P0); each process caches it and follows the
settings delta. First run with no PINs serves a setup
page on the operator origin that sets both PINs; the setup page is disabled once PINs
exist.

`ORDO_FONTS_DIR` (the image sets `/usr/share/fonts`) is where the hub finds its bundled fonts, and
`ORDO_FONTS_WAIT_MS` (a whole number from 0 to 30000, default 2000; 0 = do not wait) is how long the hub waits for
them to be registered as library fonts before it listens (the library process before it says it is ready): on a
fresh data folder, or after an image with new fonts, that takes a fraction of a second (about 70 ms for the 24 faces
of a development machine's `/usr/share/fonts`), and a hub that already has them finds every row unchanged and still
reads and hashes the files (about 50 ms there). Past the bound the hub listens anyway and logs `bundled fonts not registered in
time`. The live process's own code has no such wait, but in the two-process hub the supervisor starts it only after the
library process says it is ready (the library's wait is before that), so a whole-hub restart in the middle of a service
delays the live process, and the screens' reconnect, by that wait too: about 50 to 70 ms, up to `ORDO_FONTS_WAIT_MS`
after an image with new fonts or on a fresh data folder (the technician can set it to 0).

<!-- prerender-store:floor -->
`ORDO_MIN_FREE_GB` (r2b sub-wave 2, design/29 §1.3 A25, W44): the free-space floor of the data volume, a whole
number of GB from 0 to 10,000; unset, it is 5 % of the volume, never less than 5 GiB and never more than 25 GiB
(a shared NAS volume of 4 TB would otherwise refuse every upload under 200 GB free). Below it every route that
stores a user's file (media upload, resumable create and chunks, an SVG's still, font upload and download, the
PowerPoint, PDF, ProPresenter and SongSelect imports, the PDF of reference pictures, a re-import from a stored
deck, and the slide-file and picture routes) answers `507` with the reason `disk`, `freeBytes` and `floorBytes`
and W44's sentence; saving a presentation or a playlist, settings, deleting, GO and everything on the live
process go on. 0 turns the floor off (one start-up line says so; the value the hubs that tests, e2e specs, the demo
seed and the fidelity tool start use, except the tests of the floor itself, design/23 "Multi-origin in tests": a
volume with less free than the floor, 5 % of the volume and 5 to 25 GiB, would refuse their first upload; a
development hub on such a volume sets it too, `ORDO_MIN_FREE_GB=0 pnpm dev`); anything else is the computed floor
with one start-up warning. The volume is read with `statfs` at most once per 2 s, every 30 s by the library process,
and the floor fails open: a volume that does not answer is one warning and no refusal. `GET /health` carries
`diskFreeBytes` and `diskFloorBytes` (numbers only), relayed from the library process on its stats message.
<!-- /prerender-store:floor -->

<!-- prerender-store:collect -->
`ORDO_COLLECT` (r2b sub-wave 2): `report` (the default, also for an unknown value), `on` or `off`: what the daily
collection of unnamed content files does (Storage, "Collection"); `report` marks and logs what `on` would
delete, deleting nothing.
<!-- /prerender-store:collect -->

The hub answers only for hosts it knows: `ORDO_DOMAIN` and any label under it, `localhost`
and its labels, `127.0.0.1`/`::1`, and `ORDO_ALLOWED_HOSTS`; anything else gets `421` on
HTTP and on the WebSocket upgrade. Behind the trusted proxy the browser's host arrives in
`X-Forwarded-Host`, which the hub uses for the allow-list, app routing and the CSP
`connect-src`; from any other peer the header is ignored.

<!-- m9:lo-detect -->
`ORDO_LIBREOFFICE` (design/27 M9): `auto` (the default: `soffice`, else `libreoffice`, on the PATH), `off`
(also `0`, `false`, `no`: no office code runs on a deck), or soffice's absolute path; anything else is a
start-up warning and auto. The library process looks the tools up at start and asks their version in the
background (soffice through its hardened command, 30 s), logging one line each (`libreoffice: available
(LibreOffice 24.2.7.2)`, or `libreoffice: absent: ordo draws PowerPoint slides itself; …`). Without
LibreOffice the native import leaves nothing waiting: no `pptx-lo` follow-up is queued, and what ordo cannot
draw is listed on its slide (`Slide.pptx.missing`); a follow-up left from when LibreOffice was there clears
`pending` and queues the re-import of those slides instead of running.
<!-- /m9:lo-detect -->
