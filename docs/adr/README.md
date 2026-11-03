# Architecture decision records

One file per decision. Status is Accepted unless noted. A new decision that changes an
earlier one supersedes it and says so.

| ADR                                              | Decision                                                                                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-stack.md)                            | TypeScript monorepo: React operator, Node hub, WebGPU-only renderer                                                                                                        |
| [0002](0002-tls-dsm-reverse-proxy.md)            | TLS terminated by Synology DSM reverse proxy with a DSM-issued wildcard certificate                                                                                        |
| [0003](0003-origin-isolation-with-opener.md)     | Per-role origins with origin-keyed agent clusters; keep the opener for a postMessage fallback bus                                                                          |
| [0004](0004-text-rasterized-at-arm.md)           | Text rasterized at arm time and composited in WebGPU, not a DOM layer                                                                                                      |
| [0005](0005-video-element-first.md)              | Video through `<video>` and requestVideoFrameCallback for the prototype; WebCodecs deferred                                                                                |
| [0006](0006-hub-authoritative-shared-reducer.md) | Hub-authoritative live state with one shared pure reducer and optimistic operator                                                                                          |
| [0007](0007-service-cache.md)                    | Service cache filled on go-live; editing locked while live                                                                                                                 |
| [0008](0008-audio-in-master-output.md)           | Audio engine runs in the audio-master output window                                                                                                                        |
| [0009](0009-delivery-codec-h264.md)              | One delivery format per media kind: H.264 MP4, VP9 alpha WebM, AAC                                                                                                         |
| [0010](0010-security-public-hub.md)              | Public hub with two PINs, output tokens, rate limiting                                                                                                                     |
| [0011](0011-looks-not-per-output-slides.md)      | Looks map one cue to many renderings; no per-output authoring                                                                                                              |
| [0012](0012-import-strategy.md)                  | ProPresenter 7 via vendored proto; SongSelect via files; PPTX via LibreOffice render plus XML text extraction                                                              |
| [0013](0013-implementation-adjustments.md)       | Adjustments made while implementing: API on every host, health outside the reducer, *.localhost origins, fullscreen popups, full-frame slide bitmaps, Canvas 2D safety net |
| [0014](0014-supervised-isolation.md) | Supervised isolation: main threads host only, workers with supervisors and heartbeats, MessagePort fallback bus, strict validation and quarantine, two hub processes |
