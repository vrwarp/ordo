# 26 — The GitHub Pages demo

A public, static demo of ordo on GitHub Pages: the real operator, output and stage apps with no server.
Visitors browse a sample service, import their own ProPresenter files, edit, go live and open output
windows, all in their browser. Nothing they do leaves it.

Two hubs serve it (`packages/client/src/demo.ts`, `DemoHubMode`). By default the **VM hub**: the real ordo hub,
unmodified, in a Linux machine that the operator tab runs in a Web Worker (unkernel: Linux compiled to WebAssembly),
resumed from a snapshot the build took ("The VM hub" below). Where the browser cannot run that machine (no JSPI:
Chrome or Edge before 137, Firefox before 153, Safari before 27), or with `?hub=legacy`, the **service-worker hub**:
the hub's REST API reimplemented in the site's service worker ("The demo hub" below).

## Shape

`pnpm build && pnpm build:pages` writes `site/` (`apps/demo/build.mjs`):

| Path         | What                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------- |
| `/`          | The operator app built with `ORDO_DEMO=1`                                                     |
| `/output/`   | The output window, same flag                                                                  |
| `/stage/`    | The stage window, same flag                                                                   |
| `/hub-sw.js` | The demo hub: a service worker answering the hub's REST API (`apps/demo/src/hub.ts`)          |
| `/demo/`     | The sample service: `seed.json` (a library snapshot) and the files it references              |
| `/vm/`       | The VM hub: `manifest.json`, the system image, data disk and snapshot, `host.js`, `unkernel/` |

Every path is relative, so the site works at a domain root and under `/<repo>/` (a project site).
`.github/workflows/pages.yml` publishes it on every merge to `main` (Pages source: GitHub Actions).

## The VM hub

The real hub, as the container runs it (supervisor, library and live processes, SQLite), in an Alpine Linux machine
inside the operator tab. Every demo window reaches it through the site's service worker and a WebSocket shim, so the
apps behave as with a hub on a server: hub-authoritative live state, the output and stage windows on the hub's socket
(bus `hub`), the real importers and media pipeline, PIN sessions, revisions and backups.

### Build (`apps/demo/scripts/build-vm.ts`, Node 24)

1. **System image.** Alpine boots under unkernel with a scratch disk; `apk add` installs Node, ffmpeg, poppler-utils
   and the fonts the container ships where Alpine has them; the hub (`apps/hub/dist`, with `better-sqlite3` and
   `@node-rs/argon2` for linux-arm64-musl) and the apps go to `/app`. The root, without unkernel's own layer, is packed
   as an erofs image (uncompressed: Alpine's mkfs.erofs has no zstd, and the kernel fails lz4) labelled `kwroot` with unkernel's distro header (name `ordo`).
2. **Snapshot.** That image boots with a fresh data disk; the data folder `scripts/seed.ts` made with the real hub
   (`ORDO_SEED_KEEP_DATA`) goes to `/data/ordo`; the hub starts with the environment in `src/vm-config.ts`, answers,
   is signed in to and warmed, and the machine is saved and stopped.
3. **Output.** `site/vm/`: the system image, the data disk as a gzipped kwsparse image (its non-zero blocks), the
   snapshot (gzip), unkernel's browser files and kernel, `host.js` (`src/vm-host.ts`) and `manifest.json` (file names
   carry their content hash; the manifest's `id` names the build).

`apps/demo/build.mjs` runs it with its own Node when that is 24, else `ORDO_VM_NODE`; `ORDO_VM=off` leaves the VM hub
out (the site then runs the service-worker hub only). The guest needs Alpine's mirrors, the unkernel release and
GitHub releases; `ORDO_VM_EXTRA_CA` adds a CA for a TLS-inspecting proxy, `ORDO_VM_CACHE` keeps downloads.

### In the browser (`apps/demo/src/vm-host.ts`)

- **Who runs it.** The operator page decides the mode (`ensureDemoHub`: `vm/manifest.json` present, JSPI and the
  rest of `vmCapable()`, no `?hub=legacy`), tells the service worker, shows a boot screen and loads `vm/host.js`. One
  tab owns the machine (Web Lock `ordo-vm-owner`); a second operator tab uses the first one's hub. The output and stage
  windows ask the service worker for the mode (`api/v1/__demo/mode`) and never run a machine. Closing the operator
  tab stops the hub; its windows reconnect when it is back, as after a hub restart.
- **Start.** The machine (768 MiB, one CPU) runs in a Web Worker. A first visit (or after Reset demo) loads the
  data disk into IndexedDB (`kwdisk:ordo-vm-v1`) and resumes the build's snapshot. The snapshot's records of its disks
  are replaced by this browser's (same bytes, reached over HTTP and IndexedDB instead of files): safe only because the
  manifest ties the files together. The host then signs in with the demo's published PIN (`246810`), so the visitor
  never types it.
- **HTTP.** The service worker posts each `/api/v1/*` request to every window with a port of its own; the VM host
  accepts it and streams the answer (`src/vm-wire.ts`). The host speaks HTTP/1.1 to the hub over a guest connection
  (unkernel `connect`), not `vm.fetch`, so it reads the hub's `Set-Cookie`: the session lives in the host's cookie jar
  (kept per build in `localStorage`). No host within 5 s: 503 "open the operator".
- **WebSocket.** `DemoSocket` (`packages/client/src/demoSocket.ts`) stands in for `WebSocket` in the operator's core
  worker and the output and stage link workers. It talks to the host over the BroadcastChannel `ordo-vm-ws`; the host
  opens the real `/ws` in the guest (RFC 6455 client in `vm-host.ts`), with the session cookie for the operator and
  the token alone for an output or stage. Heartbeats both ways close sockets whose window or host went away.
- **Writes.** As a hub on a server, a change is answered once it is on disk: for any write the host waits until the
  guest has written its files back and the data disk has saved to IndexedDB (`sync`), then sends the status and body.
- **Saving.** The guest's disk changes every second (logs, SQLite), so a saved machine is a pair taken at one held
  instant: `snapshot({ commit, hold })` holds the kernel at its consistent point while the host copies the data disk
  (`exportDisk`), then lets it go on (about 0.5 to 0.8 s of pause). The memory is encoded and gzipped in a worker of
  its own (the page's thread relays the apps' hub sockets and must not stall), and both go to IndexedDB `ordo-vm`. A
  save follows every API write and live command once the hub has been quiet for 3 s (at most 20 s after the first
  change), and when the tab is hidden. A load resumes the latest save when it holds every change (`lastWriteAt`);
  when it does not (the tab closed within those seconds), the machine boots on the visitor's disk instead (about a
  minute and a half) and keeps everything; a resumed hub that does not answer in 60 s is given up for that boot too.
