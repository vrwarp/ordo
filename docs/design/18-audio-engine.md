# Design 18: Audio engine

`packages/audio`. Runs in the audio-master output window (output 1 by default), because
the video element whose audio is routed lives there and A/V sync must hold. A second,
small instance runs in the operator for preview.

## Graph

```
MediaElementSource (video of the live cue) ──┐
MediaElementSource (audio cue) ──────────────┤
                                             ▼
                        per-source GainNode (item gain + loudness)
                                             ▼
                        pair router: connects the source's L and R to the
                        two ChannelMergerNode inputs of the chosen pair
                                             ▼
                        ChannelMergerNode (N inputs = house device channel count)
                                             ▼
                        master GainNode ──► AnalyserNode per pair (meters)
                                             ▼
                        AudioContext.destination
                        (context created with { sinkId: houseDeviceId, latencyHint: 'playback' })
```

- `AudioContext` with `sinkId` option (Chrome 110+) selects the house device directly;
  `setSinkId` handles a later change.
- `destination.channelCount` is set to the device's `maxChannelCount`,
  `channelCountMode = 'explicit'`, `channelInterpretation = 'discrete'`, so merger inputs
  map 1:1 to physical channels.
- A source's pair is two merger inputs; changing a pair reconnects the source's gain
  node to two other inputs with a 20 ms ramp to avoid clicks.
- Device enumeration (`enumerateDevices` after a `getUserMedia({ audio })` grant for
  labels) populates the settings page with names and channel counts.

## Sources

- Video cue: the same `<video>` the renderer displays, muted at the element level on
  non-master outputs only. On the master, `createMediaElementSource(video)` once per
  element (elements are reused per slot: live and armed).
- Audio cue: `<audio>` element from the OPFS blob through `createMediaElementSource`,
  with loop and the item's gain. Decoded ahead on arm like video.
- Gain staging: item gain (dB) plus loudness normalisation to −16 LUFS from the hub's
  measurement, plus master.

## Preview

The operator app creates its own `AudioContext` with the preview device's `sinkId` and
plays the item's delivery file from the Cache API. It never uses the house device.

## Fades

Clear-all and End service ramp the master gain to 0 over 500 ms with
`linearRampToValueAtTime`, then stop sources, then restore the gain.

## Device loss

`AudioContext.onsinkchange` and `devicechange` events; if the house device disappears
the engine marks `audio: lost` in health and polls enumeration every 2 s; on return it
calls `setSinkId` again and resumes. The video keeps playing visually throughout.

## Meters

`AnalyserNode` per pair, read at 20 Hz in the master output and sent in `health` as
peak values; the operator draws them.
