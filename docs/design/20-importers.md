# Design 20: Importers

`packages/importers`, pure functions from input bytes to domain entities plus a log,
runnable in Node (hub jobs) and in the browser (for previews and tests).

## ProPresenter 7

- Format: Protocol Buffers. The `.pro` file is a `Presentation` message; playlists are in
  the library's `Playlists` files; the schema is published by the community
  (ProPresenter7-Proto). We vendor the `.proto` files under `packages/importers/proto/`
  and generate TypeScript with `protobufjs`. The proto version is pinned and recorded in
  the import log.
- Mapping:

| ProPresenter 7                                                                     | ordo                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Presentation.name`, `ccli`, `copyright`, `author`                                 | `title`, `meta`                                                                                                                                                             |
| `cue_groups` (group name) → cues                                                   | `Section` with the group label; each cue's slide → `Slide`                                                                                                                  |
| `Slide.elements` of type text: `rect` and `text` (RTF)                             | `TextObject`: box from `rect`; text, font family, size, colour, outline, shadow parsed from the RTF and from `attributes` where present. Unparsed RTF attributes are logged |
| `Slide.elements` of type image or video                                            | `ImageObject` or slide background; the media file is located by path relative to the import root and uploaded                                                               |
| `Presentation.background`                                                          | `backgroundMediaId`                                                                                                                                                         |
| `arrangements`                                                                     | `Arrangement[]`                                                                                                                                                             |
| Playlists referencing `.pro` by UUID                                               | `Playlist` items referencing imported presentations                                                                                                                         |
| Builds, transitions per slide, macros, timers, looks, stage layouts, audio routing | Skipped, logged                                                                                                                                                             |

- RTF: a small RTF reader extracts plain text and the first run's font, size and colour;
  mixed runs collapse to the first run's style with a log line.
- Import root: a zip uploaded from the operator app or a NAS path the hub can read. The
  log groups by presentation: imported, partially imported (with reasons), skipped.

## SongSelect files

- ChordPro (`.cho`, `.txt`): `{title:}`, `{artist:}`, `{ccli:}`, `{copyright:}` and
  `{comment:}` directives; section labels as `{c:Verse 1}` or bare lines like `Verse 1`
  or `[Chorus]`; chord brackets `[G]` are stripped from slide text and stored per line in
  `Section.chords` for a future chord view.
- Lyrics text export: title on the first line, sections introduced by a label line,
  blank lines between sections, a trailing block with CCLI number and copyright.
- Slide splitting: a section becomes slides by blank lines inside the section, else by
  the presentation's lines-per-slide setting (default 2).
- The same parser powers New song from paste.

## PPTX and PDF

Hub jobs ([design/12](12-hub.md)) render pages to PNG and create a `slides`
presentation with one image slide per page. For PPTX, `pptx-text` reads
`ppt/slides/slide<N>.xml` with `fast-xml-parser`: for each `p:sp` with a `p:txBody`,
collect `a:t` runs per paragraph and the `a:xfrm` offset and extent (EMU; 914400 EMU per
inch; slide size from `ppt/presentation.xml` `p:sldSz`) scaled to the 1920x1080 logical
canvas. Font size from `a:rPr sz` (hundredths of a point) scaled by the slide's height
ratio. Result is stored as `Slide.imported.textBoxes` and used by the editor's "make
editable" command. `PptxGenJS` is not used (it writes PPTX only).

## Google Fonts

The hub fetches `https://fonts.googleapis.com/css2?family=<family>:ital,wght@...` with a
desktop user agent to receive woff2 URLs, downloads each file, and stores a `Font` row per
weight and style with `source: 'google'`. The font picker queries the hub, which caches
the Google Fonts family list (`https://www.googleapis.com/webfonts/v1/webfonts` requires
an API key; without a key the hub ships a bundled family list refreshed at build time).

## Tests

Fixture files for each format live under `packages/importers/fixtures/` (small,
licence-free samples; venue content is never committed). Snapshot tests assert the
produced entities and logs.