- **Reset demo** stops the machine and deletes its disk, its save and the cookie jar with the rest of the demo's
  storage.

### Measured (headless Chromium, localhost, 2026-11-27)

| Step                                                       | Time                                       |
| ---------------------------------------------------------- | ------------------------------------------ |
| First visit to the operator app, files local               | 6 s (the PIN check about 3 s of it)        |
| Reload resuming a save                                     | 2 to 3 s                                   |
| Boot on the visitor's disk (no save holds the last change) | 60 to 100 s                                |
| A save: hub paused / written                               | 0.4 to 1.0 s / 7 to 10 s in the background |

Download on a first visit: the snapshot (about 56 MiB gzip), the kernel (11 MiB), the data disk (about 5 MiB gzip) and what the
machine reads of the system image by range.

## The demo hub (service worker)

The apps are unchanged except for a build flag (`__ORDO_DEMO__`, `packages/client/src/demo.ts`):

- `ensureDemoHub` registers `hub-sw.js` with the site root as its scope before the app starts, and
  reloads once on the first visit so the page is controlled (a `sessionStorage` flag keeps that to one
  reload). When the browser cannot run it (no service workers, site storage blocked, the worker never
  takes control) the page shows "This demo needs a browser with service workers and site storage
  enabled" instead of the app. The apps' own shell service workers are not registered in the demo (one
  worker per scope).
- `HubConnection.start` never opens a socket. The output and stage windows therefore follow the
  operator over the fallback bus, as they do when the hub is down.
- Go live goes straight to the local path of design/17 ("Going live without the hub"): the operator
  resolves the playlist from its library copy and holds the service. No dialog: there is never a hub.
- A banner explains the demo and offers **Reset demo** (clears the browser's stores, by name where
  `indexedDB.databases()` is missing; the demo hub re-seeds from `seed.json`). The top bar says "Demo: runs in this browser".

The service worker answers every `/api/v1/*` request from the pages and workers it controls:

