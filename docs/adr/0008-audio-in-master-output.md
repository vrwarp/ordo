# ADR 0008: Audio engine in the audio-master output

## Decision

One output window (output 1 by default) is the audio master. It routes its live video
element and audio cues through a Web Audio graph to the house device with a channel
matrix. Other outputs mute their video copies. Operator preview uses a separate context
on a separate device in the operator window.

## Reasons

- A/V sync is guaranteed because picture and sound come from the same decoded element.
- Outputs are the protected, isolated processes; audio belongs with them, not with the
  operator UI that may reload.

## Consequences

- If the master output is relaunched, audio restarts with it (video restarts too, so this
  is consistent).
- `media.ended` is reported by the master only.
