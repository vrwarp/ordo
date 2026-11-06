# Design 15: Operator app

`apps/operator`: React 19, TypeScript, Vite, served from `op.<venue>.synology.me`. It
contains the operator view, the editor, settings and imports. It never creates a WebGPU
device.

## Structure: a host and a core worker (design/25, phase C)

```
main thread (host)                                core worker (src/core/core.worker.ts)
──────────────────                                ─────────────────────────────────────
React UI rendering the view model,                HubConnection (socket + clock), LiveCore (optimistic
Zustand read models (useLive, useLibrary),        state, pending re-submission, fallback authority with
keydown → post action (and the clear-all hold),   its 5 s grace, loop auto-advance), FallbackHost fed with
Stream Deck HID I/O, MIDI, window.open and        MessagePorts, actionToEvent with the GO lead, health
window handles, the MessagePort handoff,          aggregation, library store (snapshot + library.delta +
WebRTC program views, the supervisor of the       IndexedDB copy) and search index, service-cache fill and
core and thumbnail workers, the outbox            fallback file serving, Stream Deck key images
                                                  (OffscreenCanvas), error budgets, state persistence
```

- `src/core/protocol.ts` is the only contract between the two. The core posts a **view model in
  slices** and only the slices that changed: `live` (the live state without `resolved`, authority,
  reconcile, pending count, hub connection, own cache, clock), `resolved` (posted once per new
  resolved playlist and referenced by revision), `health`, `budgets`, `stats` (main-thread stall,
  bus endpoints). The library is posted once in full, then as patches of changed entities (by
  reference identity in the worker). The main thread re-assembles `state.resolved` from its cached
  copy, so React memoization by identity keeps working.
- `src/services/controller.ts` is the main-thread facade with the API the views always used
  (`go`, `select`, `clear`, `goLive`, `dispatch`, `hub.send` …). It turns calls into posted
  actions and applies the view model to `useLive`. Window, audio-gain and launch actions stay on
  the main thread (they need a gesture, a window handle or a settings PUT); everything else goes to
  the core.
- Local library writes after a successful API call (`upsertLocal`, `removeLocal`, `saveSettings`)
  update the read model at once and are forwarded to the core, which does not echo them back. A write
  that arrives before the core has posted its library in full (the 1.5 s after a core restart) does
  not move the posting baseline: the first full post carries it, and the IndexedDB copy, when it
  arrives, is applied underneath the writes already made instead of replacing them.
- Library search runs in the core (`useSearch`); while the core restarts the same index runs on the
  read model.

### GO latency

The `keydown` handler maps the key and posts `{ t: 'action', aid, action }`; the core computes the
event (`actionToEvent` with the GO lead), applies it optimistically and writes it to the socket in
the same task. Nothing on the path waits for React. Every action carries an id (`aid`) that becomes
the command id, so a re-sent action is de-duplicated by the hub.

### Supervision and recovery

`CoreClient` (`src/core/client.ts`) runs the core under the `Supervisor` from `@ordo/client`
(heartbeat 250 ms, dead after 1.5 s, at most five restarts a minute) and the thumbnail worker under
the same supervisor (dead after 5 s). On a core restart:

1. The new core restores from IndexedDB (`core` key, validated with `isLiveStateShape` and
   `checkInvariants`): the confirmed hub state, the unconfirmed commands (re-proposed and re-sent
   with their ids on the next full state), the ids of actions already applied, and the authority.
   A core that was the fallback authority less than two minutes ago resumes it at once. Only states
   that pass the invariants are ever persisted: when the live state breaks them (the core then asks
   for a restart), the last good snapshot stays on disk (with a fresh time, so the authority still
   resumes), and the restarted core continues from it.
2. The host re-offers a fresh port (and relay) to every known window.
3. The host re-sends every action the old core did not acknowledge. The core acknowledges an action
   only after the snapshot that contains it is written, so a crash between a keypress and the hub
   send loses nothing and applies nothing twice.
4. The top bar shows "Recovering…" while a restart is in progress, or while the core misses
   heartbeats (over 750 ms) and this thread has been ticking on time.