- Library reads and writes (presentations, playlists, themes, folders, settings, media, fonts) against
  one library document in IndexedDB, started from `seed.json`, with the hub's status codes: deletes
  answer 204 (a deleted presentation leaves its playlists; a deleted media item's own file goes too), a
  `POST` with an existing id or deleting the default theme 409, a body the schemas refuse 400 with the
  hub's one-line summary. `PUT /settings/:key` uses the hub's `SETTINGS_BODY` schemas
  (`@ordo/protocol`): unknown keys are 404 and a new output gets a token, so it can be launched.
- Media uploads are stored as-is (browsers play these formats); images get their size from
  `createImageBitmap`. An SVG comes with the PNG still the operator drew (field `raster`, checked as the
  hub checks it: a PNG of the SVG's shape within the caps) and keeps it as its delivery, which outputs
  draw; one without is drawn by the output's window (design/14 "Pictures that are SVGs").
- Files are served as the hub serves them (design/21): with their library type (the site serves the
  sample's without an extension), as a sandboxed document that loads nothing, an SVG as a download.
- **ProPresenter import runs in the browser**: `.pro`, `.probundle`, `.proPlaylist` or a zip of a
  library go through the same `importPro7` as the hub, media included. Pasted SongSelect lyrics too.
- Files: the visitor's from IndexedDB, the sample's from `/demo/files/<hash>`.
- `/output/config` finds the output by its token, as the hub does.
- **PowerPoint import runs in the browser, without LibreOffice** (design/27 §2 "Where the deck is parsed"):
  the operator's import worker parses the deck for a hub without LibreOffice (`/capabilities` answers
  LibreOffice absent and `pptx.art` false) and sends the scene with the upload; the demo hub uses that scene
  when it is of its converter, its stored fields and parsed without LibreOffice (else it parses the deck
  itself, `parsePptxScene`) and builds version 1 with the import core (`assemblePptxScene`), as a hub without
  LibreOffice does: what ordo draws is drawn, what it cannot draw is listed on the slide
  (`Slide.pptx.missing`, the import card's "not drawn" line), nothing waits for LibreOffice, and no slide is a
  picture for its size. Pictures are stored as they are (browsers read them), shape files as the hub stores
  them, clips are left out (their posters stay). Only where a hub would show LibreOffice's picture of a whole
  page (a 'Pictures (LibreOffice)' import, 'Show original', a picture-class slide, a PDF page) the demo shows
  its placeholder page "Rendering Not Available in Browser Demo"; the "Object Not Available in Demo"
  overlay is gone.
- What needs the hub's server tools answers 501 with "needs the ordo hub on a server": media transcoding
  and its retry, adding fonts, backups, version history, NAS folder imports, changing the PINs.

## The sample service

`apps/demo/scripts/seed.ts` starts the real hub (`apps/hub/dist`) on a scratch directory, creates the
content through its API and exports the snapshot and files, so the seed is exactly what a hub writes:
three public-domain hymns, Luke 10 (World English Bible) as a reading, a welcome loop that explains the
demo, two backgrounds drawn by the script, the second hymn's moving aurora (an 8 s seamless loop the script
draws frame by frame and encodes with ffmpeg, which the Pages job installs for the hub; its first frame as a
still picture when ffmpeg cannot make it: an SVG would be a still on the screens), and a "Sample service"
playlist. One audience output and the stage display are enabled.

## Tests

`e2e/pages-demo-vm.spec.ts` drives the VM hub, served with range requests: the first visit resumes the build's
snapshot signed in with the hub socket connected; a ProPresenter bundle goes through the relay into the real hub; the
save and a reload that resumes it; Go live on the hub, Launch outputs, the output on the hub's socket showing the slide,
End service; a change made just before a reload that boots the machine on the visitor's disk and keeps it; Reset demo.

`e2e/pages-demo.spec.ts` drives the service-worker hub (`?hub=legacy`), served under `/ordo/` exactly as Pages does
(anything outside answers 404): the sample library, a ProPresenter bundle imported with its background, an SVG
uploaded with its still (and the "moves in previews only" note), persistence across a reload, Go live,
Launch outputs, a GO reaching the output window, the aurora moving on the Audience screen, End service,
Reset demo; and a public deck of the golden corpus with a chart imported as editable slides (parsed in the
import worker, its chart's slide hybrid with the chart listed missing and no overlay, the stage pill and
the slide's PowerPoint panel) and another as pictures (the placeholder pages with their stage pill). CI
builds the site before the end-to-end suite; locally the spec skips when `site/` is missing.

## Limits

- Desktop Chrome or Edge for Launch outputs (popups); an iPad or Safari gets the edit profile (library, editor,
  previews), as with a real hub.
- Storage is the visitor's browser: clearing site data or Reset demo removes their work.
- The VM hub needs JSPI (Chrome or Edge 137+, Firefox 153+, Safari 27+); elsewhere the service-worker hub runs, with
  no WebSocket (no "Live now" chip, no hub-authoritative live state). Only Chromium has been driven so far.
- The VM hub lives in the operator tab: closing or reloading it stops the hub for its output and stage windows until
  the tab is back. It is reachable only from windows of the same browser, so multi-device sync is not part of the demo.
- In the machine: no LibreOffice and no Chromium (the hub's pictures of whole slides and many-point shapes are off,
  as on a hub installed without them); ffmpeg runs emulated, so transcoding a video is slow.
- A change made in the last seconds before the tab closes is not in the latest save: the next load boots the machine
  (about a minute and a half) to keep it.
- PR previews (Cloudflare Pages, 25 MiB per file) are built without the VM hub (`ORDO_VM=off`).
