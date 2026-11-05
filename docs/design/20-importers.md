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
  mixed runs collapse to the first run's style with a log line. Bytes are read as UTF-8 when
  they are valid UTF-8 (some writers put it straight in), else as Latin-1. `\'hh` escapes are
  in the current font's `\fcharsetN` (136 Big5, 134 GBK, 128 Shift-JIS, 129 Korean, 204
  Cyrillic…) or else the document's `\ansicpgN`, default Windows-1252; a run of escapes is
  decoded together, so double-byte characters survive. ProPresenter on a Mac writes Chinese
  this way under a PingFang font with `\fcharset136`. Font size and alignment come from the
  RTF only when it states them (`\fsN`, `\qX`), else from the attributes.
- What ProPresenter actually writes (learnt from its own exports; the files are under
  `packages/importers/test-fixtures/pro7/`, checked by `pro7.real.test.ts`):
  - A media action's kind comes from the element (`image`/`video`/`audio` properties), not
    from the action's playback block: ProPresenter writes an empty `audio` block on
    picture actions.
  - Every document carries an empty chord-chart URL and every text box a visibility link;
    neither is reported.
  - ALL CAPS is kept as `TextStyle.transform: 'uppercase'`; the words keep their casing.
    The stroke width in the attributes (`-3`) and in the RTF (`\strokewidth-60`) are the
    same percentage of the font size. A gradient box fill becomes its first stop.
  - Media URLs are tried as the exporting Mac's absolute path, then `local.path` (what
    ProPresenter itself resolves by), then a relative path; a bare file name that several
    entries share is taken only when one sits next to the document, else left unlinked.
  - Playlist items carry `arrangement_name` (field 5, added to the vendored proto); the
    arrangement is found by UUID, else by name. Headers are logged by name (ordo has no
    divider item yet), hidden items are skipped, a missing document is a warning.
  - A document's ordo id is `pro7-<uuid>`, so importing the library again updates the
    earlier copy. A copy with the same UUID but other content gets a numbered suffix.
  - Slides of another size are scaled uniformly and centred on the 1920x1080 canvas.
  - Group names in German, Spanish, French and Portuguese (Strophe, Refrain, Coro,
    Couplet…) are recognised as song sections; unknown names get a two-letter short form.
  - `.probundle` and `.proplaylist` files are zips: expanded when nested in an upload and
    when found in a NAS folder. Entry names that are absolute paths (ProPresenter's own
    bundle exports) are made relative.
  - Its exports are Zip64 throughout, and the central directory size it declares counts
    its own Zip64 end records (98 bytes too many). `unzip` copes, JSZip refuses: `readZip`
    corrects the size in a copy when the directory actually there proves it (the hub's
    streaming reader never trusted that field).
  - A slide's elements are listed front to back (the first is on top); ordo draws back to
    front, so the order is reversed.
  - A slide's own background colour is part of the slide, above the background media: a
    running background picture or video is hidden behind it. It becomes a full-slide
    rectangle under the slide's objects.
  - A text element's box fill fills the whole box (ordo's text fill hugs the words): it
    becomes a rectangle behind the text.
  - Cocoa writes every line as a paragraph with `\saN` space after it, and line spacing as
    `\slN\slmult1`: both go into the line height (ordo has one; logged as approximated).
  - A picture is an element whose fill is media, and it carries an (empty) text block like
    every element: the picture is kept, its text only when it has words.
  - Background media runs from the slide that starts it until a slide clears it (a clear
    action on the background or every layer, or a clear group named "Clear All", for
    background or media) or starts another, in the document's slide order. Each slide gets
    the background it would show; one background on every slide becomes the presentation's.
    A slide that stops a running background gets `clearBackground`, which clears the
    output's background layer when it is shown.
- Not carried (logged per document): slide labels, cue hot keys, group colours, builds,
  per-slide transitions, macros, timers, linked text (imported as last saved), text-box
  borders, small caps and title case, per-side margins (the largest is used on all sides).
- Schema: the vendored protos are the community `proto/` set (ProPresenter 7.x). A raw
  scan of real 7.x and 21.x files found only cosmetic fields it lacks (ligature style, an
  image alpha-type flag); `autogen-proto/` in the same repository tracks ProPresenter 21.4
  and is the set to move to when a file shows fields that matter.
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
