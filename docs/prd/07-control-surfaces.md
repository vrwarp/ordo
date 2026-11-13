# PRD 07: Control surfaces

## Keyboard

The default key map in [prd/02](02-operator.md). Keys work only while the operator window
is focused. The key map is editable in settings and stored on the hub.

## Stream Deck

- Supported through WebHID: Stream Deck XL, Mini, Plus, MK.2 and original. The operator
  pairs the device once in Chrome's HID prompt; the permission persists for the origin.
- The deck shows a page of actions with key images and live state: GO, Next, Previous,
  Clear slide, Clear all (with confirm), Clear lower third, Logo, Play/Pause, each
  section of the live presentation (V1, C, B with the live section highlighted), and the
  next three playlist items.
- Pages: Live (default), Stage (messages presets, timer start/stop), Audio (mute, fades).
  The Plus model's dials control master gain and scroll the playlist.
- Mapping editor: assign any action to any key, per page, with a label and icon. Defaults
  are provided.
- Device loss and reconnection are handled silently; the deck is redrawn on reconnect.

## MIDI

- MIDI is switched on in Setup ("Enable Web MIDI"); only then does the browser ask for MIDI access. A venue
  that already used MIDI pedals before this switch existed keeps them working after an upgrade.
- Any MIDI input through Web MIDI, including SysEx-less devices. Notes, CC and Program Change
  messages trigger actions. Supports both static thresholds and dynamic parameter sourcing (ProPresenter
  velocity-indexed triggers for slide, item and section selection from DAWs like Ableton Live and MultiTracks Playback).
- Learn: in the mapping editor, choose an action, press Learn, send the control; the
  mapping is captured. Mappings store the device name so several devices can coexist.
- Presets: default mappings for common foot switches (note numbers 60 and 62 for Next and Previous)
  and 1-click ProPresenter 7 standard layout (notes 0..30 with velocity parameterization).
- MIDI output (show control): slides support attached communication cues (Note On/Off, CC, Program Change)
  with target device selection and delay offsets to trigger lighting desks, video switchers and audio consoles
  when slides go live.

## Action set

A single action vocabulary is shared by keyboard, Stream Deck, MIDI and the HTTP API
([design/19](../design/19-control-surfaces.md)). Every operator action in
[prd/02](02-operator.md) is an action.

## Acceptance

- A foot switch advances slides with the operator window unfocused.
- The Stream Deck XL shows the live section highlighted within 100 ms of a GO.
