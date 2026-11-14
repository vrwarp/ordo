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
older state. A hub that restarts with a state equal to a window's would make the window follow it
(design/17, "hub caught up"), and with the session refused no hand-back ever catches it up, so the
window would drop the operator's next GO and show the hub's older state from then on. So from the
refusal until the hub accepts the operator again (a welcome) every `fallback.hello` and heartbeat
carries `hubRefused`, and a window on the bus takes nothing from the hub meanwhile: not that equal
state, and not the answer to a resync it asked for when it followed the hub a moment before the
refusal (the race behind `chaos-operator.spec.ts:818`). The operator's silence or `hubUp` ends it, as
any fallback. The core also re-introduces the bus (`fallback.hello`) to every window the moment the
refusal arrives, which brings back a window that followed the hub just before, and, while refused and
the authority, to any proven window that has said nothing on the bus for `RECALL_MS` (3 s; a window
on the bus reports health every second), at most once per 3 s per window: a safety net for a window
that does not know the flag.
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

Dialogs: Escape closes the dialog opened last and does nothing else (it is also Clear slide on the live,
playlists and library screens). Each open dialog marks Escape handled in the capture phase on `window`
(`preventDefault`, so the live keys, which skip handled events, never see it whatever order the listeners
were added in) and closes in the bubble phase (`components/dialogEscape.ts`). A popover inside the dialog
(a menu, the colour picker) that stops Escape to close itself keeps the dialog open.

Every dialog is modal (`aria-modal`), closable or not: while one is open no live key acts, not even with focus
outside it (the keyboard driver's `blocked()` asks the dialogs' registry, `modalOpen`, and so does the Clear
all hold), and a key pressed inside it is the dialog's (`data-keys="off"` on its root). Space or Enter on a
focused button presses that button: Space on End service's confirmation ends the service (it was Next, and
the button never pressed). A dialog takes the focus when it opens unless one of its controls did (autoFocus).
The Stream Deck and MIDI are not keys and keep working with a dialog open (design/19).

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
the same name with an empty URL (`window.open('', 'ordo-out-' + id)` returns the existing window of that
name without navigating it; a fresh blank window means there was none, and it is closed at once).
`window.open` needs a user gesture, so re-acquisition runs on gestures while live
(`services/reacquire.ts`), on the top bar's "fallback link n/m" button, on Relaunch (which first takes
the old windows over so it can close them) and on Diagnostics' "Re-acquire output windows". Which names
are tried:

- Path mode (one origin): only windows a BroadcastChannel probe confirms running in this browser, so no
  blank window flashes and no focus is stolen.
- Domain mode (op./outN./stage. hosts, the venue setup): a channel never crosses origins, so the probe
  confirms nothing. A gesture tries the outputs this browser session launched (a sessionStorage flag kept
  across reloads) that the hub reports connected; the explicit actions try every output launched here or
  reported connected. A window that is not in this browser (another tab or another computer runs it) stays
  missing, and the fallback link says so: "could not be reached from this tab: opened by another operator
  tab or another computer. Use Relaunch to take them over." Each output is tried at most once a minute
  on gestures.

## Program view

Receive-only `RTCPeerConnection` per output with host ICE only. Each `<video>` is muted,
`playsInline`, 320x180. Reconnects when the output reconnects.

## Editor

<!-- m9:render-seams -->
_Object panel sections (M9 render-seams; `views/editor/objectSections.ts`, `ObjectPanel.tsx`)._ The Object panel
renders a list of sections, each a component given one context (the object, `readOnly` for the live lock or a
locked object, `liveLocked` alone, the slide and draft, whether it is the themed lyric box and its override marks,
and `set`, the one way a section changes the object as an undo step). The built-in sections keep today's order and
markup (heading, lock and group notes, text, position and size, opacity, text style, picture, video, slide
operations, shape; `OBJECT_SECTION_ORDER` 100 to 1000), and the markup of every panel is unchanged
(`test/ObjectPanel.test.ts` pins it). M9's editor tracks add their sections with one line in
`OBJECT_SECTIONS` (or `registerObjectSection` at run time): a section has an `order` among the built-ins, applies
to the objects it says, and may stand in for built-in sections for those objects (`replaces`, such as a table's
cells in place of the shape fields).
<!-- /m9:render-seams -->

- Canvas-based editor with `react-konva` for selection, transforms and guides; the
  visual preview inside the editor uses the shared rasterizer for text so WYSIWYG holds.
  Rich text objects (design/27) are drawn by the rich engine into their cached canvas at the stage
  scale × `devicePixelRatio` (keyed by the font generation), legacy ones at 1:1 as before.
- Canvas drawing (SlideCanvas.tsx): the stage has the background layer, the objects layer (with the
  Transformer, guides and crop handles) and a text editing layer of its own that takes no pointer events
  (`TextEditingOverlay`): the selection highlight and the blinking caret of the box being edited are drawn
  there, in that object's node's frame (so they follow a drag or a transform), and the caret's 530 ms blink
  re-renders and redraws only that layer. A non-text object's node is cached as a bitmap at the stage's
  density (`nodeCacheRect`: what its drawer reaches, `objectReach`, with its hit area; text has its own
  raster cache; an object whose reach the renderer does not know, or one over 8 M device px, is drawn live)
  and drawn again only when it, its picture or geometry file, the fonts or the density change, so a
  keystroke or a drag copies the slide's other objects instead of drawing them. The floating bar's and the
  touch tools' sizes are kept by a ResizeObserver (`useMeasuredSize`), not read on every render. On a slide
  of 181 objects (90 shapes with gradients, dashed strokes and shadows, 91 text boxes) an idle caret cost
  192-247 ms of main-thread time per 6 s before (about 20 ms a blink: SlideCanvas re-rendered and the
  objects layer was redrawn) and 32-59 ms after (CDP Performance TaskDuration, headless Chromium, two runs
  of three rounds each).
