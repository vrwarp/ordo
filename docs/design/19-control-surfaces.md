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
Combos are normalised (`Ctrl+Shift+L`).

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

- `navigator.requestMIDIAccess({ sysex: false })`. Every input is listened to.
- Mapping entries: `{ deviceName, kind: 'note' | 'cc', number, channel?, threshold, action }`.
  Note-on with velocity ≥ threshold fires; CC fires when the value crosses the threshold
  upward (edge-triggered) to avoid repeats from pedals that send continuous values.
- Learn: the mapping editor sets `learning = action`; the next qualifying message writes
  the entry. A 5 s timeout cancels.
- Defaults: notes 60 and 62 on any device to `next` and `prev`.

Every driver dispatches actions through `actionToEvent` into the reducer, so hidden PowerPoint
slides (design/27 §9) behave the same on all of them: `next`, `prev`, `nextItem`, `prevItem` and
`go` without an armed choice skip hidden cues, a section key lands on the section's first shown
slide, and a slide key (`goToSlide`, which counts hidden slides) shows the hidden slide it names.
The Stream Deck's next-items keys list the items Next item goes to, so an item whose slides are
all hidden is not offered.

## HTTP bridge

`POST /live/events` and `POST /actions` on the hub accept the same actions with the
operate role, for tests and for future Companion-style integrations. Not exposed to
volunteers in the prototype.
