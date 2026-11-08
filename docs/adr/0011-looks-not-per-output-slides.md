# ADR 0011: Looks, not per-output slides

## Decision

One cue drives every output. Each output has a look that decides which layers are
visible and how the slide is rendered: as authored, or lyric-only with the look's own
style and band. Lower-third, stage and stream looks are configurations, not separate
content.

## Reasons

- The operator and the worship lead maintain one playlist.
- New looks (a second lobby style) are data changes.

## Consequences

- Non-song slides in lyric-only looks need a rule (show first text box or nothing),
  configured per look.
- The lyric box must be identified per slide (`lyricObjectId`), set by the parser and
  editable.
