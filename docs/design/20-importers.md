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

| ProPresenter 7                                                                     | ordo                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Presentation.name`, `ccli`, `copyright`, `author`                                 | `title` ("Untitled" falls back to the `.pro` filename stem), `meta`                                                                                        |
| `cue_groups` (group name) → cues                                                   | `Section` with the group label; each cue's slide → `Slide`                                                                                                 |
| `Slide.elements` of type text: `rect` and `text` (RTF)                             | `TextObject`: multi-run rich text (`runs`), per-paragraph styles (`paras`), `lineMask` overlays; empty-RTF boxes with fills/strokes route to `ShapeObject` |
| `Slide.elements` of type shape                                                     | `ShapeObject`: box, preset shapes, custom cubic bezier paths (`geom`), solid and gradient fills, strokes, shadows, soft edges                              |
| `Slide.elements` of type image or video                                            | `ImageObject` or slide background; path masks, crop insets, custom bounds, shadows, soft edges; media located relative to import root and uploaded         |
| `Presentation.background`                                                          | a backdrop shape on each slide without its own colour (`role: 'bg'`, below); media → `backgroundMediaId`                                                   |
| `arrangements`                                                                     | `Arrangement[]`                                                                                                                                            |
| Playlists referencing `.pro` by UUID                                               | `Playlist` items referencing imported presentations                                                                                                        |
| Builds, transitions per slide, macros, timers, looks, stage layouts, audio routing | Skipped, logged                                                                                                                                            |

- RTF & Typography: RTF bytes are read as UTF-8 when valid UTF-8, else Latin-1; `\'hh` escapes decode
  in the font's `\fcharsetN` (136 Big5, 134 GBK, 128 Shift-JIS, 129 Korean, 204 Cyrillic…) or the
  document's `\ansicpgN` (default Windows-1252), grouping multi-byte runs together. Multi-run RTF
  populates `TextObject.runs` for per-span font family, weight, italic, `sizeScale`, colour, highlight,
  underline, strike, superscript/subscript `baseline`, small caps, letter spacing, and stroke outline.
  Paragraph formatting populates `TextObject.paras` for per-paragraph alignment, indents,
  `spaceBeforePx`/`spaceAfterPx`, and `\listtext` / `textList` bullets. Cocoa `{\*\expandedcolortbl}`
  `\cssrgb` sRGB colours and `\caN` alpha override GenericRGB `\colortbl`. Cocoa `lineHeightMultiple`
  and `\slN\slmult1` line spacing scale by Ordo's `1.2` single-spacing unit plus `\slleading` inter-line
  leading. AppKit `NSTextContainer`'s `5pt` horizontal `lineFragmentPadding` and asymmetric per-side
  `margins` map to `TextStyle.insets` (collapsing to symmetric `padding` on plain middle-aligned text).
  Alignment defaults to `'left'` when omitted in proto3. `SCALE_BEHAVIOR_SCALE_FONT_DOWN` maps to
  `autofit: 'shrink'`.