- Editing a text box's plain text keeps its formatting: `editText` (`@ordo/domain`) shifts, trims and
  splits the runs and paragraph styles with the change, placed by the textarea's caret; splitting and
  merging slides cut and join them with the lines (design/27 §11).
- Lyric Script (`SongReflowEditor.tsx`, pure parts in `songScript.ts`; songs open in it on a desktop,
  'Slide Canvas' switches): the sections as cards, each slide's words in a field, the arrangement pills,
  chords and notes, and the screen previews beside them. A field shows the slide's lyric object's own stored
  text (`scriptText`: its `lyricObjectId`, else its first text box), never `firstText`, which writes
  automatic numbers and bullets into the text for bands and labels; it writes through the same `editText` as
  the Object panel's field, placed by the field's `selectionEnd` (`typeScript`), and an unchanged value
  records no undo step. So typing in a numbered or formatted song keeps its numbers a paragraph style
  (before, each keystroke stored the labels again: '1. 1. Amazing grace') and bold or italic on their
  letters; a plain song stays plain. Every split cuts that raw text through the domain's slide split
  (`splitSlidePieces`, as the slide list's 'Split lyrics' does: the new slides are copies of the slide with
  their piece of the lyric object, runs and paragraph styles kept on both sides; a copy keeps the slide's
  other objects, background, notes and hidden flag, but its MIDI cues, Bottom-Third Stream text and own sound
  stay on the first piece only, so a lighting GO fires once and each piece's strap shows its own words,
  `e2e/editor-script.spec.ts`), one undo step, the focus
  then in the first new slide's field: '---' and Enter (the typed value is stored first); ✂ Split at Cursor
  and Alt+Enter (Opt+Enter) at the caret of the field that has the focus only (a field never focused
  reports a caret at 0), an empty next slide when the caret is at the end, nothing at the start or without
  the focus (never a cut in the middle of a word); Auto-Split (2 lines) by the raw lines that hold words.
  The stream tag ('⚠ 3 lines · Clips 2-line Stream') counts those raw lines.
- Text ops (M4; `views/editor/ops/text.ts`, applied through `actions.ts`, one undo step each, nothing
  recorded when nothing changes): `formatRange` formats the textarea's selection (runs split, normalised,
  equal neighbours merged, at most 2,000, values bounded as the schema bounds them; Clear formatting
  removes every run field), `resizeRange` scales its sizes relative to the box size (an effective
  2-1,000 px; back to the box size drops the override), `setParas` styles the whole PowerPoint paragraphs
  it touches (a soft line inherits the change; exact and proportional line spacing replace each other),
  `selectionStyle` / `selectionParas` give the format bar and the paragraph strip their values (resolved
  as the engine resolves them, mixed fields listed), and `refitText` is 'Re-fit text'. A text edit never
  touches the box style, so PowerPoint's stored fit scale (`fitScale`) holds while the text fits and the
  engine fits smaller when it does not; only 'Re-fit text' clears it.
