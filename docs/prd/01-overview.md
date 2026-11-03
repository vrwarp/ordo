# PRD 01: Overview, goals and scope

## Purpose

Build a prototype of ordo that runs a regular Sunday service at the author's church,
operated by a volunteer alone, with ProPresenter installed on the same PC as a hot
fallback. Quality gates delivery; there is no calendar deadline. Each milestone ends with a
measured rehearsal (see [milestones.md](../milestones.md)).

## The venue

| Item | Value |
| --- | --- |
| Presentation computer | Windows PC running Google Chrome, all displays on its graphics outputs |
| Audience screens | Two or more, identical content, 1920x1080 at 60 Hz |
| Stage screen | One, facing band and speakers |
| Lobby and overflow screens | One or more, lower-third look, 1920x1080 at 60 Hz |
| Livestream | OBS captures a dedicated output window showing lower-third lyrics on a key colour |
| Audio | A multichannel USB interface on the PC into the house mixer; model not yet chosen |
| Hub | Docker container on the venue's Synology NAS |
| Domain | An existing Synology DDNS name (`<venue>.synology.me`), wildcard certificate issued by DSM, TLS terminated by DSM's reverse proxy |
| Internet | Normally available; the service must continue if it drops mid-service |
| Control surfaces | Elgato Stream Deck (XL, Mini or Plus) and MIDI from a lighting console or foot switch |
| Existing content | A ProPresenter 7 library |

## Users

| User | Needs from the prototype |
| --- | --- |
| Volunteer operator, alone | Open Chrome, launch outputs with one click, run the service with Space and arrows or a Stream Deck, clear text between songs, send messages and timers to the stage, recover from any fault without touching the OS, and switch to ProPresenter as a last resort |
| Worship lead, from home | Sign in through the public hostname with the edit PIN, build next Sunday's playlist, import SongSelect files, pick arrangements, place backgrounds |
| Speaker or sermon author | Drop a PPTX or PDF into the library and have it appear as image slides, optionally editable |
| Band and speakers | Stage screen with current and next lyrics, a clock, elapsed and countdown timers, and operator messages |
| Stream and lobby viewers | Lyrics as a lower third over camera video or a holding slide |
| Developer (the author, with Claude Code) | Documents precise enough to implement task by task, tests that prove the frame budget, a Docker image pushed from GitHub |

## Goals

1. Zero dropped frames on every output during a full rehearsal, measured by the outputs'
   own telemetry, before the first live service.
2. GO latency: a keypress or Stream Deck press changes every output within two frames of
   each other and within 50 ms of the press when the cue is armed.
3. The service continues if the WAN drops, and continues if the hub drops, from the
   moment the playlist is made live.
4. A volunteer can run a service from a one-page checklist with no developer present.
5. Everything a ProPresenter operator does weekly at this venue (lyrics, backgrounds,
   sermon slides, videos, lower thirds, stage messages) has an equivalent.

## Non-goals for the prototype

- Broadcast SDI, NDI, Syphon, Spout, Art-Net or sACN from the browser.
- Planning Center and Bible API integration (scripture data model is designed, lookup is a later milestone).
- Per-object build animations.
- Phone or tablet remote control.
- Outputs on machines other than the presentation PC (the design allows it; it is not exercised).
- Multi-tenant or cloud-hosted hub.
- Right-to-left text and auto-shrink (the editor leaves room for them).

## Success criteria for the first live service

| Criterion | Measure |
| --- | --- |
| No visible glitch on audience screens | Output telemetry reports zero missed vsync and zero long tasks over the whole service |
| Operator never waited on the UI | No operator action took more than 100 ms to reflect locally |
| No fallback used | ProPresenter was not opened |
| Volunteer confidence | Operator reports they would run the next service on ordo |

## Constraints and assumptions

- Chrome stable, current version, on Windows 11. WebGPU must be available on the PC's GPU
  (verified in M1 setup; see [design/22-deployment.md](../design/22-deployment.md)).
- Chrome policies on the presentation PC are managed by the venue (auto-update paused
  around services, restore-pages prompt suppressed).
- Synology DDNS resolves `*.<venue>.synology.me` and DSM issues a wildcard certificate
  for it. This is verified as the first task of M1; the fallback if it does not is in
  [design/22-deployment.md](../design/22-deployment.md).
- The hub is reachable on the public hostname from anywhere, so the security model in
  [prd/09](09-security-and-remote-prep.md) is mandatory from M1.

## Terminology

See the glossary in [docs/README.md](../README.md).
