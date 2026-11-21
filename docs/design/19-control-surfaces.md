# Design 19: Control surfaces

`packages/surfaces`. One action vocabulary, three drivers, all in the operator window.

## Actions

```ts
type ActionId =
  | 'go'
  | 'next'
  | 'prev'
  | 'nextItem'
  | 'prevItem'
  | 'goToSection' /* arg: sectionIndex */
  | 'goToSlide' /* arg: n */
  | 'clearSlide'
  | 'clearAll'
  | 'clearLowerThird'
  | 'clearProps'
  | 'clearMedia'
  | 'clearBackground'
  | 'logo'
  | 'mediaPlayPause'
  | 'mediaRestart'
  | 'timerStart'
  | 'timerStop'
  | 'timerReset' /* arg: timerId */
  | 'messagePreset' /* arg: index */
  | 'messageDismiss'
  | 'audioMute'
  | 'audioMasterUp'
  | 'audioMasterDown'
  | 'audioFadeOut'
  | 'launchOutputs'
  | 'relaunchOutputs';
type Action = { id: ActionId; arg?: number | string };
```

`dispatch(action)` maps to reducer events through the operator store. `clearAll` requires
confirmation: two dispatches within 2 s, or a surface marks the control as a hold.

## Keyboard driver

Key map `{ combo: Action }` from settings, defaults in [prd/02](../prd/02-operator.md).
Combos are normalised (`Ctrl+Shift+L`). The driver skips a key event whose default is already
prevented: an open dialog takes Escape that way, so closing it never also clears the slide
([design/15](15-operator-app.md) "Keyboard"). It takes a `blocked()` option and acts on no key while it
says so: the operator blocks every live key while a modal dialog is open. A key pressed inside a
`data-keys="off"` element (the dialog) is left alone, default included, so Space on a dialog's focused button
presses the button; one that reached the page behind it also loses its default when it would press or scroll
a control (Space, Enter, the arrows, Page Up/Down, Home, End) or is mapped. The Stream Deck and MIDI drivers
are not blocked.

## Stream Deck driver (WebHID)

- Uses `@elgato-stream-deck/webhid` for device protocol (XL, Mini, Plus, MK.2, original).
- Pairing: a Connect button calls `navigator.hid.requestDevice` with Elgato's vendor id;
  granted devices are reopened automatically on later loads via `navigator.hid.getDevices()`.
- Pages: `{ name, keys: { [index]: { action, label, icon, style } } }` in settings, with
  built-in defaults per model (key count differs). Dials on the Plus map to master gain
  and playlist scroll; its touch strip shows the live cue label.
- Rendering: key images are drawn in a worker with `OffscreenCanvas` (label text, icon,
  state colour) and sent as JPEG; redrawn on live state changes affecting that key.
  Section keys show the live section highlighted; next-items keys show the upcoming
  playlist items.
- Disconnection: `navigator.hid.ondisconnect`; reconnect on `onconnect`, redraw.

## MIDI driver (Web MIDI)

- `navigator.requestMIDIAccess({ sysex: false })`. Every input and output device is enumerated.
- Opt-in (`SurfaceSettings.midiEnabled`, Setup "Enable Web MIDI"): the operator asks for MIDI access only
  once it is enabled, so a venue without MIDI never sees the browser's permission prompt. Settings stored
  before MIDI became opt-in (2026-11-09) have no `midiEnabled`, and MIDI always started then: they read as
  enabled when they hold MIDI mappings, so an upgraded venue keeps its pedals, and as off without mappings
  (`upgradeStoredSurfaces`, applied by the hub's settings read and by the operator to a cached library
  copy). The first save of the surface settings writes the key; from then on it reads as stored.
  `e2e/surfaces-upgrade.spec.ts` writes such rows into a stopped hub's database and starts it: with
  mappings the settings and Setup show MIDI on and the operator starts it; without, both show it off and
  the browser is never asked.
- Mapping entries: `{ deviceName, kind: 'note' | 'noteOff' | 'cc' | 'programChange', number, channel?, threshold, action, paramSource? }`.
  - Static: Note-on with velocity ≥ threshold fires; Note-off (either `0x8n` or `0x9n` with velocity 0) fires for `noteOff` mappings; CC fires when the value crosses the threshold upward (edge-triggered).
  - Dynamic (`paramSource: 'velocity' | 'ccValue'`): incoming velocity or CC value is dynamically passed as the action's `arg`, enabling DAW and QuickQ show-control patterns (e.g. `goToSlide [vel]`, `goToSlideItem [vel]`, `goToItem [vel]`, `goToSection [vel]`).
