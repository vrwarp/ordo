/*
 * Parts of a slide drawn after it was shown (design/14 "Late units"; owner decision 2026-11-13, "fill in when
 * ready with a fade"): a GO never waits for drawing. A slide whose units are not ready is shown at once with
 * their legacy copies; the asset worker makes them in a late job and says when (`unitsReady`), and the link
 * draws the slide again, which fades in on the screen over `REFRESH_FADE_MS`. Shared by the link and the asset
 * worker (and, from sub-wave 3, by the outputs' late pictures).
 */

/** How a late part appears: 'fade' (the owner's choice) on the screen at once; 'next' at the slide's next draw. */
export type LateUnitMode = 'fade' | 'next';

/** The default; `?late=next` on an output's URL picks 'next' (venue troubleshooting, `switches.ts`). */
export const LATE_UNIT: LateUnitMode = 'fade';

/** A late part fades in over this long (ms), and a slide is drawn again for its late parts at most this often. */
export const REFRESH_FADE_MS = 300;
/**
 * A slide whose re-draw for late parts took longer than this (one task at the output's size; the re-draw's own
 * `rasterMs`, not the slide's first, cold draw) is drawn again on screen only once more, when its late job has
 * made its last part or ended (`unitsReady.ended`): each such re-draw is one slice of the asset worker, and a jump
 * arriving meanwhile waits for it. Every part still fades in (owner decision 2026-11-13); those made before the
 * last wait for it, at most `LATE_HOLD_MS` after the late job's last report (reviews of r2b sub-wave 1).
 */
export const LATE_REDRAW_MAX_MS = 50;

/**
 * A slow slide's re-draw waits for its late job's last part at most this long after the job's last report
 * (ms): a late job that stops reporting (lost, or a fault) never keeps a made part off the screen (repair 3).
 * A working late job reports at most every `REFRESH_FADE_MS` while it makes parts.
 */
export const LATE_HOLD_MS = 1_000;
