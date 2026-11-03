# Design 16: Stage display

`apps/stage`: React, DOM and CSS only, served from `stage.<venue>.synology.me`, opened by
the operator on the stage screen (token in URL like an output). No WebGPU, no media.

## Content

| Region | Content |
| --- | --- |
| Top left | Clock, 24 h or 12 h per settings, updated every second |
| Top right | Elapsed timer when running (label and `mm:ss`), countdown to service when active |
| Centre | Current slide lyric text, large, with the section label; next slide text below at 60 % size and reduced opacity. Non-song slides show their first text box or the presentation title |
| Bottom | Operator message, high contrast, with a 1 s fade in and out; multiple messages stack newest first |

Layout values come from the Stage look's `PropsRule.style` boxes so the operator can
adjust sizes without code. Fonts load from the service cache through the Cache API.

## Behaviour

- Applies `live.delta` with the shared reducer; renders from `LiveState`.
- Flips at `at` using the same clock offset as outputs, with `setTimeout` to the
  scheduled time; a one-frame error is acceptable on the stage screen.
- Reports `health` with `presented` and `missed` derived from rAF, so the operator sees
  the stage screen as a dot too.
- Holds a Wake Lock, hides the cursor, fullscreen on its assigned screen.
- Works over the fallback bus like an output.