The supervisor ignores missing heartbeats after a stall of its own thread (the heartbeats are
queued behind the late check), so a long React commit never restarts a healthy core; the
"Recovering…" indicator applies the same correction (`src/lib/recovering.ts`), so it does not flash
after a long main-thread task.

### Session expiry

A `bye` with reason `unauthorized` or `forbidden` (an expired or revoked session, a sign-out
elsewhere) is not a hub loss: the hub is up and the outputs, which authenticate with their own
tokens, stay on it. `HubConnection` emits `auth` once and backs its reconnects off to 30 s, doubling
to 2 minutes; the core neither arms nor runs the fallback grace while refused, posts `hub` `auth` to
the host and sets `hubRefused` in the live slice (the top bar says "Session ended: sign in again
(outputs stay on the hub)"; `src/lib/hubStatus.ts` picks the line). The host calls
`refreshSession()`; with no role left, the app keeps the shell, the output windows and the core
mounted and shows the sign-in view over them, with one persistent banner (no toast per attempt;
operator keys are off meanwhile). After a successful sign-in the host posts `hub.resume` and the
core reconnects at once and rejoins as the hub's client.

A refusal while the operator is already the fallback authority (the hub came back after the
fallback took over, and this operator's session had expired meanwhile) keeps it the authority until
the hand-back after sign-in: the outputs stay on the fallback bus and never jump back to the hub's
older state. One window can still slip away: a hub that restarts with a state equal to the window's
makes the window follow the hub (design/17, "hub caught up"), and with the session refused no
hand-back ever catches it up, so it would show the hub's older state from then on. The core
therefore re-introduces the bus (`fallback.hello`) to every window the moment the refusal arrives,
and, while refused and the authority, to any proven window that has said nothing on the bus for
`RECALL_MS` (3 s; a window on the bus reports health every second), at most once per 3 s per window.
In that state the UI must not block the service: the top bar reads "Running from this
PC — session ended; sign in to hand back to the hub", the sign-in is a non-modal card in the corner
of the live view (`.signin-overlay.nonmodal`) whose banner says the same, the PIN field is not
auto-focused (a focused text field would take the GO key), and the keyboard, Stream Deck and MIDI
keep working (`keysOn` stays true while `authority === 'fallback'`), so a volunteer advances slides
during worship and signs in between songs. Once signed in, the hub accepts the socket, the core
adopts the operator's state at the hub (the "Hub back: handing over…" line wins over the refusal
text) and the outputs return to the hub bus. Covered end to end by `e2e/chaos-operator.spec.ts`.

### Main-thread watchdog

The host posts a tick every 250 ms; the core measures the gap (`mainThreadStallMs`, peak over the
last minute) and logs stalls over 1 s. A stall delays keys (they are handled on the main thread by
necessity) but neither the hub socket, the fallback heartbeat, nor a GO from a path that does not
touch the main thread. The top bar shows "UI stalled" with the peak, and the checklist tells the
volunteer to use the Stream Deck as the second route.

### Error budgets

Counted per subsystem (`src/lib/budgets.ts`): socket drops, command rejections, fallback
activations and cache-fill failures in the core; core restarts and Stream Deck/MIDI errors on the
host. An exceeded budget turns the top bar red with exactly one action (Reconnect, Resync, Reload
operator, Diagnostics, Retry download, Reconnect Stream Deck); a cache fill whose budget is spent
stops retrying until the operator asks, and the operator's own cache numbers then describe the new
manifest (nothing filled), not the previous service's finished fill. The printed checklist lists each red state with its action.

### Own service cache

The core fills its Cache API store from the live manifest (`fillOwnCache`) so it can serve files to
the outputs in fallback. Its downloads in flight are shared across fills (`src/lib/downloads.ts`, the
rule the output got in review 2026-11-04 item 11): a manifest change (goLive, an edit during the
service) stops the previous fill's queue and cancels only the downloads whose hash left the manifest;
a file still wanted keeps downloading and the new fill joins it instead of starting the clip over.

## State

- `live` (`useLive`): read model of the core's live slice plus host-side isolation state
  (recovering, workers, budgets, core stats).
- `library` (`useLibrary`): read model of the core's library store; the core keeps the IndexedDB
  copy and applies `library.delta`.
- `ui`: selection, panels, dialogs. Persisted to `localStorage` per device.
- The hub bus and the fallback bus both live in the core ([design/17](17-offline-and-degraded.md)).

Every action in the UI dispatches an `Action` from `packages/surfaces`; actions map to
reducer events. Keyboard, Stream Deck and MIDI dispatch the same actions.

## Operator view components

| Component      | Notes                                                                                                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TopBar`       | Connection, WAN, cache, output dots, clock, Launch and Relaunch                                                                                                                                                                                |
| `PlaylistPane` | Virtualized list; drag to reorder when not live                                                                                                                                                                                                |
| `SlideGrid`    | Sections as headed groups following the arrangement; thumbnails from the thumbnail worker; live and armed markers; click to select, double-click to GO; hidden PowerPoint slides dimmed with a `hidden` tag and still clickable (design/27 §9) |
| `ProgramView`  | One `<video>` per output fed by WebRTC; health overlay                                                                                                                                                                                         |
| `StageTools`   | Message box, recent messages, timers                                                                                                                                                                                                           |
| `LayerBar`     | Five chips with clear buttons; media transport and remaining time; audio meters                                                                                                                                                                |

Thumbnails: a supervised worker runs the shared text rasterizer and a 2D compositor at 320x180,
cached by (slide rev, look). The main thread never rasterizes; a restarted thumbnail worker gets the
fonts again and re-renders the jobs that were in flight. Stream Deck key images are drawn in the core
worker on an OffscreenCanvas; only the HID writes stay on the main thread.

## Keyboard

A single `keydown` listener on `window` with the key map from settings. Handled keys call
`preventDefault`. Text inputs opt out by focus. The handler only maps the key and posts the action
to the core worker (plus the clear-all hold timer); the core applies it optimistically and sends it.

## Launching outputs

1. The operator clicks Launch outputs (a user gesture).
2. The app requests `window.getScreenDetails()` (Window Management API permission,
   remembered per origin). For each enabled output it finds the screen matching the saved
   `ScreenRef` by label, then by position; unmatched outputs open on the primary screen
   and show a placement dialog.
3. `window.open(outputUrl + '?token=…', 'ordo-out-' + k, 'popup,left=…,top=…,width=…,height=…')`
   with the screen's bounds. The handle stays on the main thread (open, close, focus only).
   The host calls `offerPort(win, origin, outputId)` and transfers its end into the core, which
   registers it with the fallback host; it offers again 1.5, 4 and 8 s later (the first offer may
   reach `about:blank`), whenever the window asks (`ordo.port.request`), when the hub reports the
   window reconnected, and every 10 s while the window's bus is silent. A legacy relay over
   `window.postMessage` is handed to the core alongside, for a window that never takes a port.
4. The output, on load, calls `requestFullscreen({ screen })` for its screen. Chrome
   allows this on a window opened by a gesture.
5. Relaunch closes every handle, waits 500 ms, and repeats.
6. Stage opens the same way with the stage origin.

Window names are stable so a reload of the operator can re-acquire windows by opening
the same name (Chrome returns the existing window for a matching name, re-navigating it;
outputs tolerate a navigation by re-arming from the hub state).

## Program view

Receive-only `RTCPeerConnection` per output with host ICE only. Each `<video>` is muted,
`playsInline`, 320x180. Reconnects when the output reconnects.

## Editor

- Canvas-based editor with `react-konva` for selection, transforms and guides; the
  visual preview inside the editor uses the shared rasterizer for text so WYSIWYG holds.
  Rich text objects (design/27) are drawn by the rich engine into their cached canvas at the stage
  scale × `devicePixelRatio` (keyed by the font generation), legacy ones at 1:1 as before.
- Editing a text box's plain text keeps its formatting: `editText` (`@ordo/domain`) shifts, trims and
  splits the runs and paragraph styles with the change, placed by the textarea's caret; splitting and
  merging slides cut and join them with the lines (design/27 §11).
- Property panel bound to the selected object's schema.
- Pictures are drawn with their crop (`ImageObject.crop`), as every other drawer draws them; 'Replace'
  drops the old picture's crop, which does not fit the new one (design/27 §15 M3).
- Saves via `PUT /presentations/:id` with `rev`; 409 shows the reload dialog.
- Disabled with a banner when the presentation is referenced by the live playlist.
- Media playing in place (design/27 §8, §11 item 14; `views/editor/MediaPanels.tsx`, pure ops in
  `mediaOps.ts`, one undo step each). '+ Video' (touch: Add → Video…) adds an ImageObject whose `mediaId`
  is the video, so every drawer shows its poster, with `play` {start automatically, no loop, hold the last
  frame}, sized to the video and centred. Its Object panel has a Video section: Start (automatically, or on
  click: live paused at 0, F8 plays it), Loop, At the end (hold the last frame, rewind to the poster, go to
  the next slide), Volume (dB, default the media's gain), Mute, Hide while not playing, Replace video (the
  object then shows the new video's poster) and Use poster only. A slide plays one video, the lowest object
  with `play`: the panel of any other names the one that plays and offers 'Play this one instead', which
  removes `play` from the others. A picture whose media is a video offers 'Play the video in the slide'.
  The Slide panel's Sound section picks an audio file for `Slide.audio` (Start, Loop, Volume, Mute, Plays
  across N slides) and says that it stops playlist audio that is playing when it starts (as the slide goes live, or on F8 for an on-click sound). Both panels say when the clip is
  missing, still processing or failed (the slide then shows its poster or stays silent). Picture pickers
  list, open and upload images only (a dropped file of another kind is not uploaded); the canvas marks an
  object with `play` with a ▶ badge; the slide grid tags slides with `video` / `audio` (amber when the clip
  will not play).

### Touch

Under a finger (iPad Safari) every gesture has a button and nothing depends on hover, `title` tooltips
or HTML5 drag and drop; all of it is gated by `(pointer: coarse)`, so a mouse sees the desktop layout.
Reordering (playlist items, arrangement chips, slides across sections, sections) uses one pointer-event
sortable (`components/Sortable.tsx`, maths in `sortableMath.ts`): a visible grip with
`touch-action: none` picks the item up after a 300 ms hold (a quicker swipe scrolls), the item follows the
finger, a line marks the slot, the list auto-scrolls near its edges, Escape or a cancelled touch puts it
back; a mouse still drags the whole row. Move buttons are always there (row arrows, Earlier/Later for
the picked arrangement chip, slide and section up/down). The slide editor has 30 px transformer anchors
with a wider hit area, the rotate handle 64 px out (flipped below or beside the box when it would fall
off the slide), `touch-action: none` on the stage, and pinch suppressed rather than zooming: the slide is
already fitted to its pane, numeric fields and the nudge toolbar cover fine work, and a two-finger
gesture must not also move an object. A double-tap on a text box focuses its text field (inside the
gesture, so the keyboard opens). On a coarse pointer the editor toolbar is one row: Library, title,
Save, Undo, Redo, an Add menu (Text, Image, Video, Rectangle, Ellipse, Line), an Arrange menu (front, forward,
backward, back, duplicate, delete) and History (`components/Menu.tsx`: 44 px items, closed by a tap
outside or Escape, nothing on hover). While an object is selected its keyboard-only actions (nudge with a
1/10/50 px step, edit text, deselect) float in a bar just above or below it, clear of its anchors and
rotate handle, or at the pane edge away from a box that fills the slide (`objectToolsSpot` in
`touchGeometry.ts`); the bar overlays the pane, so the stage never moves when a selection starts. A mouse
keeps the full toolbar. A focused
field scrolls back into the visual viewport when the software keyboard shrinks it (`keepVisible.ts`).
Controls are 44 px with 16 px inputs (no focus zoom); in portrait the editor's property panel and the
playlist's add panel move under the main pane. File pickers are a plain button to the native picker
(Files, Photos): photos arrive as JPEG because Safari transcodes HEIC when the accept list does not name
it (the hub does not accept HEIC), videos as MOV or MP4.

## Media library

The Media tab hides the pictures imports make for presentations (pages tagged `document`, native-import
pictures tagged `pptx`) unless 'Show presentation pictures' is ticked (design/27 §11 item 15). Deleting
media that stored presentations use names them in the confirmation first, since a missing picture refuses
goLive: the hub answers such a `DELETE /media/:id` with 409 `media_in_use` (the titles in its message)
unless it carries `?force=1`, which the tab sends once the user has confirmed.

## Settings

Outputs and looks, audio devices and pairs, key map, Stream Deck pages, MIDI mappings,
PINs, output tokens, backups, diagnostics export. Each page is a form over the matching
`/settings/*` resource.

## PowerPoint imports

The import screen (`views/library/ImportTab.tsx`) asks how a PowerPoint is imported
([design/27](27-pptx-native-renderer.md) §2, M3): 'Editable (recommended)', the native import, or 'Pictures
(LibreOffice)', plus 'Extend plain backgrounds to 16:9' for the native import; radio buttons and a check box
inside their labels, remembered per device (`ordo.pptxImport`, `ordo.pptxExtendBackgrounds`; the hub
defaults to editable). A PDF is always pictures. A native import's card (`PptxImportCard.tsx`) shows the
slides per class (editable, partly a picture, picture), slides made compact to fit the size budget, the
LibreOffice follow-up as it waits, runs, finishes or fails, fonts to upload "for exact line breaks" (a link
to the Fonts tab), the slides whose import approximated something (`Slide.pptx.notes`, numbered as in the
editor) and the import's notes. Job results are read defensively (`lib/pptxImport.ts`): another hub version
or a failed job shows less, never breaks the card, and deck text is only ever shown as text. Follow-up jobs
(`pptx-lo`, `pptx-reference`, the text repair, the re-import) are not listed as imports.

In the editor, a slide imported natively has a 'From PowerPoint' card in the Slide panel
(`PptxSlideCard.tsx`): its class, what was approximated, LibreOffice work still pending, and 'Show
original', which lays the PowerPoint picture of the slide (`Slide.pptx.refMediaId`) over the canvas so a
volunteer can compare; the canvas takes the pointer meanwhile. It is a view of the editor and changes
nothing stored. When there are no pictures yet, turning it on saves unsaved edits, asks the hub for them
(`POST /presentations/:id/pptx-reference` with `{ showPicture: [] }`: no slide switches to its picture) and
follows the job; when it is done the editor takes the pictures over, keeping edits made meanwhile. A slide
set to show its PowerPoint picture on the screens (`Slide.pptx.show`) says so, with 'Show the objects
instead'. The canvas, the thumbnails, the look previews and 'Send to preview' draw a slide as the outputs
do (design/27 §5 "One rule for every drawer", `slideContent`): a slide set to show its PowerPoint picture
shows that picture and only the objects added in ordo (the imported objects, marked by `origin`, are
neither drawn nor selectable on the canvas), and a picture slide its page picture under its objects.

The card also (M4, design/27 §11 item 12) says when the slide was edited in ordo since the import (its
imported objects no longer match `Slide.pptx.digest`; objects added in ordo do not count), names the fonts
of its text the hub cannot draw with their own widths (neither the family nor a metric-compatible fallback
of the box, such as Carlito for Calibri, is a library font) with 'Upload font' (the Fonts tab), and offers:
- 'Show the PowerPoint picture on the screens' (`Slide.pptx.show`, one undo step through `actions.ts`
  `setSlideShows`, saved with the presentation): on an edited slide a confirmation first says that the
  picture shows the slide as imported, without the edits (objects added in ordo still draw over it); with
  no picture yet it saves unsaved edits and asks the hub for the pictures with this slide switched
  (`showPicture: [slide]`), then takes the job's revision over.
- 'Reset slide from PowerPoint', for an edited slide or one LibreOffice could not draw: after a
  confirmation it saves unsaved edits and runs the hub's re-import of that slide (`pptx-reimport` with
  `{ slideIds, reset }`), its progress in the card (a live region); the slide gets the deck's objects back,
  keeping its id, notes, timing, background and the objects added in ordo on top. History keeps the slide
  as it was.

'Make editable' on a legacy PowerPoint page (a picture import from before M3) rebuilds the page from the
stored deck: the hub reroutes it to the re-import of that slide (202 and the job), the editor follows the
job and takes it over, and the page becomes the native slide with the objects added over it on top and its
notes. A PDF page, or a deck no longer stored, keeps today's text boxes over the page picture.

The Presentation panel of a PowerPoint presentation ends with its import report (`PptxReport.tsx`): the
slides per class (`source.native`) or, for a legacy import, that its slides are pictures; legacy pages
left; hidden and edited slides; slides waiting for LibreOffice or that it could not draw; the fonts to
upload; the approximated slides (each a button that opens the slide); and the import log (`source.log`,
the newest 200 lines, warnings tagged), all deck text shown as text. 'Re-import from PowerPoint…' opens a
dialog with the hub's plan (`GET /presentations/:id/pptx-reimport`, nothing written): slides rebuilt,
picture slides made editable, edited slides kept, other slides kept, and what is always kept; slides made
editable by an older build are listed, each with 'Slide N: keep as it is'. 'Re-import' saves unsaved edits
first, queues the job and closes the dialog (focus goes back to the button, or to the report while the job
runs); the report shows its progress, and when it is done the editor takes its revision over like a
PowerPoint follow-up's (`PPTX_JOB_SAVERS` includes 'pptx-reimport': an unsaved edit of a slide stays, every
other slide shows the re-import) and says what changed. Nothing runs while the presentation is live.

## Service checklist

A printable page (`/checklist`) generated from the current settings: launch steps, health
colours, Relaunch, and the ProPresenter switch procedure.

## iPad editing

The worship lead builds the service from home on an iPad in Safari (prd/03): library, search, the
editor, playlists and arrangements, imports, media and fonts, and previews of every look. Running a
service stays on the venue PC's Chrome. Everything below is gated by capability or input type, never by
the user agent, so Chrome on the venue PC behaves exactly as before.

### Capability profile

`src/lib/capabilities.ts` detects once: `hid`, `midi`, `windowManagement` (`getScreenDetails`),
`fullscreenPopups` (the Fullscreen API on a device whose primary pointer is not a finger), `sinkId`,
`opfs`, `webgpu`, `coarsePointer` (`pointer: coarse` and `hover: none`) and `standalone`
(`display-mode: standalone` or `navigator.standalone`). The **profile** is `full` only where the
device has Window Management or WebHID (both Chromium-only: the venue PC); it is `edit` otherwise
(iPadOS Safari, a phone, Firefox, desktop Safari) or when the session role is `edit`. The Fullscreen
API is deliberately not a qualifier: iPadOS has it, and reports a fine pointer with hover as soon as a
trackpad or mouse is attached (a Magic Keyboard), which must not turn the worship lead's iPad into an
operator. `?profile=edit|full` or localStorage `ordo.profile` forces it for
support and tests (never over the edit role). The result is on `window.__ordo.capabilities` (with
`deviceProfile`) for tests.

### The edit profile

- The core worker joins the hub as an **editor** whatever the session role (`startController`): no
  own service-cache fill (no multi-GB downloads onto a tablet), no fallback-bus authority (no output
  windows exist), no core snapshot, and every dispatch is a no-op. No output windows, program views,
  keyboard driver, Stream Deck or MIDI are installed; `OutputWindows.launch` refuses on an editor core.
- Navigation: Library, Playlists, Previews and (operate PIN only) Settings with Looks, Stage messages,
  General, Themes and PINs. The live view, the checklist and the output, audio, key map, Stream Deck,
  MIDI, backups and diagnostics pages redirect to the library (`allowedForRole(route, role, profile)`).
- A playlist shows "Go live from the venue PC." instead of Go live; the nav says "This device edits;
  run services from the venue PC" (operate PIN, wide screens).
- **Live now.** The hub sends live state only to operators and outputs, so an iPad (edit or operate PIN)
  polls `GET /live/summary` (8 s, and at once when the page becomes visible; `src/lib/venueLive.ts`):
  `{ seq, mode, playlistId?, playlistName?, liveLabel?, lockedPresentationIds }`, no tokens and no full
  state. It feeds the nav chip "Live now: <playlist>, <cue>" and `useLockedIds`/`useLivePlaylistId`,
  which lock the live playlist's presentations in the editor before the hub would refuse a save with 423
  (the hub's 423 stays the real guard). A hub without the summary answers 404: an operate session then
  falls back to `GET /live`. On this profile the locked banners and the 423 toasts say "This presentation
  is in the playlist that is live at the venue. It can be edited again after the service." (the venue
  PC keeps "locked until End service").

### Look previews

`LookPreviews` (`src/views/editor/LookPreviews.tsx`) draws the selected slide under every look in
settings, main first, then the lobby lower third, the livestream key (on its key colour) and the stage
look with the next slide (following the presentation's first arrangement, as the stage display does
when the song is played through it; a playlist naming another arrangement is not known here), in the
thumbnail worker with the shared rasterizer (480 px wide in the
editor's compact form, 960 px on the Previews page), ~150 ms after the last edit. A preview job carries
the look's clear colour and the next slide (`ThumbJob.clear`, `ThumbJob.nextSlide`; both absent for
ordinary thumbnails, which render as before); the background shows only when the look's background
layer is visible, else the look's holding image, as the outputs do. The Previews page
(`#/previews/<presentation>/<slide>`) picks a presentation, steps through its slides in a strip, and
shows every look full width. Uploaded and Google fonts reach the worker as `FontFace`s in
`self.fonts`, which WebKit supports in workers (verified in Playwright WebKit: an uploaded face loads
and changes the measured width in an `OffscreenCanvas`). The worker, the editor canvas and the look
previews resolve families through the same font resolver as the outputs (design/27 §10): faces under
internal names, so a face that loads late is used by the next draw; the worker then tells its client,
which drops the cached thumbnails, and the editor redraws.

### Installable web app and lifecycle

- `public/manifest.webmanifest` (name and short name ordo, standalone, `start_url` and `scope` `./`,
  the operator's background and bar colours, 192/512 and maskable icons), an `apple-touch-icon`
  (180), the `apple-mobile-web-app-*` metas and `viewport-fit=cover` without disabling zoom.
  `src/ipad.css` defines `--safe-top/right/bottom/left` (from `env(safe-area-inset-*)`, 0 on the venue
  PC), pads `#root` with them and sets `touch-action: manipulation` on controls (no double-tap zoom;
  pinch zoom stays). The icons are committed PNGs; the manifest and icons are not precached (the
  installed app keeps its icon; the shell is precached as before).
- On the first sign-in an edit-profile device asks once for `navigator.storage.persist()` (Safari may
  grant it to an installed app; otherwise script-written storage goes after 7 days unused).
- Back from a suspension the core reconnects on its own: the hub connection judges liveness by the time
  since the last pong, so a socket that died while the page was frozen is declared lost within a
  second of resuming and reopened after the backoff. A library copy Safari evicted reloads from the
  hub snapshot. Both are covered in `e2e/ipad/edit.spec.ts`.

### Tests

The Playwright projects `webkit-ipad` (iPad Pro 11 landscape) and `webkit-ipad-portrait` run
`e2e/ipad/*.spec.ts` in WebKit with touch, each test on its own hub (`ORDO_E2E_IPAD_PORT`, default
8700 + n, path mode `http://localhost:<port>/`); the Chromium project ignores `e2e/ipad/`. The two
projects exist only when WebKit is installed (`npx playwright install webkit`; CI does), so a plain
`pnpm e2e` after `playwright install chromium` still runs; `ORDO_E2E_WEBKIT=1` insists on them.
`ORDO_E2E_SHOTS=<dir>` keeps a screenshot of each screen per orientation.