- What ProPresenter actually writes (learnt from its own exports; the files are under
  `packages/importers/test-fixtures/pro7/`, checked by `pro7.real.test.ts`):
  - A media action's kind comes from the element (`image`/`video`/`audio` properties), not
    from the action's playback block: ProPresenter writes an empty `audio` block on
    picture actions.
  - Every document carries an empty chord-chart URL and every text box a visibility link;
    neither is reported.
  - ALL CAPS is kept as `TextStyle.transform: 'uppercase'`; the words keep their casing.
    The stroke width in the attributes (`-3`) and in the RTF (`\strokewidth-60`) are the
    same percentage of the font size.
  - Linear (`360 - angle` converting from ProPresenter's counter-clockwise degrees to Ordo's CSS
    clockwise degrees) and radial `Graphics.Gradient` fills are preserved on shapes, boxes, and line
    masks.
  - Non-rectangular `Path.shape` presets (`TYPE_ELLIPSE`, `TYPE_ROUNDED_RECTANGLE`, isosceles and right
    triangles, rhombus, single and double arrows, polygons, stars) and `TYPE_CUSTOM` cubic bezier paths
    become `ShapeObject` or element `ShapeGeom`. Element drop `shadow` and `feather` (`softEdge = radius ×
    min(w, h) × 0.5`) are carried on shapes and images, and a shape and a picture with the same fields look
    the same: both are drawn by the renderer's effects path (design/27 §7.1 "Picture effects": the shadow
    blurred by σ = blur/√6, the soft edge eroding the element's own outline, its round corners included,
    on every engine, WebKit too).
  - Text line masks (`textLineMask`) support `fullWidth`, `lineWidth`, and `maxLineWidth` styles with solid
    or gradient fills, horizontal/vertical/width/height offsets, and Cocoa `0.065 × F` intra-strap baseline
    centering on middle-aligned masks.
  - ProPresenter text elements with empty RTF (`!maskEnabled`) route to `ShapeObject` when they carry a
    fill or stroke, preserving background gradient overlays, accent bars, and divider lines.
  - Foreground media elements become `ImageObject` supporting non-rectangular `ImageObject.mask` (from
    element `Path`), `drawing.cropEnable` / `cropInsets` and `SCALE_BEHAVIOR_CUSTOM` (`customImageBounds`),
    plus `ImageObject.shadow` and `ImageObject.softEdge`.
  - Media URLs are tried as the exporting Mac's absolute path, then `local.path` (what
    ProPresenter itself resolves by), then a relative path; a bare file name that several
    entries share is taken only when one sits next to the document, else left unlinked.
  - Playlist items carry `arrangement_name` (field 5, added to the vendored proto); the
    arrangement is found by UUID, else by name. Headers are logged by name (ordo has no
    divider item yet), hidden items are skipped, a missing document is a warning.
  - A document's ordo id is `pro7-<uuid>`, so importing the library again updates the
    earlier copy. A copy with the same UUID but other content gets a numbered suffix. An "Untitled"
    presentation name falls back to the `.pro` filename stem.
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
    `\slN\slmult1`: both go into the line height and paragraph model.
  - A picture is an element whose fill is media, and it carries an (empty) text block like
    every element: the picture is kept, its text only when it has words.
  - Background media runs from the slide that starts it until a slide clears it (a clear
    action on the background or every layer, or a clear group named "Clear All", for
    background or media) or starts another, in the document's slide order. Each slide gets
    the background it would show; one background on every slide becomes the presentation's.
    A slide that stops a running background gets `clearBackground`, which clears the
    output's background layer when it is shown. The `exportCompat` option isolates each cue's
    background for slide-for-slide export comparison without changing live background continuation.
  - A slide's own colour (`drawsBackgroundColor`), else the presentation's background colour or
    gradient (`Presentation.background`, as #20 intended), is part of the slide above the background
    media, as in ProPresenter: a full-slide shape at the bottom of its objects, so a running picture or
    video is hidden behind it. It is marked as the slide's backdrop (`origin: { src: 'pro7', role: 'bg' }`,
    unlocked, as a PowerPoint slide's solid background is), so ordo's background changes replace it rather
    than sit behind it: the editor's Background button and Slide panel "Replace…" (`replaceBackground`)
    remove it when they give the slide a picture, and a playlist item's Background override draws the slide
    without it (`Cue.backgroundOverride`, `withoutBackdrops`) on screens that show backgrounds and in the
    live slide grid. Before PR #23 the shape carried no mark and a replaced background or an override did
    not show on such songs.
- Not carried (logged per document): slide labels, cue hot keys, group colours, builds,
  per-slide transitions, macros, timers, linked text (imported as last saved), title case /
  one-word-per-line transforms, text-box borders without a backing fill.
- Schema: the vendored protos are the community `proto/` set (ProPresenter 7.x). A raw
  scan of real 7.x and 21.x files found only cosmetic fields it lacks (ligature style, an
  image alpha-type flag); `autogen-proto/` in the same repository tracks ProPresenter 21.4
  and is the set to move to when a file shows fields that matter.
- Import root: a zip uploaded from the operator app, a single `.pro`, `.proPlaylist` or `.probundle`
  upload (since #10), or a NAS path the hub can read inside its import roots: a library folder, or one
  of those files or a library `.zip` (any other file is refused, 415). A single document is read into
  memory only after its size is checked (stat before read): past 64 MB (`MAX_INLINE_BYTES`, the size past
  which the zip and folder readers treat a file as media) it is refused, 413, by the route and again by
  the job. A single `.pro` from a NAS path brings its media from its folder: the media files in it and
  up to two levels below (at most 20,000 entries looked at, dot entries skipped) are offered to the
  importer as a folder import's are, so "Media found alongside is uploaded" holds for one song too;
  other documents beside it are not imported. The log groups by presentation: imported, partially
  imported (with reasons), skipped.

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
presentation with one image slide per page. For PPTX, the text is read by `@ordo/pptx-scene` on
the CPU pool (`apps/hub/src/pptx/textRepair.ts` `readDeckText`): each slide's text objects, placed
with the same uniform contain mapping as the page picture (a 4:3 deck sits between empty bars), and
given to the page that shows that slide (`pagesOf`: LibreOffice prints shown slides only; for
pptx-preview, shown slides when the page count equals the shown count, else every listed slide).
Result is stored as `Slide.imported.textBoxes` with `textAligned`; the editor's "make editable"
command uses them, and labels, the stage and search fall back to them on a slide without text of its
own (design/27 §11). Imports made before M3 matched boxes by list index, so after a hidden slide they
held another slide's text: the one-shot `pptx-text-repair` job re-keys them, and until then no reader
trusts them. `PptxGenJS` writes PPTX only: it is used for test decks (the fidelity corpus, the
render tests), never for import.

LibreOffice never converts the uploaded deck itself: a CPU-pool task (`pptx-render-copy`,
`@ordo/pptx-scene` `rendercopy.ts`, design/27 §5) writes a render copy of the slides to print,
every shown slide for this import. Every hidden slide is left out (a page is a shown slide, so
the page index is the shown index), every part is written again from the bounded parser's
tree under a generated name, and External relationships, macros, OLE binaries, embedded
packages and fonts, media payloads (posters stay), notes and comments are left out; fields
keep their stored text. The copy also removes the outline (`<a:ln>` in a run's properties)
from filled text in slides, layouts and masters. LibreOffice cannot draw a coloured outline
around filled text: it substitutes hollow letters, which with the usual drop shadow read as
broken text (white outlined headlines, common in sermon decks). The fill and shadow stay; text
meant to be hollow (`<a:noFill/>`) keeps its outline. The job log counts the runs changed.
soffice runs hardened (design/21: address-space cap, no network, process-group timeout). When
the copy cannot be built (the pool cannot start, the deck passes the caps), the import fails: LibreOffice
never converts a deck as uploaded. Fonts the deck uses must
be installed on the hub, or LibreOffice substitutes them.

### LibreOffice in the native import (design/27 §5)

The native import (`renderer=native`) draws every slide with ordo's own objects; LibreOffice has
three roles beside it, each a heavy job that runs after version 1 is saved and never writes a
presentation while it is live-locked (it re-queues itself with backoff, 30 s doubling to 15 min):

- `pptx-lo`, queued by the import before any clip job: one render copy and one soffice run for
  everything the deck needs. A hybrid slide's art (charts, tables, SmartArt, OLE, maths, 3D,
  WordArt warps, vertical text) is printed twice, alone, over a forced white and a forced yellow
  background (not black: LibreOffice draws text of automatic colour white on any background of
  luminance 156 or less, so automatic black text would come back white); `pdftoppm` renders both
  pages at 2 px per logical px (3840 x 2160 at 16:9) and the `pptx-art` pool task takes alpha =
  1 − (white − yellow)/255 in the blue channel, where the two differ by 255, and colour =
  (yellow − (1 − alpha)·background)/alpha (over white and black this is design/27's
  alpha = 1 − max(white − black)/255, colour = black/alpha), cut to the art's box and cropped to
  what it drew. The result is one locked, transparent image at
  the art's place in the z-order, over the native background and pictures. A metafile (EMF,
  WMF) is printed the same way alone at its own aspect and comes back as a transparent PNG in
  its object's place. A picture-class slide gets its page picture, unpadded, with text boxes
  keyed by the slide (`imported.textAligned`). Version 2 is one revision: a slide whose objects
  still match `Slide.pptx.digest` has its art range replaced; a slide edited meanwhile keeps
  every object and gets the art on top, with a note in `Slide.pptx.notes`.
- `pptx-reference` ('Show PowerPoint picture', `POST /presentations/:id/pptx-reference`, 423
  while the presentation is live): every shown slide once into `Slide.pptx.refMediaId`, shown
  instead of the objects (`show: 'picture'`). Every drawer then shows that picture and only the
  objects without `origin`, the ones the operator added (design/27 §5); the native import marks
  every object it writes with `origin: { src: 'pptx' }` (the converter's own origin wins).
- The fidelity reference of `tools/pptx-fidelity`.

### Native import (editable slides)

The native import ([design/27](27-pptx-native-renderer.md), M3) turns a deck into ordinary, editable ordo
objects instead of page pictures. Its steps are one **import core** in `@ordo/importers`, which runs in Node,
browsers and Web Workers: the scan (`pptx-scan.ts`: limits, `scanDeck`, `clipParts` with its candidate bound,
`extrasOf`), shape files (`pptx-geoms.ts`: `geomFileOf`, `decorFileOf`, `storedShapeFileOf`, `nameGeoms`,
`nameShapeFiles` over `emittedShapeFiles`, the kinds `SHAPE_FILE_KINDS`: geometry files and, since
`decor-render`, decoration files, `DecorData.ref`, named by one SHA-256 on the hub and in the browser, within
one batch bound, a decoration whose file cannot be kept left out and listed missing), picture headers and
display needs
(`pptx-pictures.ts`), the one SHA-256 (`sha256.ts`, incremental), the budget ladder (`pptx-ladder.ts`), the
drafts, budgets, provenance and assembly (`pptx-core.ts` `ImportCore`) and the import log (`pptx-report.ts`).
The hub's job, its pool task and the browser's parse all call them; the converter's version and stored
fields are one constant each in `@ordo/pptx-scene` (`version.ts`: `CONVERTER_VERSION`, `M9_WRITES` less
`M9_HELD_BACK`, empty since decorations draw, and `PPTX_SHEETS`).

**Where the deck is parsed.** The operator parses a deck it imports as editable slides in a Web Worker
(`parsePptxScene`, design/27 §2 "Where the deck is parsed") and uploads the scene with the deck
(`clientScene`); the hub checks it in its pool and builds version 1 from it with the same core, or parses
the deck itself (any failure, timeout or refusal on either side; a playlist live; an old browser). The
browser's zip reader (`zip-bounded.ts`) reads the central directory itself (never JSZip's private sizes),
refuses overlapping entries and more than 200,000, and counts inflated bytes as they come: an entry that
inflates past its declared size, an XML part over 8 MB or 64 MB of XML in all stop the parse; pictures and
clips are only read for their first bytes (a picture's pixel size, a clip's kind), within the hub's spill
budget.

The light `pptx-native` job (`apps/hub/src/pptx/nativeJob.ts`):

- reads the XML and relationship parts (each ≤ 8 MB, ≤ 64 MB in all; a larger part makes its slide a
  picture slide) and only the pictures the slides, their layouts, masters and themes relate to (≤ 2,000,
  ≤ 1 GiB, under generated names); embeddings, macros, custom XML, document properties and printer settings
  are skipped;
- parses and converts on the CPU pool with `@ordo/pptx-scene`: a scan (slide list, sections, referenced
  pictures, metafiles, speaker notes, the show's loop flag), then batches of at most 150 slides; or takes a
  checked client scene instead (`clientScene.ts`). A batch that fails is converted again slide by slide, and
  a slide that still fails, or one past the import's pool time, keeps its text (M9's rescue), never the deck;
- applies the size budgets of design/27 §3.4 as M9's budget ladder: a slide over 64 KB is simplified to fit
  (outlines re-gridded, text formatting, then decorations left out), and once the presentation passes
  3 MiB the slides from there on keep their text, pictures and background; without LibreOffice no slide
  becomes a picture for its size (logged, counted in the job result as `simplified`), and with it a slide
  over 64 KB that would lose formatting or decorations keeps LibreOffice's page, as before M9
  (`ImportCore.pageForBudget`);
- stores the pictures (prepared to their display need, deduplicated) and saves version 1: every slide's
  native objects, `Slide.pptx` provenance (deck, place, class, converter version, the digest of the objects
  as stored, `pending` while LibreOffice work remains), speaker notes, `p14` sections in order with a Default
  arrangement, hidden slides flagged (`Slide.hidden`), transitions (fade and dissolve a crossfade with the
  deck's duration, a transition without an effect a cut, any other effect a crossfade, noted), `advTm` as
  `durationMs` (a looping show with every shown slide timed becomes a loop presentation), the lyric box, and
  `source.native` (counts, the deck's area in the frame) with `source.log`;
- lays a background picture with transparency on white (a bottom image) rather than using it as the slide
  background, and makes one background shared by every slide the presentation's background; with 'Extend
  plain backgrounds to 16:9' (on by default) a plain background covers the whole frame of a 4:3 deck;
- draws SmartArt from PowerPoint's own drawing of it (`ppt/diagrams/drawingN.xml`, named by the data
  model's `dsp:dataModelExt`) as a locked group of ordinary shapes and pictures whose text stays editable,
  each node's text in PowerPoint's text rectangle (`dsp:txXfrm`) and in the colours part's node text colour
  (as LibreOffice takes it); a drawing with a residual shape (3D, vertical text) goes to the art whole, and
  SmartArt without a drawing stays for LibreOffice;
- bakes recoloured pictures (duotone, colour change, grayscale, black and white, brightness and contrast:
  PowerPoint's recolour presets) and tiled picture fills (shapes and backgrounds, tiles sized by the
  picture's stated resolution, else 96 per inch) into new prepared pictures, so they are drawn as PowerPoint
  shows them by every build; transparency (`alphaModFix`) stays the image's opacity, and a picture that
  cannot be baked is shown as it is, with a warning.

Hybrid slides (a chart, SmartArt without a drawing, OLE, 3D, …) and picture slides then wait for the heavy
`pptx-lo` follow-up, which adds LibreOffice art or page pictures as version 2.

### Two renderers: LibreOffice and pptx-preview

The import screen asks how to import a PowerPoint: 'Editable (recommended)', the native import of
[design/27](27-pptx-native-renderer.md) (`renderer=native`, the route's default, with 'Extend plain backgrounds
to 16:9' as `extendBackgrounds`), or 'Pictures (LibreOffice)' (`renderer=libreoffice`). pptx-preview
(experimental) is no longer offered there; the route still takes `renderer=pptx-preview` until design/27 M8
retires it. The choice is a form field on `POST /import/document`, stays in the job payload and, for the
picture imports, is recorded on the presentation (`source.renderer`). 'native' is never stored there (the
`PptxRenderer` enum is not widened): a native import records `source.native` instead.

pptx-preview is an npm library that draws a deck as HTML in a browser. Its npm package is free to use,
commercial use included, but it ships minified, and its author's terms forbid publishing modified source,
so ordo does not fork it. Its rendering is corrected from the outside instead, in `packages/pptx-render`,
which ordo owns and can keep fixing:

- **Repair before drawing** (`annotate.ts`). Package defects that stop pptx-preview are mended in a copy of
  the deck: content-type entries for parts that do not exist (pptxgenjs writes one slide master per slide,
  and pptx-preview then draws nothing) are dropped. A Strict OOXML deck (ISO 29500 Strict, namespaces and
  relationship types under `http://purl.oclc.org/ooxml/`) is rewritten to Transitional, the only form
  pptx-preview knows (it finds no theme, layout or master otherwise and draws no slide): URIs in every XML
  part and `.rels`, and percentages in slides, layouts, masters and themes (`"90%"` is `"90000"`). A
  group transform missing one of `a:off`, `a:ext`, `a:chOff`, `a:chExt` (all optional; Aspose omits
  some) gets it (a missing offset is the origin, as LibreOffice reads it, a missing size the other one).
  A slide placeholder without a position of its own whose layout has no placeholder pptx-preview matches
  (by idx, else by type) gets the position it inherits (the layout's placeholder of its type, else the
  master's); with none, a date, footer, slide number or header is dropped (LibreOffice draws none) and
  anything else gets the whole slide. Each of these otherwise stops pptx-preview drawing the whole deck.
  pptx-preview loads only pictures whose part is named
  `ppt/media/image*`; others (pptxgenjs writes `Slide-3-image-1.png`) are renamed, with every relationship
  to them. A chart without a title gets the one PowerPoint shows (none when it was deleted, the series name
  for a single series) instead of pptx-preview's placeholder ("图表标题"). Embedded colour profiles are
  removed from pictures: Chromium converts a picture from its profile, LibreOffice uses the values as
  they are. Every part is read through a stream that stops at a size limit (8 MB per XML part, 128 MB of
  XML in all, 64 MB per picture), counted while inflating rather than trusted from the zip, and at most
  65,536 runs and paragraphs are described: a deck is untrusted input. The hub runs the annotation on its
  CPU worker pool (`pptx-annotate`, with its own timeout and the pool's heap limit), never on the event
  loop, and the render's timeout counts from its start, annotation included.
- **Slide order.** pptx-preview takes slides from `[Content_Types].xml` and sorts them by the number in
  the part name, ignoring the presentation's order, and draws hidden slides. The annotator maps each
  slide it will draw to its place among the presentation's shown slides, and the captured pictures are
  put in that order with hidden slides left out, as LibreOffice exports them.
- **Run markers.** Every text run's `<a:t>` gets an invisible marker (U+2064 and eight base-4 digits from
  U+2060..U+2063: zero-width format characters, no line breaks) carrying an id into a side table of what
  ordo computed for that run from the XML, with PowerPoint's inheritance: run, paragraph, shape list style,
  layout placeholder, master placeholder, master text styles (title, body, other), presentation defaults,
  theme fonts (`+mj-lt`, `+mn-ea`…), theme effect styles and the master's colour map.
- **Restyle after drawing** (`page.ts`, run inside the page). The markers are found in the DOM, removed, and
  the run's element restyled: the Latin and East Asian typefaces (pptx-preview takes the East Asian one for
  Latin text, or none), each followed by the family fontconfig substitutes when it is not installed (what
  LibreOffice does; Chromium would otherwise fall back to its serif default); the size (pptx-preview
  shrinks some faces to 85 %) and character spacing (it condenses Latin text by 4 % and ignores `spc`);
  superscripts and subscripts (`baseline`, ignored); kept runs of spaces; underlines that do not skip
  descenders; and the run's own shadow over the one an unfilled shape casts. Text coloured by its shape's
  own list style or its placeholders' (`a:defRPr` fills below the master's text styles, which pptx-preview
  does read) gets that colour; pptx-preview drew it black. Gradient text (`a:gradFill` in a run's properties
  or inherited), which pptx-preview also drew black, is painted through the glyphs (`background-clip: text`):
  linear gradients at their angle, path gradients as radial ones from the centre of their fill rectangle.
  PowerPoint spreads one gradient over the whole text box, so when every run of a box has the same one the
  box paints it; a shadow under gradient text is a drop shadow of the painted glyphs. Hollow text
  (`a:noFill`), which pptx-preview filled black, shows only its outline (`a:ln`, 0.75 pt by default) or
  nothing. pptx-preview draws no text outlines on filled text either, matching what LibreOffice draws once
  the render copy has removed them. WordArt warps (`a:prstTxWarp`) are not drawn.
- **Paragraphs and text boxes.** Through the markers, and the side table's list of a text box's paragraphs
  (pptx-preview draws one block per paragraph, empty ones included), the page sets the box's margins and
  anchor, each paragraph's spacing, and its line height, as LibreOffice's text engine computes them
  (measured with test decks, and from its source): single spacing is 1.2 times the font size whatever the
  font; the baseline sits one font size below the top of a line; spacing above 100 % or exact spacing
  adds or removes space above the line, below 100 % caps the ascent at 80 % of the line; space before
  the first paragraph and after the last is not drawn; a percentage of space is a share of the font
  size. CSS splits leading above and below the line, so each paragraph is then moved until its first
  baseline is where LibreOffice puts it (a zero-size probe measures where Chromium put it). A box whose
  lines do not wrap (`wrap="none"`, which pptx-preview ignores) keeps each line whole, and a line wider than
  the box grows from its alignment, both ways when centred, leftwards when right-aligned, as in PowerPoint
  and LibreOffice (CSS lets it run out on the right). pptx-preview ignores animations, so text that builds
  in (`p:bldP`) is drawn in its final state, as LibreOffice draws it.
- **Bullets and numbers.** pptx-preview merges bullet settings from anywhere up the chain, so a nearer
  `a:buNone` (a template's layout or slide turning off the master's bullet) does not stop it drawing one,
  and it numbers every list 1., 2., 3. whatever `startAt` and the format say (scripture slides number
  verses with automatic numbers starting at the verse: "(17)", "(18)"). The annotator resolves each
  paragraph's bullet from the nearest setting in its chain and counts automatic numbers along the text box
  as PowerPoint and LibreOffice do (from `startAt`, per level, continued past empty paragraphs and deeper
  levels, ended by a shallower paragraph or one of the level without a number); the page removes the
  bullet pptx-preview drew where none applies and writes the number's label, colours it (`a:buClr`), and
  hangs it in the paragraph's indent (`marL`, negative `indent`) with every line of text at the margin.
- **Group coordinates.** pptx-preview guesses the unit of a grouped shape's offset: an x within 20,000 of
  zero is read as twentieths of a point, offset and size alike, so a text box at its group's origin (common
  in Google Slides decks) is drawn hundreds of times too large and its text lands off the slide. The
  annotator moves such a group's child coordinate space (its `a:chOff` and its children's offsets, by the
  same amount), which changes nothing in the picture.
- **Shrink on overflow.** PowerPoint stores the scale it found with its own fonts (`normAutofit`); with
  substitutes the text may not fit. LibreOffice ignores the stored scale and re-fits the text from full
  size, and the page does the same with LibreOffice's procedure (`SdrTextObj::autoFitTextForCompatibility`):
  a ten-step search on the font scale, moved by whether the text fits at full spacing, trying 100, 90 and
  80 % spacing at each step and keeping the tightest fit; font sizes are rounded to whole points. Boxes
  within about half a percent of fitting can still come out one step apart.
- **Tables.** LibreOffice makes a row as tall as its stored height or its tallest cell's text plus the
  cell's margins, and draws cell lines centred on the grid. pptx-preview's collapsed HTML borders and the
  browser's 1 px cell padding added their widths to every row, so dense tables ran off the slide: the page
  removes both and draws each cell's lines on an overlay centred on its edges. pptx-preview rounds the
  margins down, takes a point off left and right and uses 5 and 3 points when they are unset; the side
  table gives a cell's paragraphs its exact margins (`tcPr` `marL`/`marT`/`marR`/`marB`, PowerPoint's
  7.2 and 3.6 points by default). Cell text uses the line model above.
- **Video and audio.** pptx-preview lays a live `<video controls>` over a video's poster picture (and an
  audio player over a sound's icon), so the browser's play bar ended up in the slide picture. The players
  are removed and the poster stays, as PowerPoint and LibreOffice draw a stopped video. The media itself
  is not imported (by either renderer): see "Embedded media" below.
- **Pictures** in an ellipse, a rounded rectangle or a custom outline (`a:custGeom`: lines and Béziers;
  arcs are not drawn) are clipped to it (pptx-preview draws every picture as a rectangle). A slide background picture is stretched over the slide: pptx-preview writes its size
  without units, which CSS rejects, and the picture sat at its own size in the corner.
- **Background pictures** (`p:bg`, of the slide, else its layout, else its master) are placed as
  PowerPoint places them; pptx-preview ignores everything but the picture and its transparency. A tiled
  picture (`a:tile`) is repeated at its own size (pixels at the resolution its PNG, JPEG or BMP header
  states, else 96 per inch), scaled by sx/sy, from the aligned corner moved by tx/ty, and mirrored every
  other tile for `flip` (the page draws the mirrored unit on a canvas). A stretched one fills its fill
  rectangle (`a:fillRect` insets, which may be negative) and shows only its crop (`a:srcRect`). The
  annotation computes these as fractions of the slide (`backgrounds`) and the page sets the CSS
  background size, position and repeat. A background that refers to a picture among the theme's
  background styles (`p:bgRef` idx 1001 and up) is drawn by pptx-preview as a flat colour: the picture
  fill is written into the part, with a relationship to the theme's picture; a gradient among them (Office
  2007 and 2010 themes) is written in with the reference's colour in place of the placeholder colour
  (`phClr`), the placeholder's own tint or shade following it. Not corrected: a crop of a tiled picture,
  duotone and other colour changes of the picture (a theme picture with one is left as the flat colour pptx-preview draws).
