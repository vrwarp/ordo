# 26 — The GitHub Pages demo

A public, static demo of ordo on GitHub Pages: the real operator, output and stage apps with no server.
Visitors browse a sample service, import their own ProPresenter files, edit, go live and open output
windows, all in their browser. Nothing they do leaves it.

## Shape

`pnpm build && pnpm build:pages` writes `site/` (`apps/demo/build.mjs`):

| Path         | What                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| `/`          | The operator app built with `ORDO_DEMO=1`                                            |
| `/output/`   | The output window, same flag                                                         |
| `/stage/`    | The stage window, same flag                                                          |
| `/hub-sw.js` | The demo hub: a service worker answering the hub's REST API (`apps/demo/src/hub.ts`) |
| `/demo/`     | The sample service: `seed.json` (a library snapshot) and the files it references     |

Every path is relative, so the site works at a domain root and under `/<repo>/` (a project site).
`.github/workflows/pages.yml` publishes it on every merge to `main` (Pages source: GitHub Actions).

## The demo hub

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
  `createImageBitmap`.
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
demo, two backgrounds drawn by the script, and a "Sample service" playlist. One audience output and the
stage display are enabled.

## Tests

`e2e/pages-demo.spec.ts` serves `site/` under `/ordo/` exactly as Pages does (anything outside answers
404) and drives it: the sample library, a ProPresenter bundle imported with its background, persistence
across a reload, Go live, Launch outputs, a GO reaching the output window, End service, Reset demo; and a
public deck of the golden corpus with a chart imported as editable slides (parsed in the import worker, its
chart's slide hybrid with the chart listed missing and no overlay, the stage pill and the slide's
PowerPoint panel) and another as pictures (the placeholder pages with their stage pill). CI
builds the site before the end-to-end suite; locally the spec skips when `site/` is missing.

## Limits

- Desktop Chrome or Edge for Launch outputs (popups and the fallback bus); an iPad or Safari gets the
  edit profile (library, editor, previews), as with a real hub.
- Storage is the visitor's browser: clearing site data or Reset demo removes their work.
- No WebSocket: the iPad's "Live now" chip and multi-device sync are not part of the demo.