- Learn: the mapping editor sets `learning = action`; the next qualifying message (Note On, CC upward edge, Program Change, or Note Off when re-learning a `noteOff` row) writes the entry. A 5 s timeout cancels.
- Presets: Foot switches (notes 60/62 for `next`/`prev`), ProPresenter 7 standard layout, and ChamSys QuickQ 20 PB 1 starter layout (`QUICKQ_MIDI_MAPPINGS`, Channel 1: Go `72`, Pause `84`, Release `noteOff` `60`, Go to Cue `48` with velocity as slide arg).
- Default output (`SurfaceSettings.midiDefaultOutput`): optional output device name used by `MidiDriver.send` and slide cues when a cue leaves `deviceName` empty (falls back to all connected outputs when unset).
- ChamSys QuickQ 20 codec (`packages/surfaces/src/quickq.ts`): lossless encoder/decoder/formatter/validator for QuickQ 20 Channel 1 MIDI notes (Playbacks 1–10: `48–57` Go to Cue with velocity 1–127, `60–69` Note On Activate with velocity 1–127 / Note Off Release, `72–81` Go, `84–93` Pause/Back). Surfaced in the slide MIDI cue editor (QuickQ 20 / Raw MIDI mode toggle + `delayMs`), live/editor thumbnail tooltips, and the Settings → MIDI Soundcheck strip.
- Named Lighting / MIDI Presets (`SurfaceSettings.midiPresets`): up to 64 venue-level presets (`{ id, name, color?, cues: MidiCue[] }`, 1–8 cues per preset, optional swatch color, plus `QUICKQ_STARTER_MIDI_PRESETS`). Snapshotted onto `ResolvedPlaylist.midiPresets` at `goLive` so live playback stays consistent with the prepared service; live manual overrides read the current `settings.surfaces.midiPresets`.
- 4-Scope MIDI Triggers (`MidiTrigger = { kind: 'preset', presetId } | { kind: 'cues', cues }`):
  - Attaches uniformly to **Background Media** (`Media.midi`, fired only when used as a slide's `backgroundMediaId`—never on foreground `media` items), **Playlist Items** (`presentation`, `media`, `timer`), **Sections** (`Section.midi`), and **Slides** (`Slide.midi`, with legacy `Slide.midiCues` read fallback).
  - `expandCues` resolves each scope onto `Cue` (`backgroundMidi`, `itemMidi`, `sectionMidi`, `midiCues`).
  - On live cue change (`midiCuesOnChange`), crossed boundaries fire in `Background → Item → Section → Slide` order (entering a new item also re-fires its background lighting so a manual override during the previous song self-heals). When a narrower scope targets the same protocol-agnostic destination key (`(deviceName, channel, type, number)` or `(deviceName, channel, type)` for Program Change) as a broader scope, the narrower scope's message replaces the broader one; messages within a single scope/preset are never deduplicated.
  - Hydration / WebSocket reconnect snapshots (`fromSnapshot: true`), `Clear Slide` / `Clear All` / `Logo`, and re-clicking the already-live slide never fire MIDI.
  - UI surfaces: preset-first `MidiTriggerPicker` across Settings → MIDI (preset manager + QuickQ starter), Library → Media (background lighting link), Editor (`BackgroundPicker`, `SongReflowEditor` section headers & progressive slide lighting pills, `SlidePanel`), Playlists (`ItemSettings` + "From background" row, `PlaylistEditor` / `PlaylistPane` badges), and Live (`LayerBar` reactive manual override chip, `SlideThumb` badge, `ActionId: 'midiPreset'` for keyboard/Stream Deck/MIDI).
- MIDI Output / Show Control: `MidiDriver.send` sends Note On/Off, CC, or Program Change messages to the cue's target device, `midiDefaultOutput`, or all outputs; pending delayed cues (`delayMs`) are cancelled when the live slide changes or on `dispose()`.
- Diagnostics: `MidiDriver.onActivity` emits structured `MidiActivityEvent` records (timestamp, direction, device, hex bytes, decoded QuickQ/MIDI summary, `sent` / `dropped` / `matched` / `unmatched` status, drop reason, and 50 ms echo-loop detection), displayed in the Settings → MIDI Activity Monitor with filter/pause/copy/clear controls and rate-limited operator warnings when a live slide cue is dropped.

Every driver dispatches actions through `actionToEvent` into the reducer, so hidden PowerPoint
slides (design/27 §9) behave the same on all of them: `next`, `prev`, `nextItem`, `prevItem` and
`go` without an armed choice skip hidden cues, a section key lands on the section's first shown
slide, and a slide key (`goToSlide`, which counts hidden slides) shows the hidden slide it names.
The Stream Deck's next-items keys list the items Next item goes to, so an item whose slides are
all hidden is not offered.

## HTTP bridge

`POST /live/events` and `POST /actions` on the hub accept the same actions with the
operate role, for tests and for future Companion-style integrations. Not exposed to
volunteers in the prototype. An integration signed in with a session sends `x-ordo: 1` on these writes
once Phones is on (`settings.phones.enabled`, design/28 P0; without it the hub answers 403
`x_ordo_required`), and any `Origin` it sends must be the hub's own host; a token principal needs neither.
