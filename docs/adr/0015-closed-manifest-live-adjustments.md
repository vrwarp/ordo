# ADR 0015: Closed-manifest live adjustments

Amends [ADR 0007](0007-service-cache.md).

## Context

Booth volunteers follow the service checklist on arrival (45–60 minutes before the service): they press **Go live** early so the service cache reaches 100%, run soundcheck and rehearsal, and put up a prayer slide or welcome loop. During that window—and occasionally during the service itself—the band finalizes song section orders, drops a song, skips specific slides in a sermon deck, or catches a lyric typo.

Under ADR 0007's hard lock, any adjustment required pressing **End service** (which clears every projector to black) and going live again.

## Decision

Keep the **Closed-Manifest Invariant**: `goLive` closes the set of media files, presentations, and fonts (`manifestId`). Adding brand-new items, presentations, media, or fonts still requires **End service** and **Go live** again (fast because OPFS and Cache API are content-addressed).

Inside that closed asset set, the booth operator (`role === 'operate'`) may apply four deterministic `LiveEvent` adjustments through the hub-authoritative shared reducer (ADR 0006):

1. **`item.skip`**: toggle `PlaylistItem.skipped` on any off-air item. `next`, `prev`, `nextItem`, `prevItem`, and `media.ended (advance)` step over skipped items; an explicit `go` into a skipped item automatically clears `skipped`.
2. **`item.arrange`**: set or clear `PlaylistItem.sections` (per-service section order) on any presentation item that is not currently active (`live`, `layers.slide`, `layers.media`, or `audio`). Re-expands cues and remaps active cue indices by offset delta; re-arms the next shown cue.
3. **`item.hideSlides`**: set `PlaylistItem.hiddenSlides` (per-service skipped slides) on any presentation item. Marks those slide cues `hidden: true` without mutating the presentation.
4. **`slide.editText`**: text-only hotfix on an off-air native text slide (refused for currently on-air slides and whole-slide pre-rendered pictures). Re-rasterizes locally using already-locked fonts (ADR 0004).

All four adjustments:
- Introduce zero new file hashes or fonts, preserving 100% hub-down and WAN-down survival (design/17) and zero 60 Hz frame-drop risk on outputs.
- Are persisted silently to the playlist/presentation record so **End service** remains a single confirmation click with no post-service library curation prompts.
- Remain read-only on remote/edit-only devices (`role === 'edit'` and capped phone sessions) while the service is live (single writer).

## Consequences

- `PlaylistItem` gains optional `sections`, `hiddenSlides`, and `skipped` fields (also aligning with design/28 §3.5).
- `APP_VERSION` bumps to `0.12.0` so every connected window runs the updated reducer and cue expansion.
- `LiveService` journals these small events and snapshots the updated `resolved` copy as needed; `End service` stays a single click.
