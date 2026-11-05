# ordo documentation

ordo is a browser-native live presentation system for venues: lyrics, slides, media and
stage displays, run entirely in Google Chrome from a URL, with a small hub service on the
venue LAN. This folder holds the product requirements, the technical design and the
decision log for the first prototype, which must run a real Sunday service operated by a
volunteer alone.

The product vision and the rendering principles that this suite elaborates are in the
founding document
[Browser-native live presentation system: product vision and rendering architecture](https://claude.ai/artifact/FpG37PNypi2Dy4qXweMhhi).
Where this suite and that document differ, this suite wins; each deviation is recorded in
an ADR.

## How to read this

1. Start with [prd/01-overview.md](prd/01-overview.md): goals, the venue, the users, what
   "done" means, and what is out of scope.
2. Read the remaining PRDs for the behaviour of each surface.
3. Read [design/10-architecture.md](design/10-architecture.md) for the system shape, then
   the design documents for each component.
4. [milestones.md](milestones.md) turns the above into three rehearsal-gated milestones
   with task lists sized for Claude Code sessions.
5. [adr/](adr/) records every decision that constrains implementation, with its reasons.

## Documents

### Product requirements

| Doc                                                                      | Covers                                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [prd/01-overview.md](prd/01-overview.md)                                 | Goals, venue, users, success criteria, scope                                        |
| [prd/02-operator.md](prd/02-operator.md)                                 | Operator view: playlists, going live, GO, clear, timers, messages, health           |
| [prd/03-editor.md](prd/03-editor.md)                                     | Presentation editor: slides, text boxes, images, shapes, sections, arrangements     |
| [prd/04-outputs-and-looks.md](prd/04-outputs-and-looks.md)               | Audience screens, lobby and overflow, stream output, stage display, looks           |
| [prd/05-library-media-import.md](prd/05-library-media-import.md)         | Library, media, transcoding, fonts, ProPresenter 7, SongSelect, PPTX and PDF import |
| [prd/06-audio.md](prd/06-audio.md)                                       | Multichannel audio routing, video audio, audio cues, operator preview               |
| [prd/07-control-surfaces.md](prd/07-control-surfaces.md)                 | Keyboard, Stream Deck, MIDI with learn                                              |
| [prd/08-reliability.md](prd/08-reliability.md)                           | Zero dropped frames, offline continuation, health, recovery, ProPresenter fallback  |
| [prd/09-security-and-remote-prep.md](prd/09-security-and-remote-prep.md) | Public exposure, PINs, output tokens, editing from home, live lock                  |

### Technical design

| Doc                                                                    | Covers                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [design/10-architecture.md](design/10-architecture.md)                 | Process topology, origins, apps and packages, data flow                          |
| [design/11-domain-model.md](design/11-domain-model.md)                 | Entities, schemas, identifiers, versioning                                       |
| [design/12-hub.md](design/12-hub.md)                                   | Hub service: HTTP API, WebSocket, SQLite, media pipeline, backups                |
| [design/13-protocol.md](design/13-protocol.md)                         | Wire protocol: live state, arm/armed/GO, time sync, health, fallback bus         |
| [design/14-output-renderer.md](design/14-output-renderer.md)           | WebGPU compositor, workers, pre-roll, text rasterization, video, key colour      |
| [design/15-operator-app.md](design/15-operator-app.md)                 | React operator app, local-first state, keyboard, program view, launching outputs |
| [design/16-stage-display.md](design/16-stage-display.md)               | Stage display app                                                                |
| [design/17-offline-and-degraded.md](design/17-offline-and-degraded.md) | Service cache, WAN loss, hub loss, postMessage fallback bus                      |
| [design/18-audio-engine.md](design/18-audio-engine.md)                 | Web Audio graph, sinks, channel matrix, preview                                  |
| [design/19-control-surfaces.md](design/19-control-surfaces.md)         | WebHID Stream Deck, Web MIDI, action map, learn                                  |
| [design/20-importers.md](design/20-importers.md)                       | ProPresenter 7, SongSelect files, PPTX and PDF, Google Fonts                     |
| [design/21-security.md](design/21-security.md)                         | Auth model, sessions, rate limiting, tokens, headers                             |
| [design/22-deployment.md](design/22-deployment.md)                     | Docker Hub images, Compose on Synology, DSM reverse proxy, hostnames, PC setup   |
| [design/23-testing.md](design/23-testing.md)                           | Vitest, Playwright multi-origin, chaos tests, fuzzing, soak test, CI             |
| [design/24-repo-conventions.md](design/24-repo-conventions.md)         | Monorepo layout, tooling, coding rules, how Claude Code sessions should work     |

### Decisions and plan

| Doc                                                                          | Covers                                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [adr/](adr/)                                                                 | Architecture decision records                                                                                        |
| [milestones.md](milestones.md)                                               | M1, M2, M3 with rehearsal gates and task breakdown                                                                   |
| [review-2026-11-03.md](review-2026-11-03.md)                                 | Independent review of the implementation: what to fix before the first service, what to investigate on real hardware |
| [review-2026-11-04.md](review-2026-11-04.md)                                 | Independent review of the hardening pass: four high findings on the audience path, chaos coverage, what held         |
| [review-2026-11-04-ipad.md](review-2026-11-04-ipad.md)                       | Review of the iPad edit build: the trackpad profile hole, the stage next-slide order, keyboard and menu fixes        |
| [review-2026-11-05-pro7.md](review-2026-11-05-pro7.md)                       | The ProPresenter importer against files ProPresenter wrote: dropped pictures, wrong playlist links, 20 fixes         |
| [design/25-isolation-and-hardening.md](design/25-isolation-and-hardening.md) | Worker isolation, supervision, validation and quarantine; phased plan                                                |

## Glossary

The volunteer-facing vocabulary follows ProPresenter so operators need no retraining.
Internal code uses the same names.

| Term            | Meaning                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Library         | All presentations, media, fonts and themes stored on the hub                                                         |
| Presentation    | A song, sermon deck, announcement deck, or other ordered set of slides                                               |
| Slide           | One screen of content: text boxes, images, shapes, and an optional background                                        |
| Section         | A labelled group of slides within a presentation (Verse 1, Chorus, Bridge)                                           |
| Arrangement     | An ordering of a presentation's sections used in one playlist without editing the presentation                       |
| Playlist        | The ordered list of presentations and media for one service                                                          |
| Live playlist   | The playlist currently driving outputs; locked for editing                                                           |
| Cue             | One playlist position the operator can go to: a slide, a media item, a timer, or an action                           |
| GO              | Make the armed cue live on every output at the same frame                                                            |
| Arm             | Prepare a cue on every output ahead of GO so GO is instant                                                           |
| Layer           | An independently clearable band of content on an output: background, slide, lower third, props, media                |
| Look            | A per-output mapping of layers to visibility and styling: main, lobby, stream, stage                                 |
| Output          | One fullscreen window on one display, running the renderer with one look                                             |
| Audience screen | An output facing the congregation                                                                                    |
| Stage screen    | The confidence monitor for band and speakers                                                                         |
| Props           | Persistent overlays such as a logo or a timer, cleared separately from slides                                        |
| Hub             | The Node service on the venue NAS that holds the library and the live state                                          |
| Service cache   | Every asset the live playlist needs, held on the presentation PC so the service continues without the WAN or the hub |
