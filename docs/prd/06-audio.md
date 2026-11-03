# PRD 06: Audio

The venue uses a multichannel USB audio interface on the presentation PC into the house
mixer. The exact device is not chosen; the design treats any device Chrome enumerates as a
multichannel output.

## Sources

| Source                              | Routing                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| Video cue audio (stereo)            | Stereo pair chosen per media item, default pair from settings                                  |
| Audio cue (music bed, sound effect) | Stereo pair per item, loop and gain per item                                                   |
| Operator preview                    | Any source can be auditioned on a separate device chosen in settings, never on the house pairs |

Click tracks and stems are out of scope; the channel matrix does not preclude them.

## Routing

- Settings page: pick the house output device (any device from `enumerateDevices`,
  shown with channel count) and the preview device. Define named pairs (for example
  "House L/R" = channels 1 and 2, "Lobby" = 3 and 4). The default pair applies to new items.
- Each media item has an output pair and a gain (dB). A playlist item can override both.
- Master gain and mute in the operator bottom bar, with per-source meters.
- Fade out on clear-all-to-black and on End service, 500 ms.

## Behaviour

- Audio for a video plays from the same decoded media as the picture, so A/V stays in sync.
- Audio starts on GO with the first frame.
- Audio cues can play under slides; they are a layer-independent source with their own
  stop action.
- The operator can audition an item in the preview device by pressing Play in the library
  without affecting outputs.
- Audio device loss (USB unplugged): the engine reports it, the operator sees a red
  indicator, and audio resumes on the device when it returns without a relaunch.

## Acceptance

- A video's audio reaches the chosen house pair and no other channel, measured on the mixer.
- Preview audio never reaches the house pairs.
- Start of audio and first video frame are within 20 ms of each other.