- Themes keep the lyric runs' structure (`themedRuns`): applying one drops each run's face, colour, size,
  letter spacing, outline, shadow and highlight, keeps weight, italics, underline, strike, caps, language
  and the verse superscripts (`baseline`) and paragraph styles, and drops the stored fit scale (the theme's
  box is fitted again). Formatting the lyric object of a themed presentation marks the slide's override
  `runs.<field>` (`runs.color`, `runs.sizeScale`, ...; `runs` keeps every one), so the next theme keeps it,
  as `style.<field>` keeps a box style field. A choice that sets several fields marks every one of them: each
  contrast choice (the floating bar's Clean, Shadow, Outline and Heavy, `contrastChoice`; the drawer's four
  readability cards, which name both fields through TextStyleEditor's `onChange(style, key, also)`) sets the
  outline and the shadow and marks `style.outline` and `style.shadow`, so the next theme keeps exactly what
  was chosen (before, the floating bar marked only the outline and a theme change dropped its Soft shadow;
  the drawer's Soft Shadow got the theme's outline back).
- The canvas-first top bar's Background (beside + Text, + Image, + Video and Shapes) is the Slide panel's
  'Replace…' for this slide (`replaceBackgroundWith(slide, media, 'slide')`, one undo step, the picker asks
  for media with a known size): on a slide imported from PowerPoint its bottom background shapes go and its
  background picture is re-cropped to the new one, a video becomes the slide's motion background, so the
  picked background shows on the canvas and the screens (before, it set `backgroundMediaId` under the
  slide's own PowerPoint background shape, which still covered it).
- Property panel bound to the selected object's schema.
- Clipboard (`views/editor/ops/clipboard.ts`, `actions.ts`): text copied in ordo keeps its runs and
  paragraph styles (`data-ordo-rich`); HTML from other apps (Bible Gateway's verse numbers and red letters,
  Word, Google Docs, web pages) becomes runs and paragraphs; slide objects copy as `data-ordo-objects`, so
  they paste on another slide, another tab or another device. Both payloads carry their format (`v`,
  `CLIPBOARD_FORMAT`): ordo reads its own and the unversioned first one and leaves a newer one alone (the
  paste falls back to the HTML's text). Clipboard HTML is untrusted (design/21): the reader is a small
  tokenizer, linear in the HTML whatever it holds, bounded by `CLIPBOARD_LIMITS` (4 M characters read,
  100,000 nodes, 256 levels, 20,000 characters of text, 200 objects) and never throws (fuzzed in
  `clipboardHtml.fuzz.test.ts`). An object pasted from the system clipboard is kept only if it passes the
  slide object schema (its parsed data: unknown keys dropped), the importers' sanitize dispatch
  (`@ordo/importers` `sanitizeObject`, loaded with the first such paste so it stays in the importer's chunk;
  M9's tables, charts, decorations, warps and 3-D looks included) and the render clamp; its re-import
  identity (`origin.shapeId`, `ph`, `role`) is dropped and only `origin.group` kept, renumbered, so a pasted
  shape with its text still selects as one. A paste inside ordo (the in-memory copy) and Duplicate keep the
  whole origin and `locked`, as before. A text paste never takes a box past 20,000 characters. When objects
  of a `data-ordo-objects` payload are left out, a toast says how many ("2 pasted objects could not be used
  on a slide: nothing was added"); a payload whose objects all fail is still an object paste (its HTML's text
  is not pasted as a text box). #24's readers that need no open panel (the floating bar's `o.style` and
  `o.text`, the hidden backing text field, the deck swatches) only ever see objects that passed: they and the
  Object panel are server-rendered for thousands of mutated objects the paste keeps
  (`untrustedReaders.test.ts`).
- Every add stops at what the screens draw (`canAdd`, `ops/slides.ts`): the render clamp draws at most 200
  objects and 16 distinct pictures of a slide and drops the topmost, which would be the volunteer's newest.
  The toolbar's Text, Image, Video and shapes, a pasted picture, text or objects, and Duplicate check first
  and say why they did not add ("This slide already has the most objects a slide can show (200)" or "…the
  most pictures…"). A picture pasted from the clipboard is added when its upload finishes, unless the
  presentation went live meanwhile.
- Errors (`components/ErrorBoundary.tsx`): a render error stays in the part of the page it happened in. In
  the canvas-first editor the stage (the Stage lens or the canvas), the Tune drawer's panel, the 4-screen
  tray and the Lyric Script each sit in an error boundary whose fallback says that part could not be shown,
  that the screens and the live controls are not affected, and offers Try again and Undo (a new slide or an
  undo draws it again by itself). The floating bar has a boundary of its own whose fallback is no bar, so an
  object the bar cannot read never blanks the canvas under it. The app puts one around each page, so the
  navigation, the toasts and the sign-in overlay always stay (`PageError`: 'Try again', and the menu to go
  on; on the Live page, whose slide grid and buttons are the live controls, it says instead that the screens
  keep showing what is live and the keyboard and pedals still work, and to press Try again). Each is logged.
- Pictures are drawn with their crop, flips and mask (`ImageObject.crop`, `flipH`, `flipV`, `mask`) by the
  same `drawImageFit` every other drawer uses (design/27 §11 item 6; M4 item D, `CropControl.tsx`, pure ops
  in `ops/pictures.ts`, one undo step each, the crop fields coalescing per picture). The Object panel's
  image section has:
  - Crop: Left, Right, Top and Bottom as percentages of the picture, named as seen on the slide (a
    mirrored picture's Left is its source's right share), each kept short of its opposite side; a negative
    share leaves that side empty. 'Reset crop' shows the whole picture. A stretched picture whose cropped
    part is not the shape of its box (a 4:3 photo stretched over a 16:9 box) says so and offers 'Keep
    proportions': the largest part of it with the box's aspect, centred where it is.
  - 'Crop on the slide' (`aria-pressed`): the whole picture is drawn faintly around its box; dragging it
    (or the box) moves the picture behind the box, the arrow keys move it by 1 px (Shift: 10), and eight
    handles (30 px under a finger) scale it at its own aspect about the opposite corner or side, so the
    handles never distort it. The box stays; the selection's Transformer is hidden meanwhile. Enter or
    Escape, a click on another object or on the slide, or the button again ends it. Every handle has its
    numeric field.
  - Mask (a radio group): None, Ellipse, Rounded with its 'Corner size' (% of the shorter side). 'Corner
    radius' is hidden under a mask, which draws the corners; removing a mask also drops a radius that was
    only the importer's stand-in for it. A PowerPoint mask the picker does not offer (another preset,
    custom paths or a geometry file) checks no choice and hides 'Corner radius' too; picking None or one
    of the offered masks replaces it. Flip horizontal and Flip vertical are toggle buttons.
  - 'Replace' keeps the look, not the crop numbers: a stretched picture is cover-cropped to its box,
    centred on the old crop's centre, so a picture of another aspect is never distorted; a contained or
    covered one keeps its fit and drops the crop. Box, mask, flips, opacity, radius and a video's clip stay.
  - All of these are read-only on locked art and while the presentation is locked.
- Saves via `PUT /presentations/:id` with `rev`. On 409 a revision only the PowerPoint jobs saved is taken
  over (`adoptJobSaves`, also as soon as the library shows it: unsaved edits are kept, a follow-up's slides
  taken slide by slide, a re-import's through the three-way merge below, so a slide the volunteer changed
  while the re-import rebuilt it is a conflict, not a silent loss; the undo and redo steps move with the
  draft, so an undo never takes the job's work back out); else the version that won (the 409 body's `current`) is merged with the draft by
  a three-way merge over the base (`views/editor/merge.ts`, design/27 §11 item 17): edits to different
  slides, or to different boxes of one slide, are combined, the draft becomes the merge on their revision
  (undo and redo move with it, so an undo never takes their work out) and saves again, with a toast. Where
  both changed the same box, slide field or presentation field differently, the conflict dialog
  (`ConflictDialog.tsx`) lists what overlaps by slide number and keeps 'Reload theirs (discard mine)' and
  'Save mine anyway'; Cancel has the focus, which goes back where it was when the dialog closes. The
  'Someone else saved' banner says that saving combines the two.
- Disabled with a banner when the presentation is referenced by the live playlist.
- The editor's shortcuts follow the focus (`views/editor/editorKeys.ts`): an open dialog keeps every key
  (Delete on its Close button never deletes the object behind it, Enter presses its buttons); a field keeps
  its own keys (Ctrl+S still saves); a focused button, link, radio or menu item keeps Enter, Space, the
  arrows (a radio group moves between its choices without nudging the box) and Delete, and only the Ctrl
  commands (undo, redo, duplicate, find) apply; with the focus on the slide canvas or the page, Delete, the
  arrow nudges, Enter (edit the text) and Escape (drop the selection) apply too. The non-modal Find card
  (`data-nonmodal`) is not a dialog for this: its fields are fields and the canvas keeps every shortcut
  while it is open. In the canvas-first layout a selected text box has a hidden backing text field
  (`#ordo-text-editor` marked `data-backing-text`, SlideCanvas.tsx), which the inline editor and the
  floating bar type and format through; when inline editing ends (Escape, a click away) and that field
  still has the focus, it is blurred (`releaseBackingField`), so the next ArrowRight nudges the box, Delete
  deletes it and Escape drops the selection, instead of moving an invisible caret or deleting letters
  nobody sees. The backing field sits on the stage at the caret (`caretOnSlide` × the stage scale, turned
  with its box), so an input method's candidate window opens by the text being typed. Keys an input method
  is composing with (Chinese, Japanese, Korean: `isComposing`, or key code 229) are its own in every editor
  key handler (`composing`, editorKeys.ts: the inline editor, the backing field, the Object panel's text
  field, the typography card's shortcuts, Find's Enter and Escape, the Lyric Script's Alt+Enter): Escape
  cancels a candidate without ending inline editing, Enter confirms it without jumping to the next match or
  splitting a slide, and the arrows choose a candidate.
- Groups and locked objects (design/27 §11 item 5 and "Locked objects"; pure ops in `views/editor/ops/group.ts`,
  the panel's parts in `GroupPanel.tsx`). The selection is a set of objects with a primary one, which the
  Object panel edits. A click on an object of a group (`origin.group`: a flattened PowerPoint group, or a
  shape with its text) selects the whole group, a click on an object already selected keeps the selection
  (so the press can drag it), Alt-click or a long press under a finger (500 ms) selects one member, and
  Shift-click adds or takes out an object's group (Shift+Alt one member). The Transformer spans every
  selected object: a drag of any of them moves them all (the group box snaps as one), its handles scale every
  member's box about the group box (font sizes, insets and stroke widths do not scale) and turn them about
  its centre. Delete, Ctrl+D (the copy is a group of its own, 20 px off, selected), the arrow keys and the
  touch nudge bar, the z-order buttons (the selection moves as one contiguous block) and Ungroup (toolbar;
  the touch Arrange menu while a group is selected) act on the selection, one undo step each. With several
  objects selected the panel says so, offers 'Select one' (Alt-click's equivalent) and Ungroup, and its box
  editor edits the group box (X, Y, W, H and 'Turn by'); a member selected alone offers 'Select the group'
  and 'Take out of the group'. A locked object (PowerPoint art, SmartArt, table grids) has a lock badge on
  the canvas and 'From PowerPoint (not editable)' in the panel: it can be moved, resized (art keeps its
  aspect: corner handles only, W and H linked), deleted and reordered; it does not turn, and its text, style
  and geometry fields are disabled.
- 'Align to slide' (the box section's bar in the Tune drawer: left, centre, right, top, middle, bottom; and,
  for a selection of several objects, the floating bar's Align menu) and 'Screen placement' (a text box's
  cards: Center Screen, Lower Third, Bottom Third, Top Banner) act on the whole selection as one block, as
  the box fields and the Transformer do (`actions.ts` `placeSelection` through `placement.ts`
  `placeObjects`, one undo step): a
  PowerPoint shape with its text, a group or a table's cells never come apart. The block is the
  selection's bounds as drawn (`groupBox`: each member turned about its centre), so a turned box aligns by
  what the screens show and keeps its turn; a placement card scales the block onto its box (members keep
  their place in it, a locked picture its aspect). On a deck that is not 16:9 both work inside the deck's
  own area (`source.native.slideRect`, the canvas's 4:3 guide), the cards' boxes scaled into it
  (`presetIn`); the card whose box the block is near shows as active. Placing a themed song's lyric box
  marks its `box` override, as the box fields do. Nothing moves under the live lock; a locked object's box
  may.
- Formatting text (M4; `views/editor/FormatBar.tsx` and `ParagraphStrip.tsx` around the text field,
  applying `ops/text.ts` through `actions.ts`, one undo step each). The 'Text format' toolbar over the
  field formats its selection: font, Size − / +, Bold, Italic, Underline, Strikethrough, Superscript and
  Subscript (verse numbers), Caps, Clear formatting, the text colour (swatches of the deck's colours first:
  the applied theme's text colour, then the colours its text and shapes use, most used first; then the
  Office theme's) and a highlight; letter spacing, outline, shadow and language are behind 'More'. Pressed
  states and values show the selection (`aria-pressed="mixed"` and 'Mixed' where it differs), a value equal
  to the box's removes the override, and with a caret the bar is disabled ('Select text to format it.').
  Ctrl+B / Ctrl+I / Ctrl+U work in the field; a button gives the field its focus and selection back, and a
  pointer never takes them away. Ctrl+Z and Ctrl+Y (Ctrl+Shift+Z) in the field are the editor's undo and
  redo, not the field's own (which knows nothing of a Bold), so Bold then Ctrl+Z takes the Bold back; the
  caret stays where it was. The field's range is put back as the key is handled (after an undo, a redo, a
  cut or a paste the editor made), never a frame later, so a click or keys that follow at once keep their
  own selection (`fieldSelection.ts`). The 'Paragraph' strip under the field styles the PowerPoint paragraphs the
  selection touches: Align and Direction (Auto, Left to right, Right to left) as radio groups, List (bullets
  • ● ■ ▪ ➢ ✓, numbers 1. (1) 1) a. i. with 'Start at'; a list started on paragraphs without an indent gets
  a hanging one wide enough for its labels), Level and Indent − / + (each paragraph from its own value),
  space before and after, and line spacing (as the box, a multiple of single, or exactly). Number fields
  apply as they are typed, coalesced into one undo step per field. Every control is a design-system
  button or field (44 px under a finger).
- Text box options (TextStyleEditor's `box`, in the Object panel only; themes and looks keep their editor):
  Shrink text to fit with 'Re-fit text' (clears PowerPoint's stored fit scale, so the text is fitted again
  from full size), Wrap lines, the four insets in place of Padding (the padding keeps the smallest, the
  closest value for an older build), Direction, the line spacing model (ordo or PowerPoint) and a fallback
  font for a second script.
- Guides (`CanvasGuides.tsx`, `textFit.ts`): a text box whose text does not fit, laid out as the drawers lay
  it out (the rich engine's `overflow`, a shrink-to-fit box only past its smallest fit; legacy text whose
  lines are taller than the box), has a dashed red edge on the canvas, and the Object panel says "Text does
  not fit: turn on Shrink text to fit or enlarge the box" (a box already shrinking: enlarge it or shorten
  the text). An imported deck that is not 16:9 (`source.native.slideRect`) has its area outlined and the
  bars outside it shaded, so text stays inside what PowerPoint showed.
- Slide and presentation ops for churches (design/27 §11 items 6-11; pure ops in `views/editor/ops/slides.ts`
  through `actions.ts`, one undo step each, saved with the presentation). 'Find…' in the toolbar (Ctrl+F
  outside a text field) opens Find and replace (`FindReplaceDialog.tsx`): Find, Replace with, Match case,
  Whole words (letters, marks and digits are word characters; a typed space also finds a no-break space);
  the count ('3 matches on 2 slides', a polite live region) and every match listed by slide number with the
  text around it before anything is replaced, hidden slides included and tagged, locked objects left out; a
  listed match opens its slide and starts inline editing on the canvas with the match selected
  (`goToMatch`; under the live lock, on a locked box or on a slide that shows its PowerPoint picture the
  match is only highlighted), so what is typed next shows where it lands. The card is non-modal and docked
  at the top right of the stage pane (in the Lyric Script, which has no stage, it floats over the page): it
  never covers the slide list or the open Tune drawer's tabs, and the floating bar keeps clear of it. Escape
  ends inline editing first, then closes the card, then drops the selection. Replace all replaces every match
  as typing the same change in the text field would: only the part of the match that differs is replaced
  and takes the formatting of the text it replaces (a bold red date stays bold and red, the plain words a
  match also covers stay plain; the box style and its stored fit are untouched). A match on a slide that
  shows its PowerPoint picture on the screens is marked, since the change does not show there. The slide list dims a
  hidden slide (its number and picture; the Hidden tag stays readable), and the selected slide's actions
  have 'New slide like this' (a copy right after it with its text cleared, keeping each box's style, its
  first paragraph's style and the formatting of a run over its whole first paragraph, without notes, the
  hidden flag, a scripture reference or the PowerPoint picture; the new slide opens) and a 'Hidden' toggle
  (`aria-pressed`). The Slide panel's Background shows the picture the slide shows and where it comes from
  (from PowerPoint, this slide only, the presentation's default), 'Replace…' (images and videos) with a
  scope radio group, 'This slide' or 'All N slides using it', and 'None' or 'Use the default' for a
  background of its own; the Presentation panel has 'Replace on all slides…' for the deck's background (its
  default, else the picture most slides show). A replace rewrites every use of the picture: slides' and the
  presentation's `backgroundMediaId` (drawn cover-fit) and `role: 'bg'` pictures, re-cropped by the picture
  replace rule so a picture of another aspect is never distorted; a slide with a solid PowerPoint background
  loses that shape so the picture shows; a video becomes a motion background. A box from a PowerPoint
  placeholder (or layout shape) offers 'Apply to similar boxes…' in the Object panel, confirmed with the
  count ('Apply to 12 boxes on 12 slides?'): the similar boxes take its style and paragraph styles by level,
  keeping their text and runs (a themed lyric box marks the style fields it now overrides). A picture that
  covers the whole screen offers 'Use as background', which moves it to the slide's `backgroundMediaId`
  (on a 4:3 deck a picture covering only the slide area stays a picture: a background is drawn over the
  whole screen and would lose a quarter of its height). The pickers of 'Replace' and the background replace
  list a picture still being processed but let it be chosen only once its size is known (a stretched
  picture replaced by one of unknown size would be distorted; `replacePicture` gives such a picture
  `fit: 'cover'` as a safety net); each thumbnail is a button named by the media name.
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
- PowerPoint shapes (design/27 §11 "Mapping", §15 M6; `views/editor/ObjectShapeFields.tsx`, its patches pure
  functions in the same file). The Shape section shows a stored geometry read-only in place of the
  rect/ellipse/line picker: the preset's name with each adjust value (the stored one, else the preset's
  default, evaluated as the drawer evaluates it), or a freeform's path count. Fill is none, a solid colour,
  or a linear (angle) or radial gradient of 2 to 16 stops, each with a colour and a position; every gradient
  edit also writes the legacy `fill` as the first stop's colour, which an older build draws. The stroke has
  a dash and, on an open outline (a line, an arc, a bracket, a connector, or a shape that already has one), a
  start and an end arrowhead with its size; a solid dash and no arrowheads store nothing, so a plain shape
  keeps its legacy drawing. Shadow on adds PowerPoint's 'Offset: Bottom Right' outer shadow, or keeps an
  imported one. A locked shape's style fields are read-only; its box stays editable.

### Canvas-first layout

The desktop editor (a fine pointer; #24) puts the slide first. A touch device keeps the docked panel
described under Touch: the classes below are set for a fine pointer only, and the floating bar never shows
under a finger.

- **Columns and the Tune drawer.** Two columns, the slide list (224 px) and the stage. The panels (Object,
  Slide, Presentation) are a drawer of 316 px, closed by default, opened from the top bar or the floating
  bar's More…, closed by its ✕ or the top bar's 'Tune ✕'. Selecting an object does not open it.
- **Top bar, three zones.** Left: Library, the title (edited in place), Save with the revision pill
  (History), a song's Lyric Script | Slide Canvas switch, Undo, Redo. Centre, the insert island: '+ Text',
  '+ Image', '+ Video', Shapes, Background. Right: zoom (Fit, 50 %, 75 %, 100 % = Fit), Find…, the drawer
  triggers Slide, Presentation and Tune, and Full screen. The bar fits any window (`e2e/editor-fit.spec.ts`): below about
  1,250 px (about 1,450 px for a song, whose mode switch takes about 190 px) the three triggers are one
  'Panels ▾' menu (`components/Menu.tsx`: Slide, Presentation, Tune), and the title gives way (190 px down
  to 64 px) before anything moves; if the bar still does not fit (a song at 1024 px, a wider system font),
  the right zone wraps to a second row as one unit, at the right. Nothing is cut off: every control can be
  clicked at 1024x768 and 1280x720, and the editor clips rather than scrolls (`overflow: clip`), so
  focusing a control by keyboard never shifts the slide list off screen (`e2e/editor-fit.spec.ts`).
- **Floating bar** (`FloatingContextBar.tsx`, placed by `floatingBarSpot` in `touchGeometry.ts`). It shows
  while an object is selected, unless the drawer is open on Object; text, shape, picture and multi-selection
  bars end with Layer, Duplicate, Delete and More…. Its tiers: above the box and its rotate handle; below a
  box near the top of the slide; docked inside the top edge of a tall box (the top bezel while its text is
  edited inline); clear of an open Find card. It fits its pane (`e2e/editor-fit.spec.ts`): its width is its one-row width,
  at most the pane's less 16 px whatever its offset, and a wider row wraps to a second row instead of
  running under the slide list or the drawer (the drawer open at 1024 px leaves a 484 px pane). SlideCanvas
  measures that size and `floatingBarSpot` clamps the bar inside the pane, so it never starts past the
  pane's left edge, and it never covers the selection's handles at Fit, 75 % and 50 %.
- **Font select.** The family select is named 'Font' wherever it is shown (the floating bar, the Typography
  card, the text style editor, the Themes tab); over a selection of several fonts it shows 'Mixed' and is
  named 'Font (mixed)' (`e2e/editor-fit.spec.ts`), and a family picked there applies to the whole selection.
- **Paint picker** (`PaintPopover` in `components/ColorPicker.tsx`; every colour field opens it). Tabs
  None (where the field allows it), Solid, Linear, Radial; the colour square, hue and alpha sliders, the hex
  and % fields and the eyedropper act on the solid colour or the active stop; then the deck's swatches and
  Recent; a gradient has its ramp (a click adds a stop there, pins drag), the angle chips and one bar for the
  active stop (hex, position, + in the widest gap, ×). Each edit is a pure function of `paintStops.ts`: the
  stops stay sorted by position and the stop being edited stays active, so a pin dragged past another keeps
  moving the same stop; a gradient keeps 2 to 16 stops; Linear ↔ Radial keeps the stops, the angle, the
  focus (`center`) and `scaled`; Solid keeps the colour shown; a gradient from a colour runs to a darker
  shade of it. The sliders follow the colour by value, so an open picker on None is idle (#24's
  re-rendered for as long as it was open; `e2e/editor-fit.spec.ts`).
- **Deck swatches** (`components/deckSwatches.ts`). Up to 8: the applied theme's text colour, then the
  deck's most used colours (text and run colours, shape fills, gradient stops of shapes and gradient text,
  and M9's palettes: a table's text, run and fill colours, a decoration's fills, gradients and outlines, a
  chart's fills), then the curated defaults. The scan stops after 50,000 colours and skips anything that
  is not a colour (a deck's objects are untrusted). The editor hands the deck to the pickers through a
  React context (`DeckSwatchesSource`), so no shared component imports the editor's store and the editor
  route can be loaded on its own; a picker outside the editor offers the curated defaults.
- **Stage lens.** Under the stage, 'Canvas' and one pill per look (`previewLooks`: Main, Lobby,
  Livestream, Stage) and 'All 4 screens ▴', the tray of look previews. A look's pill replaces the canvas
  with that look drawn at 1280 px by the thumbnail worker (`SingleLookStagePreview`, 100 ms after the last
  change); a key look is drawn over a simulated camera picture ('CAM SIM', or 'RAW KEY' to see the key
  alone).

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
Controls are 44 px with 16 px inputs (no focus zoom), the canvas-first editor's compact controls included
(the paint picker's tabs, the Stage lens pills, the selected slide card's actions, which wrap in the slide
list, and the Lyric Script's arrangement pills get 44 px back under a coarse pointer);
`e2e/ipad/touch-targets.spec.ts` audits every visible control of the editor, the docked panel, the slides
list, the paint picker and the Lyric Script in both orientations, the picker's 32 px swatch grid and the
ramp's stop pins its named exceptions. In portrait the editor's property panel and the
playlist's add panel move under the main pane. File pickers are a plain button to the native picker
(Files, Photos): photos arrive as JPEG because Safari transcodes HEIC when the accept list does not name
it (the hub does not accept HEIC), videos as MOV or MP4.

## Media library

The Media tab hides the pictures imports make for presentations (pages tagged `document`, native-import
pictures tagged `pptx`) unless 'Show presentation pictures' is ticked (design/27 §11 item 15). Deleting
media that stored presentations or playlists use (a playlist's media item, an item's background or its
music) names them in the confirmation first, since a missing picture or media item refuses goLive and
missing music leaves the pre-service loop silent: the hub answers such a `DELETE /media/:id` with 409
`media_in_use` (the titles and names in its message, `presentations` and `playlists` in its body) unless
it carries `?force=1`, which the tab sends once the user has confirmed.

**SVG pictures** (design/14 "Pictures that are SVGs"). `uploadMedia` (`src/services/upload.ts`) draws an SVG
through an `<img>` into a canvas at `svgRasterSizeFor` (`rasterizeSvg`: 10 s at most; a decode error, a
tainted canvas or no page sends the SVG alone) and posts the PNG beside it as `raster`, which the hub keeps as
its delivery: thumbnails, the editor canvas and outputs draw that still. Tiles where media is picked (the
Media tab's rows and preview, the media pickers, the background swatches: `tileHash`) show the SVG itself, so
an animated one moves there, and say "SVG · moves in previews only" (`svgNote`): Audience screens show its
first frame. An SVG over 24 MB goes through the resumable upload alone; once the hub has it the operator
draws its still and sends it to `PUT /media/:id/still` (sent again while the hub is still processing the SVG;
`sendStill`). An SVG without a still (this browser could not draw it, the hub refused it, or it predates
stills: such a one keeps the advice below, nothing redraws it) says instead that each Audience screen draws it itself when
it is shown, or, over 2 MB (`SVG_SCREEN_MAX_BYTES`), that the screens do not show it: upload it again from a
browser, or a PNG of it. An SVG's media size is its still's (at least 1,920 px on its longer side), so '+ Image'
and a paste start it at the size its root element declares (`insertBox.ts`: a 200 x 80 logo at 200 x 80, not
slide-wide), half the slide wide at its ratio when it declares only a viewBox; any other picture starts at its
pixel size, at most the slide's width.

## Settings

Outputs and looks, audio devices and pairs, key map, Stream Deck pages, MIDI mappings,
PINs, output tokens, backups, diagnostics export. Each page is a form over the matching
`/settings/*` resource.

- **Screens** (`views/settings/OutputsPage.tsx`, #17): each output is badged by the role its look gives it:
  Stage (a stage output or look), Bottom-Third Stream (a lower-third or stream look, or any lyric-only
  look) and Audience (the rest). The role decides what an output shows during an announcement loop
  (prd/04 "Screens and announcement loops"): the loop on Audience, 'Service Starting Soon' on Stage, no
  band on Bottom-Third Stream (`lyricTextFor` returns no text for a loop on a non-stage look; the lobby
  shows its holding slide). This is the owner's choice, kept deliberately; a lobby that should show the
  loop uses the Main look.

- **The stage look's notes** (design/27 §11 item 13, M4). The look page's 'Stage screen' card
  (`src/views/settings/StageNotesOptions.tsx`, shown for a look of kind stage, and for any look whose notes
  are on) has 'Notes: show the live slide's notes, for the preacher' (`PropsRule.notes`). While it is on it
  shows the notes box (a `BoxEditor` without rotation, in a fieldset) and the notes text (`TextStyleEditor`).
  Until either is edited the look stores no `style['notes']`, and the card shows the stage's default box,
  under the next-slide band, which follows the lyric bands. Editing stores both. 'Use the default box and
  text' removes them again. A box that overlaps the current lyrics band is said in a status banner: the
  stage shows only the part beside the lyrics. The preview draws a sample line in the notes box.

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

A PowerPoint imported as editable slides is parsed in this browser first (design/27 §2 "Where the deck is
parsed"; `services/pptxParse.ts`): in the import worker (`workers/import.worker.ts`, a bundle of its own, so
the importer never weighs on the page), one worker per deck, terminated when it answers or after 90 s, with
the library's faces for the families a deck with a table names (fetched from the hub). The upload then
carries the scene (`clientScene`) for the hub to check and build from; the import's progress bar shows the
parse as its first half. The browser does not parse while a playlist is live (the hub refuses the import
then, as before), and any failure, timeout or a table in a face only the hub can measure (WOFF, WOFF2)
uploads the deck without a scene, so the hub parses it: the volunteer sees the same import either way.
Settings › Diagnostics counts the decks parsed here and those left to the hub, by reason ('a playlist was
live', 'the browser took too long', 'the browser could not read it', 'this browser cannot parse in the
background'); each is in the operator log and its export too.

In the editor, a slide imported natively has a 'From PowerPoint' card in the Slide panel
(`PptxSlideCard.tsx`): its class, what was approximated, LibreOffice work still pending, and 'Show
original', which lays the PowerPoint picture of the slide (`Slide.pptx.refMediaId`) over the canvas so a
volunteer can compare; the canvas takes the pointer meanwhile. It is a view of the editor and changes
nothing stored. When there are no pictures yet, turning it on saves unsaved edits, asks the hub for them
(`POST /presentations/:id/pptx-reference` with `{ showPicture: [] }`: no slide switches to its picture) and
follows the job; when it is done the editor takes the pictures over, keeping edits made meanwhile. A slide
set to show its PowerPoint picture on the screens (`Slide.pptx.show`) says so, with 'Show the objects
instead'. The canvas, the thumbnails and the look previews draw a slide as the outputs
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
  keeping its id, notes, timing, background, Bottom-Third Stream text, MIDI cues and the objects added in
  ordo on top. History keeps the slide as it was.

'Make editable' on a legacy PowerPoint page (a picture import from before M3) rebuilds the page from the
stored deck: the hub reroutes it to the re-import of that slide (202 and the job), the editor follows the
job and takes it over, and the page becomes the native slide with the objects added over it on top and its
notes. A PDF page, or a deck no longer stored, keeps today's text boxes over the page picture.

The Presentation panel of a PowerPoint presentation ends with its import report (`PptxReport.tsx`): the
slides per class (`source.native`) or, for a legacy import, that its slides are pictures; legacy pages
left; hidden and edited slides; slides waiting for LibreOffice or that it could not draw; the fonts to
upload; the approximated slides (each a button that opens the slide); and the import log (`source.log`,
the newest 200 lines, warnings tagged), all deck text shown as text. A deck PowerPoint plays as a loop, every
slide timed, comes in as an announcement loop: its panel shows the report too, with a banner that says in
plain words what a loop does on the screens (each slide moves on by itself and starts over; the Stage shows
'Service Starting Soon' and the Bottom-Third Stream nothing while it runs) and a 'Treat as slides' button
(disabled while live) that makes it a slide deck in one undoable change (design/27 §8 "Looping shows"). Such a
deck opens canvas-first with the drawer closed, so the stage carries one line too (`LoopDeckBanner`): it plays
as a loop and the Stage and the Bottom-Third Stream show none of its words, with 'Treat as slides', 'Import
report' (the Presentation drawer) and 'Keep as a loop' (hidden for this visit). 'Re-import from PowerPoint…' opens a
dialog with the hub's plan (`GET /presentations/:id/pptx-reimport`, nothing written): slides rebuilt,
picture slides made editable, edited slides kept, other slides kept, and what is always kept; slides made
editable by an older build are listed, each with 'Slide N: keep as it is'. 'Re-import' saves unsaved edits
first, queues the job and closes the dialog (focus goes back to the button, or to the report while the job
runs); the report shows its progress, and when it is done the editor takes its revision over like a
PowerPoint follow-up's (`PPTX_JOB_SAVERS` includes 'pptx-reimport': an unsaved edit of a slide stays, every
other slide shows the re-import) and says what changed. Nothing runs while the presentation is live.

<!-- m9:lo-detect -->
_M9 (design/27, track `lo-detect`): a hub without LibreOffice._ The operator reads what the hub's tools allow
(`lib/hubCaps.ts`: `GET /capabilities` with the protocol's `.catch` defaults, 404 meaning a hub before M9 with
LibreOffice, a network error keeping the last answer, asked again on every reconnect) and offers only that:
- the import screen hides 'Pictures (LibreOffice)'; a choice remembered from a hub that had it imports as
  editable slides and the screen says "This hub has no LibreOffice, so PowerPoint files are imported as
  editable slides"; the drop zone takes .pptx, .ppsx, .potx, .pptm and, with poppler-utils, .pdf;
- the import card says nothing of LibreOffice on such a hub (nothing waits for it) and names the slides with
  something ordo cannot draw and what it is ("2 slides have something ordo cannot draw: a chart, a vector
  picture"); the import report counts them;
- the slide card shows "Not drawn: a chart" (`Slide.pptx.missing`), keeps 'Show original' for a slide that
  already has its picture, and offers 'Add PowerPoint's pictures (PDF)…' (the deck exported as PDF from
  PowerPoint, sent to `pptx-reference` as multipart) where LibreOffice would have drawn them.
<!-- /m9:lo-detect -->

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
`e2e/ipad/*.spec.ts` in WebKit with touch, each test on its own hub (its port from the e2e port table, design/23 "Ports";
path mode `http://localhost:<port>/`); the Chromium project ignores `e2e/ipad/`. The two
projects exist only when WebKit is installed (`npx playwright install webkit`; CI does), so a plain
`pnpm e2e` after `playwright install chromium` still runs; `ORDO_E2E_WEBKIT=1` insists on them.
`ORDO_E2E_SHOTS=<dir>` keeps a screenshot of each screen per orientation.
