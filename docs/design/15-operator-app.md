# Design 15: Operator app

`apps/operator`: React 19, TypeScript, Vite, served from `op.<venue>.synology.me`. It
contains the operator view, the editor, settings and imports. It never creates a WebGPU
device.

## State

- `live`: the `LiveState` from `packages/live-state`, held in a store (Zustand) with an
  optimistic layer: local events apply immediately and are rebased on hub deltas.
- `library`: entities in IndexedDB (Dexie) with an in-memory index; updated by
  `library.delta` and by a snapshot on connect.
- `ui`: selection, panels, dialogs. Persisted to `localStorage` per device.
- `bus`: the connection abstraction with two implementations, `HubBus` (WebSocket) and
  `FallbackBus` (postMessage), selected by connection state ([design/17](17-offline-and-degraded.md)).

Every action in the UI dispatches an `Action` from `packages/surfaces`; actions map to
reducer events. Keyboard, Stream Deck and MIDI dispatch the same actions.

## Operator view components

| Component | Notes |
| --- | --- |
| `TopBar` | Connection, WAN, cache, output dots, clock, Launch and Relaunch |
| `PlaylistPane` | Virtualized list; drag to reorder when not live |
| `SlideGrid` | Sections as headed groups following the arrangement; thumbnails from the thumbnail worker; live and armed markers; click to select, double-click to GO |
| `ProgramView` | One `<video>` per output fed by WebRTC; health overlay |
| `StageTools` | Message box, recent messages, timers |
| `LayerBar` | Five chips with clear buttons; media transport and remaining time; audio meters |

Thumbnails: a worker runs the shared text rasterizer and a 2D compositor at 320x180,
cached by (slide rev, look). The main thread never rasterizes.

## Keyboard

A single `keydown` listener on `window` with the key map from settings. Handled keys call
`preventDefault`. Text inputs opt out by focus. GO-class actions are dispatched
synchronously inside the event handler so the local state updates before the next paint.

## Launching outputs

1. The operator clicks Launch outputs (a user gesture).
2. The app requests `window.getScreenDetails()` (Window Management API permission,
   remembered per origin). For each enabled output it finds the screen matching the saved
   `ScreenRef` by label, then by position; unmatched outputs open on the primary screen
   and show a placement dialog.
3. `window.open(outputUrl + '?token=…', 'ordo-out-' + k, 'popup,left=…,top=…,width=…,height=…')`
   with the screen's bounds. The handle is kept in the `FallbackBus`.
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
- Property panel bound to the selected object's schema.
- Saves via `PUT /presentations/:id` with `rev`; 409 shows the reload dialog.
- Disabled with a banner when the presentation is referenced by the live playlist.

## Settings

Outputs and looks, audio devices and pairs, key map, Stream Deck pages, MIDI mappings,
PINs, output tokens, backups, diagnostics export. Each page is a form over the matching
`/settings/*` resource.

## Service checklist

A printable page (`/checklist`) generated from the current settings: launch steps, health
colours, Relaunch, and the ProPresenter switch procedure.
