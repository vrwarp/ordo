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
 * A slide whose own draw took longer than this (one task at the output's size) is not drawn again on screen
 * for its late parts: that draw is one slice of the asset worker, and a GO arriving meanwhile would wait for it.
 * Its parts are drawn in when it is armed again (silently), or at its next draw (review of r2b sub-wave 1).
 */
export const LATE_REDRAW_MAX_MS = 50;