- **A slide's own colour mapping** (`p:clrMapOvr`, a dark slide in a light deck: bg1 → dk1, tx1 → lt1) is
  ignored by pptx-preview, which maps scheme colours through the master only: such a slide is pointed to a
  copy of its layout and master whose `p:clrMap` is the slide's mapping.
- **"Hide background graphics"** (`showMasterSp="0"` on a slide, or on its layout for the master's shapes)
  is ignored by pptx-preview, which draws the master's and layout's shapes under every slide in their own
  boxes: those boxes are removed from such slides.
- **Drawing** (`chromium.ts`). The hub starts headless Chromium (`ORDO_CHROMIUM`) and drives it over the
  DevTools protocol on a pipe (no Playwright or Puppeteer at run time): a harness page beside the deck loads
  the unmodified pptx-preview bundle, draws every slide at 1920x1080, and each slide is captured on its own,
  pinned over the viewport (hiding the other slides instead resized their charts).
  Every network request is refused (`--host-resolver-rules`), so a deck's linked pictures fetch nothing.
  Chromium runs without its sandbox unless `ORDO_CHROMIUM_SANDBOX=1`: containers lack the user namespaces
  it needs. The page is ordo's own and the deck is data, as it is for LibreOffice, which has no sandbox.
- **Fallback.** If pptx-preview cannot run (no browser, a crash, a timeout), the job says why in its log and
  draws the deck with LibreOffice instead; the presentation then records `libreoffice`.

The text extraction for "make editable" runs whichever renderer draws the pictures.

### Embedded media

A PowerPoint slide can hold video (`p:pic` with `a:videoFile` and `p14:media`, embedded or linked), audio
(`a:audioFile`, sounds on animations and transitions) and linked online video. Neither picture renderer
imports them: the slide picture shows the video's poster or the sound's icon, and the clip is dropped.

The native import does (design/27 §4 "Media", §8; `apps/hub/src/pptx/clips.ts`): the first video of a slide
plays in its poster's box (`ImageObject.play`), the first sound is the slide's sound (`Slide.audio`, across
`numSld` slides), and a looping, muted video over a whole 16:9 slide becomes its motion background. Start
(automatic or on click), loop, 'Rewind after playing', volume, mute, 'Hide while not playing' and full screen
come from the slide's `p:timing`; `p14:trim` is baked into the clip. Clips are sniffed (a sound written as a
video is a sound), stored once per file and trim (tag `pptx`, '<deck> – slide N video'), and transcoded by
their `media` jobs after the import's LibreOffice follow-up. Linked clips are never fetched, and a clip that
cannot be imported stays its poster with a `[warn]` line in the import log. Transition sounds are imported
only with 'Import transition sounds'; animation sounds never. Test decks
for this: the `media` deck of the fidelity corpus, and LibreOffice's own test documents (`sd/qa/unit/data/
pptx`: `video-loop-mute`, `tdf106867`, `bnc591147`, `narration`, `tdf44223`, `tdf148478_transitionMusic`,
`animation-sound-*`), which are real-world decks attached to bug reports.

### Pictures of the native import

The native import stores each picture part its slides use once, prepared for how it is shown (design/27 §4,
`apps/hub/src/pptx/pictures.ts`):

- The header is read from the file's bytes, never its name, with bounded reads: PNG, JPEG, GIF and WebP are
  read; BMP and TIFF are converted; SVG, EMF and WMF go to LibreOffice in the `pptx-lo` follow-up. Anything
  else is refused and its objects left out: an unknown format, a malformed header (a PNG header with a bad
  checksum, a WebP canvas that disagrees with its image, a JPEG scan before its frame header) or a picture
  over 16,384 px a side (over 100 MP for formats other than JPEG).
- The display need is the part's widest use in the deck on a 3840-px output: the box width divided by the
  share of the picture the crop leaves visible (with the picture's size known, the box height counts too); a
  slide background is the whole frame, cover-fit. It is kept within 128-8,192 px.
- A picture more than 1.25 times its need, or over 8,192 px a side or 40 MP, is downscaled by ffmpeg
  (Lanczos): JPEG when opaque, PNG with alpha. BMP and TIFF become PNG; an animated GIF, APNG or animated
  WebP keeps its first frame and a multi-page TIFF its first page (noted in the job log). Any other picture
  is kept byte for byte (a hard link to the extracted part).
- Pictures are drawn as stored. PowerPoint ignores a JPEG's EXIF orientation and lays the picture out with
  its stored pixels (the boxes of real decks' tagged photos have the stored aspect), while browsers apply it,
  so preparation removes it: a kept JPEG is a copy with the tag set to 1, a conversion leaves it out (ffmpeg
  runs with `-noautorotate`), and a PNG or WebP with EXIF metadata is converted.
- ffmpeg reads a picture only through the demuxer of the format its header was checked as and decodes no
  more pixels than the header claimed (`-max_pixels`), so a header that lies about the size fails instead of
  allocating; a JPEG decodes at 1/2, 1/4 or 1/8 of its size when that is still large enough. One import
  decodes at most 6,000 MP; past that, pictures clients read as they are stay unscaled and the others are
  left out.
- Prepared pictures become ready image media (tag `pptx`, no media job) through `addReadyPicture`, which
  accepts only a still PNG, JPEG, GIF or WebP whose header matches the size it claims, within 8,192 px a side
  and 40 MP.
- The media hash index (`media_hashes`, design/12 "Storage") finds an item with the same prepared bytes, or
  one prepared from the same source part at a size that fits the need, so importing the same deck again, or
  another deck with the same pictures, stores nothing new. The job records [part, media id] pairs in its
  payload as it goes, so a re-queued job skips them.

The ProPresenter import finds media with the same content through the same index (`mediaForFile`).

### Fidelity

`tools/pptx-fidelity` draws decks with both renderers and scores pptx-preview against LibreOffice slide by
slide (SSIM of greyscale pictures at 960x540, computed by ffmpeg; 1 is identical). LibreOffice is the ground
truth for now; PowerPoint's own PDF exports would be better and can replace it. `--corpus` adds synthetic
decks written with pptxgenjs, one feature per slide (`src/corpus.ts`); real decks are passed as paths and
never committed. `--raw` also draws with pptx-preview unmodified, to show what ordo's corrections are worth.
It writes `summary.json` and an HTML report with the pictures side by side, worst slides first. LibreOffice
rounds a 960 pt slide up to 1921 pixels; its pictures are cut to the slide's proportions before scoring.

Where LibreOffice is known to differ from PowerPoint, ordo follows PowerPoint and the score pays for it:
LibreOffice does not draw a run's own text shadow (PowerPoint's "Text Shadow" button), ordo does. The native
column's `--lo-compat` draws the slides those policies change as LibreOffice would and as ordo does, and
reports the means both ways and per rule (design/27 §14.1).

Known gaps: pptx-preview's charts (ECharts) misread some chart data (pptxgenjs's multi-level category
labels; values drawn far too small), table text can still wrap differently, and photographs score
lower than their look suggests because the two renderers scale pictures with different filters.
pptx-preview applies a colour's `a:tint` as a blend of HSL lightness toward white, after its shade and
luminance changes whatever their order in the XML; PowerPoint and LibreOffice blend in linear RGB, in
order, so a dark theme colour with a tint comes out darker (black with a 95 % tint: #0D0D0D against
#404040). Correcting it means resolving each scheme colour, theme placeholder colours included, per slide.
Slide decks that are not valid packages (no theme, master or layout: hand-written test files) can draw
nothing, where LibreOffice draws them with defaults.

```
pnpm --filter @ordo/pptx-fidelity start -- --corpus --raw --out tmp/pptx-fidelity ~/decks/*.pptx
```

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
