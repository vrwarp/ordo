# PRD 02: Operator view

The operator view is the screen the volunteer runs the service from. It lives on the
operator's monitor; the outputs are separate windows on the other displays.

## Layout

| Region       | Content                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Top bar      | Live playlist name, hub connection state, WAN state, service cache state, per-output health dots, clock, Launch outputs button                                     |
| Left column  | The live playlist: presentations and media in order, the live item highlighted                                                                                     |
| Centre       | Slides of the selected presentation, grouped by section, following the active arrangement; the live slide outlined, the armed slide marked                         |
| Right column | Program view: a live thumbnail of each output; below it stage tools: messages and timers                                                                           |
| Bottom bar   | Layer state chips (Background, Slide, Lower third, Props, Media) each showing live content and a clear button; audio meters and the playing media's remaining time |

The operator view never renders with WebGPU. Slide thumbnails are CSS renders of slide
data at small sizes. Program thumbnails are video streamed from the outputs
([design/15](../design/15-operator-app.md)).

## Playlists

- A playlist is an ordered list of items: presentation (with a chosen arrangement),
  media item (video, image, audio), timer item, or action item (clear, logo).
- Playlists are built in the operator view or from home. Drag to reorder, insert from
  the library search, remove.
- "Go live" on a playlist makes it the live playlist: the hub freezes it, builds the
  service cache manifest, and every connected output and the operator prefetch it. The
  top bar shows caching progress and turns green at 100 %. Editing the playlist and any
  presentation it references is locked until "End service".
- Only one playlist is live at a time. "End service" releases the lock and clears all layers.

## Navigation and GO

| Action                | Default keys                                              | Behaviour                                                                                                           |
| --------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Next slide            | Space, Right, Down                                        | Arms and goes to the next slide in arrangement order; at the end of a presentation, moves to the next playlist item |
| Previous slide        | Left, Up                                                  | Previous slide in arrangement order                                                                                 |
| Go to slide           | Click, or 1 to 9 for the Nth slide of the current section | Jumps anywhere; if the target is not armed, holds the current slide until armed                                     |
| Next presentation     | Page Down                                                 | First slide of the next item                                                                                        |
| Previous presentation | Page Up                                                   | First slide of the previous item                                                                                    |
| Section jump          | Click a section label                                     | First slide of that section                                                                                         |
| Clear slide           | F1                                                        | Clears the Slide layer; background keeps playing                                                                    |
| Clear all to black    | F2 (press twice within 2 s, or hold)                      | Every layer black on every output. Confirmed by the double press to avoid accidents                                 |
| Clear lower third     | F3                                                        | Clears the Lower third layer only                                                                                   |
| Clear props           | F4                                                        | Clears Props                                                                                                        |
| Logo                  | F5                                                        | Shows the venue logo look on audience outputs                                                                       |
| Play or pause media   | F8                                                        | For the live media item                                                                                             |
| Restart media         | Shift+F8                                                  |                                                                                                                     |
| Launch outputs        | Ctrl+Shift+L                                              | See Outputs                                                                                                         |

Keys are handled on keydown with no debounce. Keys act only when the operator window is
focused; Stream Deck and MIDI act regardless of focus ([prd/07](07-control-surfaces.md)).

### Arming

- Selecting a slide (highlight without GO) arms it on every output. The slide shows a
  per-output dot: grey (not armed), amber (arming), green (armed), red (failed).
- GO on an armed slide is a pointer flip at a hub-scheduled frame; every output switches
  on the same vsync.
- GO on a slide that is not yet armed holds the current content until all outputs report
  armed, then goes. The operator sees the amber state during the wait. Typical wait is
  under 200 ms from the service cache.
- The next slide in arrangement order is pre-armed automatically after every GO, so
  Space is always instant.

### Media items

- A video item goes live on GO, plays once or loops per its setting, and reports remaining
  time to the operator. At the end of a non-looping video the output holds the last frame
  until the next GO (configurable: hold, black, or advance).
- An image item behaves like a one-slide presentation.
- An audio item plays through the audio engine with no visual change
  ([prd/06](06-audio.md)).
- Backgrounds attached to a presentation are on the Background layer and persist across
  slides of that presentation; they change only when the next presentation has a different
  background or the operator clears them.

## Layers

Each output composites five layers in this order from back to front: Background, Slide,
Lower third, Media, Props. The operator can clear each independently. What each look does
with each layer is in [prd/04](04-outputs-and-looks.md).

## Stage tools

- Message: a text field and Send; the message appears on the stage screen until Dismiss
  or an optional timeout (30 s, 1 min, 5 min). Last five messages are reusable with one click.
- Timers: a countdown to a time of day (service start), and an elapsed timer started by
  the operator or automatically by a playlist timer item (for example when the sermon
  presentation goes live). Timers appear on the stage screen and, for the countdown to
  service start, on the audience and lobby looks when a countdown cue is live.
- Clock: always on the stage screen.

## Health and recovery

- Each output reports once per second: connected, armed cue, live cue, frames presented,
  frames missed, long tasks, cache state, GPU device lost. The top bar shows one dot per
  output; hovering shows the numbers.
- "Relaunch outputs" (button and Ctrl+Shift+R) closes and reopens every output window
  on its remembered screen and re-arms the live and next cues. Outputs hold their last
  good frame while being replaced where possible.
- Hub disconnected: the top bar turns amber, the operator keeps working from the service
  cache, and outputs follow the operator through the fallback bus
  ([prd/08](08-reliability.md)). Reconnect is automatic and silent.

## Program view

A live thumbnail per output, 10 frames per second, with the output's name and health. It
shows pixels from the output, not a reconstruction.

## Acceptance

- A volunteer with the one-page checklist runs a 90 minute rehearsal with no help.
- Every action above has a key, a Stream Deck action and a MIDI action.
- Space after GO is always instant because the next slide is pre-armed.
