# PRD 04: Outputs and looks

An output is one fullscreen Chrome window on one display, driven by one look. All outputs
at this venue run on the presentation PC. One cue drives every output; the look decides
what each output renders.

## Outputs at the venue

| Output | Display | Look | Notes |
| --- | --- | --- | --- |
| Audience 1 and 2 (and more) | Projectors or TVs, 1080p60 | Main | Identical content |
| Stage | TV facing the platform | Stage | Lyrics, clock, timers, messages |
| Lobby, Overflow | TVs in other rooms | Lower third | Lower-third lyrics over a holding slide or announcement loop |
| Stream | Captured by OBS (window capture) | Stream | Lower-third lyrics on a solid key colour, everything else transparent to OBS |

The stream output can be a window on a display OBS captures, or a window on the
operator's monitor that OBS captures by title. Window capture at 1080p60 is the supported
method; WebRTC push is out of scope.

## Looks

A look is a per-output configuration:

| Setting | Main | Stage | Lower third | Stream |
| --- | --- | --- | --- | --- |
| Background layer | Shown | Hidden | Hidden; a holding slide or the announcement loop instead | Hidden; key colour fill |
| Slide layer | Full slide as authored | Lyric text only, restyled: current slide large, next slide smaller below | Lyric text only, restyled into a band at the bottom | Same as lower third |
| Lower third layer | Shown if the operator sends one | Hidden | Shown | Shown |
| Media layer | Shown | Hidden, except video remaining time | Hidden by default, per-item option | Hidden |
| Props layer | Shown (logo, countdown to service) | Clock, timers, messages | Countdown to service | Hidden |
| Clear to black | Black | Black | Black | Key colour |
| Transition | Crossfade, duration per look (default 300 ms) | Cut | Crossfade | Crossfade |

- The Main look renders the slide as authored, every object.
- Lyric-only looks read the slide's lyric box text and typeset it with the look's own
  style (font, size, colour, outline, band geometry). Non-song slides in those looks show
  the slide's first text box, or nothing if the slide has no text (configurable per look:
  show text or show nothing for non-song slides).
- Key colour defaults to pure green (0, 255, 0); configurable per look so OBS chroma key
  settings are stable. Text in the stream look must not use the key colour; the editor
  warns.
- Looks are edited in the operator app's Outputs settings. Each output has a name, an
  assigned screen (remembered by the Window Management API's screen label and position),
  a look, and an enabled flag.
- Adding a look or output needs no code change; the renderer is data-driven.

## Transitions

Cut and crossfade, with a per-look default and a per-presentation override. Crossfade
interpolates between two fully resident layer stacks; no asset loads during the fade.
Backgrounds crossfade when they change between presentations.

## Props

- Logo: a stored image shown by the Logo action on the Main look.
- Countdown to service: shown as a styled timer on Main, Lower third and Stage looks when
  a countdown cue is live. Format `mm:ss`, with a configurable message under it.
- Message and elapsed timer: Stage look only.

## Output window behaviour

- Fullscreen on its assigned screen via `requestFullscreen({ screen })`, placed by the
  operator's Launch outputs action.
- Holds a Screen Wake Lock. Hides the cursor. Ignores keyboard input except a hidden
  Ctrl+Shift+Q to close.
- On any renderer error, holds the last presented frame and reports the error. On GPU
  device loss, rebuilds the device and re-arms; the last frame remains visible through a
  2D canvas copy kept for that purpose.
- Shows a plain diagnostic page only if it has never presented a frame.

## Acceptance

- All looks render the same cue within two frames of each other, verified by a
  Playwright test that captures each window and by the output telemetry.
- OBS chroma keys the stream window with default settings and no fringing on white text
  with a dark outline.
