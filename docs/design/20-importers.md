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

Before LibreOffice converts a PPTX, `pptxForRendering` removes the outline (`<a:ln>` in a
run's properties) from filled text in slides, layouts and masters. LibreOffice cannot draw a
coloured outline around filled text: it substitutes hollow letters, which with the usual drop
shadow read as broken text (white outlined headlines, common in sermon decks). The fill and
shadow stay; text meant to be hollow (`<a:noFill/>`) keeps its outline. The job log counts
the runs changed. Fonts the deck uses must be installed on the hub, or LibreOffice
substitutes them.

### Two renderers: LibreOffice and pptx-preview

The import screen asks what draws a PowerPoint's slides: LibreOffice (the default) or pptx-preview
(experimental). The choice is a form field on `POST /import/document` (`renderer`), stays in the job payload
and is recorded on the presentation (`source.renderer`).

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
  `pptxForRendering` has removed them. WordArt warps (`a:prstTxWarp`) are not drawn.
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
(`a:audioFile`, sounds on animations and transitions) and linked online video. Neither renderer imports
them: the slide picture shows the video's poster or the sound's icon, and the clip is dropped. Test decks
for this: the `media` deck of the fidelity corpus, and LibreOffice's own test documents (`sd/qa/unit/data/
pptx`: `video-loop-mute`, `tdf106867`, `bnc591147`, `narration`, `tdf44223`, `tdf148478_transitionMusic`,
`animation-sound-*`), which are real-world decks attached to bug reports.

### Fidelity

`tools/pptx-fidelity` draws decks with both renderers and scores pptx-preview against LibreOffice slide by
slide (SSIM of greyscale pictures at 960x540, computed by ffmpeg; 1 is identical). LibreOffice is the ground
truth for now; PowerPoint's own PDF exports would be better and can replace it. `--corpus` adds synthetic
decks written with pptxgenjs, one feature per slide (`src/corpus.ts`); real decks are passed as paths and
never committed. `--raw` also draws with pptx-preview unmodified, to show what ordo's corrections are worth.
It writes `summary.json` and an HTML report with the pictures side by side, worst slides first. LibreOffice
rounds a 960 pt slide up to 1921 pixels; its pictures are cut to the slide's proportions before scoring.

Where LibreOffice is known to differ from PowerPoint, ordo follows PowerPoint and the score pays for it:
LibreOffice does not draw a run's own text shadow (PowerPoint's "Text Shadow" button), ordo does.

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
