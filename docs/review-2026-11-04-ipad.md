# Review: the iPad edit build (2026-11-04)

Scope: the three iPad commits (platform `db2abce`, touch `2c78206`, follow-ups `b163c74`). Three
independent reviewers read the diffs cold (hub and live summary; capability detection, workers, PWA
and tests; touch editing); every finding below was then verified in the code before it was fixed.
Clean areas are listed at the end so the reader knows what was looked at.

## Findings and resolution

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                              | Resolution                                                                                                                                                                                           |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | High     | **An iPad with a trackpad became a full operator.** `profileFor` returned `full` for any of Window Management, WebHID _or_ the Fullscreen API on a fine pointer. iPadOS Safari has the Fullscreen API and reports `pointer: fine` with `hover: hover` as soon as a Magic Keyboard or mouse is attached, so the worship lead's iPad would have shown the live view, GO, the keys and "Launch outputs" (opening tabs). | `full` now needs Window Management or WebHID, both Chromium-only. Firefox and desktop Safari become edit-only too, which matches "run services from the venue PC". Test added for the trackpad iPad. |
| 2   | Medium   | **The stage preview's "next slide" used authoring order.** The stage output takes the next slide from the cue list, which follows the arrangement (Verse 1, Chorus, Verse 2, Chorus…); the preview took the next slide in the editor's section order.                                                                                                                                                                | `slideAndNext` follows the presentation's first arrangement; documented that a playlist naming another arrangement is not known to the preview. Test added.                                          |
| 3   | Medium   | **The software-keyboard helper installed only for the first presentation opened.** `installKeepVisible` ran on `!!ed.draft`, but the store keeps the previous draft while the next loads, so on the second presentation the effect ran before the root existed and never again. Fields in the second presentation sank under the keyboard. The e2e test opens the editor fresh, so it could not catch this.          | The condition is now "this presentation's draft is in the store".                                                                                                                                    |
| 4   | Medium   | **Escape in an open Add or Arrange menu also deselected the object.** The menu closed on Escape without stopping propagation; the editor's window handler then cleared the selection, disabling Arrange and hiding the floating tools.                                                                                                                                                                               | The menu stops propagation and returns focus to its trigger button (the menu pattern expects it; focus used to fall to `body` when the items unmounted).                                             |
| 5   | Medium   | **`pnpm e2e` failed on any machine without WebKit installed.** The two iPad projects were unconditional; the only install instruction in the repo was CI's.                                                                                                                                                                                                                                                          | The projects exist only when WebKit's executable is present (`ORDO_E2E_WEBKIT=1` insists); a warning says they were skipped.                                                                         |
| 6   | Low      | The rotate handle was placed from the _unrotated_ box, so a wide box turned 90° near the right edge put the handle off the slide (the clipping the function exists to avoid).                                                                                                                                                                                                                                        | `rotaterAngle` now computes where Konva actually puts the handle in the rotated frame and picks the first candidate on the slide. Test added.                                                        |
| 7   | Low      | The thumbnail worker cached a failed image decode for ever (until 120 other images evicted it), leaving that background out of every thumbnail and preview after a transient Safari decode failure.                                                                                                                                                                                                                  | The cache entry is dropped on failure so the next job retries.                                                                                                                                       |
| 8   | Low      | `requestPersistentStorage` recorded "asked" before the answer, so a Safari tab that refused (it refuses without a prompt) was never asked again.                                                                                                                                                                                                                                                                     | The flag is written only on a grant.                                                                                                                                                                 |
| 9   | Low      | The Sortable comment and the e2e comment claimed a quick swipe on the grip scrolls the list; with `touch-action: none` on the grip it does nothing (a swipe elsewhere scrolls).                                                                                                                                                                                                                                      | Wording corrected; the behaviour is intended.                                                                                                                                                        |

## Noted, not changed

- **The library process can briefly accept a save the iPad shows as locked.** After a library-process
  restart its copy of the locks starts idle until the supervisor re-sends them. Pre-existing
  two-process design; the window is milliseconds and the edit is to a presentation the live process
  has already resolved, so the service is unaffected.
- **`keepVisible` re-reveals the field on every visual-viewport scroll.** With the keyboard up,
  iPadOS lets the user pan the visual viewport; each pan event scrolls the properties panel to keep the
  focused field in view, which can feel like a tug. No loop, listeners are cleaned up. Needs a real
  iPad to judge; the fix, if wanted, is to skip the reveal while a touch is down.
- **Stage and lower-third previews draw background and slide only, not the look's props layer**
  (clock, countdown, messages, logo). The band position is right; overlap with a clock cannot be judged
  from the preview.
- **Menus have no arrow-key navigation** (Tab and Escape work). Touch and mouse are the targets.
- **The touch e2e drags are synthesised pointer events.** Taps are real touch (the iPad device
  descriptors), but drags are dispatched `PointerEvent`s, so browser gesture arbitration (scroll versus
  drag, double-tap zoom, keyboard raising inside a gesture) is only proven on a real iPad.
- **Polling has no backoff** and keeps the last known "Live now" through a hub outage; the core's
  WebSocket ends the session on a 401. Acceptable at one request per 8 s.

## Looked at and found clean

- `/live/summary`: edit access only, strict schema, no tokens or state beyond the five fields; served by
  the live process in two-process mode and directly in one-process mode; the locked set equals the
  hub's own 423 check; the no-live state, the edit PIN, an output token and anonymous access are tested.
- The edit profile is enforced below the UI: the controller downgrades the role, `dispatch`/`call` are
  no-ops, the hub refuses `live.event` from an edit hello, outputs refuse to launch, the live and
  checklist routes redirect.
- Auth is an httpOnly cookie, so the installed (standalone) app needs one sign-in into its own cookie
  jar and then behaves as a tab; manifest, service-worker scope and CSP are consistent.
- Sortable: timers and window listeners are cleared on every end, cancel, Escape and unmount; a second
  finger is ignored; the mouse path and the keyboard buttons are unchanged on the desktop; the drop
  index maths matches the move semantics at both ends.
- The slide canvas resizes on orientation change; nudges, arrow keys, drags and transforms all commit
  through the same undo history; pinch is suppressed and the listeners removed on unmount.
- Per-test hub isolation in the iPad specs (own port, data directory wiped, children exit on
  disconnect).

## Verification after the fixes

Lint, typecheck, build and the unit suites pass. The Playwright run across Chromium and both WebKit
iPad projects is recorded in the commit that lands this file.
