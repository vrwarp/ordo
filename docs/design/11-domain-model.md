# Design 11: Domain model

All entities are defined once in `packages/domain` as Zod schemas with inferred
TypeScript types. The hub stores them as JSON columns in SQLite beside indexed scalar
columns. Identifiers are ULIDs. Every stored entity carries `id`, `createdAt`,
`updatedAt`, and `rev` (monotonic per entity).

## Entities

```ts
// Presentation
type Presentation = {
  id: Id;
  rev: number;
  title: string;
  kind: 'song' | 'slides' | 'loop';
  meta: { author?: string; ccli?: string; copyright?: string; key?: string; tempo?: number; tags: string[] };
  folderId?: Id;
  themeId?: Id;
  backgroundMediaId?: Id; // default Background layer content
  transition?: Transition; // override of the look default
  sections: Section[];
  arrangements: Arrangement[]; // arrangements[0] is the default (authoring order)
  loop?: { defaultSlideMs: number };
  source?: {
    kind: 'pro7' | 'songselect' | 'pptx' | 'pdf' | 'manual';
    fileId?: Id;
    log?: string;
    native?: PptxNativeSource; // set by the native PowerPoint import (design/27 §3.1)
  };
  archived: boolean;
};

type Section = { id: Id; label: string; short: string; slides: Slide[] };

// Where an imported PowerPoint slide came from. Enums degrade to their defaults when unknown.
type SlidePptx = {
  fileId: Id; // the stored deck (SHA-256)
  index: number; // place in p:sldIdLst, hidden slides counted
  shown?: number; // place among shown slides (the LibreOffice page); absent when hidden
  class: 'native' | 'hybrid' | 'picture';
  version: number; // converter version
  digest?: string; // of the objects the converter wrote: "unedited" while they still match
  pending?: boolean; // LibreOffice work for this slide still to come
  failed?: boolean; // LibreOffice could not draw (part of) it: shows version 1, named by goLive
  notes?: string[]; // what was approximated (≤ 16)
  artText?: string; // text baked into the art or page picture (search and labels only)
  refMediaId?: Id; // LibreOffice picture of the whole slide, on demand
  show?: 'objects' | 'picture'; // 'picture' + refMediaId: drawers show it and only the objects without origin
};
type PptxNativeSource = {
  version: number;
  slides: number;
  native: number;
  hybrid: number;
  picture: number;
  slideRect?: { x: number; y: number; w: number; h: number }; // the deck's area in 1920x1080
};

type Slide = {
  id: Id;
  objects: SlideObject[]; // z-order, first = back
  lyricObjectId?: Id; // which text box lyric-only looks read
  backgroundMediaId?: Id; // per-slide override, rare
  clearBackground?: boolean; // showing it clears the running background (ProPresenter clear actions)
  durationMs?: number; // for loop presentations
  notes?: string;
  overrides?: string[]; // paths of theme properties overridden
  hidden?: boolean; // a hidden PowerPoint slide (design/27 §9): its cue is flagged `hidden`; Next, Prev,
  // auto-advance and onEnd 'advance' skip it, a click in the slide grid (a GO with its index) shows it
  transition?: Transition; // the slide's own: a cue uses item ?? slide ?? presentation (design/27 §9)
  pptx?: SlidePptx; // PowerPoint provenance, never drawable content (design/27 §3.1)
  // imported.textAligned?: boolean: true when the text boxes are keyed by shown slide, so text readers
  // (labels, stage, search: `importedText`) may fall back to them (design/27 §11); false when the legacy
  // repair could not read the deck; absent on legacy boxes, matched by list index, which are not trusted.
  imported?: { fileId: Id; page: number; imageMediaId: Id; textBoxes?: ExtractedText[] };
  audio?: SlideSound; // the slide's own sound (design/27 §8)
};
// Media played in place (design/27 §3.1). Enums degrade to their default (.catch); trims are baked at ingest.
type Play = {
  mediaId: Id; // the clip; the ImageObject's own mediaId stays its poster
  start?: 'auto' | 'click'; // click: goes live paused at 0, F8 plays
  loop?: boolean;
  onEnd?: 'hold' | 'black' | 'advance'; // black = PowerPoint "Rewind after playing": the poster shows again
  gainDb?: number; // -100..100
  muted?: boolean;
  showWhenStopped?: boolean; // false = PowerPoint "Hide while not playing"
};
type SlideSound = {
  mediaId: Id;
  start?: 'auto' | 'click';
  loop?: boolean;
  gainDb?: number;
  muted?: boolean;
  slides?: number; // 1..999: plays across this many shown slides of the same playlist item
};

type SlideObject = TextObject | ImageObject | ShapeObject;
type Box = { x: number; y: number; w: number; h: number; rotation: number }; // 0..1920 x 0..1080 logical
type TextObject = {
  id: Id;
  type: 'text';
  box: Box;
  text: string;
  style: TextStyle;
  opacity: number;
  runs?: TextRun[]; // sparse styles over `text` (UTF-16 offsets), sorted, non-overlapping (design/27 §3.1)
  paras?: (TextPara | null)[]; // paragraph styles: paras[i] ↔ text.split('\n')[i]; bullets, numbering, spacing
  // `text` stays canonical (no bullets or numbers in it); what people read (cue labels, stage, bands,
  // search) is readableText(o), which writes each paragraph's label ('(17)', '•') in front of it.
};
type TextStyle = {
  fontFamily: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  fontSizePx: number;
  color: Rgba;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
  lineHeight: number;
  letterSpacing: number;
  padding: number;
  outline?: { width: number; color: Rgba };
  shadow?: { dx: number; dy: number; blur: number; color: Rgba };
  fill?: { color: Rgba; radius: number };
  // Rich text (design/27 §3.1), all optional: lineModel 'ordo' | 'office', insets (replace padding), wrap,
  // autofit 'none' | 'shrink' with fitScale, justify, direction 'ltr' | 'rtl' | 'auto', lang, fallbackFonts,
  // underline, glow, paint (M6: a Gradient for gradient text). A text object with runs, paras or any of these
  // is drawn by the rich text engine.
};
// M6 (design/27 §3.1): a geometry and a gradient, shared by shapes, picture masks and gradient text.
type ShapeGeom = {
  preset?: string; // a PowerPoint preset by name (187), evaluated at draw time
  adj?: [string, number][]; // its adjust values, as pairs
  // A custGeom's evaluated paths: only M L C Q Z and numbers (re-tokenised before drawing, ≤ 4,096 points),
  // in their own w x h space scaled to the box; ≤ 8.
  paths?: {
    d: string;
    w: number;
    h: number;
    fill?: 'norm' | 'none' | 'lighten' | 'lightenLess' | 'darken' | 'darkenLess';
    stroke?: boolean;
    cont?: boolean; // continues the path before it (one long path stored in pieces)
  }[];
  // M6 round 2: the paths live in a geometry file (`GeomFile` = { paths }, JSON in the content store), named
  // by its SHA-256 and read by drawers like a picture; while it is not read the geometry is the rest of this
  // object, else the legacy shape. Large traced outlines travel once per library, not in every slide.
  ref?: string;
};
type Gradient = {
  kind: 'linear' | 'radial';
  angle?: number; // degrees clockwise from left→right (OOXML a:lin ang); scaled?: boolean
  stops: { at: number; color: Rgba }[]; // 2..16, sorted
  center?: { x: number; y: number }; // radial focus in box fractions (default the centre)
};
type ImageObject = {
  id: Id;
  type: 'image';
  box: Box;
  mediaId: Id;
  play?: Play; // the clip this object plays in its box, at its z-order (design/27 §7.2)
  fit: 'contain' | 'cover' | 'stretch';
  opacity: number;
  radius: number;
  // Share of the picture cut from each side (-1..1) before `fit`; a negative share pads with
  // transparency (PowerPoint a:srcRect, design/27 §3.1).
  crop?: { l: number; t: number; r: number; b: number };
  // Mirrored about the box's centre before the box's rotation, crop and mask included (the crop keeps
  // naming the source's sides). Older builds draw the picture unflipped.
  flipH?: boolean;
  flipV?: boolean;
  // Cut to a geometry (ShapeGeom: a preset with adj pairs, paths or a geometry file; the union of its filled
  // paths), drawn by every drawer since M6 (the editor offers 'ellipse' and 'roundRect', adj being the corner
  // in 1/100,000 of the shorter side; the video plane cuts only those two). `radius` applies only without a
  // mask; the importer writes it beside one as the legacy value (design/27 §3.2).
  mask?: ShapeGeom;
};
type ShapeObject = {
  id: Id;
  type: 'shape';
  box: Box;
  shape: 'rect' | 'ellipse' | 'line'; // what an older build draws, with fill as a solid colour
  fill?: Rgba;
  stroke?: { width: number; color: Rgba };
  opacity: number;
  radius: number;
  // M6 (design/27 §3.1), all optional; a shape with any of them is drawn through the geometry engine.
  geom?: ShapeGeom;
  gradient?: Gradient; // instead of fill
  dash?:
    | 'solid'
    | 'dot'
    | 'dash'
    | 'dashDot'
    | 'longDash'
    | 'longDashDot'
    | 'longDashDotDot'
    | 'sysDot'
    | 'sysDash'
    | 'sysDashDot'
    | 'sysDashDotDot';
  lineJoin?: 'miter' | 'round' | 'bevel'; // M6 repair: absent = miter (limit 8)
  lineCap?: 'flat' | 'round' | 'square'; // M6 repair: absent = flat; round/square drawn within a preset dash
  ends?: { head?: ArrowEnd; tail?: ArrowEnd }; // arrowheads at an open path's start and end
  flipH?: boolean;
  flipV?: boolean;
  shadow?: { dx: number; dy: number; blur: number; color: Rgba }; // outer shadow
  glow?: { radius: number; color: Rgba };
  softEdge?: number; // logical px
};
type ArrowEnd = {
  type: 'none' | 'triangle' | 'stealth' | 'arrow' | 'oval' | 'diamond';
  w?: 'sm' | 'med' | 'lg';
  len?: 'sm' | 'med' | 'lg';
};

// Every object may also carry origin?: { src; shapeId?; ph?; role?; group? } (where an imported PowerPoint
// shape came from; the native import sets at least { src: 'pptx' } on every object it writes, so objects
// without one are the operator's own) and locked?: boolean (move, resize, delete and z-order only),
// design/27 §3.1. What a slide draws is `slideContent(slide)` (@ordo/domain, design/27 §5).

type Arrangement = { id: Id; name: string; sectionIds: Id[] };

type Theme = { id: Id; name: string; lyricBox: Box; text: TextStyle; textBoxDefaults: TextStyle };

// Media
type Media = {
  id: Id;
  rev: number;
  name: string;
  tags: string[];
  kind: 'video' | 'image' | 'audio';
  original: FileRef; // as uploaded
  delivery?: FileRef; // transcoded, present when state = 'ready'
  poster?: FileRef; // for video
  state: 'uploaded' | 'processing' | 'ready' | 'failed';
  error?: string;
  durationMs?: number;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  loop: boolean;
  isBackground: boolean;
  audio?: { pairId?: Id; gainDb: number; loudnessLufs?: number }; // loudness: audio files and video soundtracks
  trim?: { startMs: number; endMs: number }; // kept part of the original, baked into delivery; imports dedup on hash + trim
};
type FileRef = { hash: string; bytes: number; mime: string; path: string }; // hash = sha256, content addressed

type Font = {
  id: Id;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  file: FileRef;
  source: 'upload' | 'google' | 'bundled';
  unicodeRange?: string; // CSS unicode-range of a subset face (Google Fonts subsets, design/27 §10)
};

// Playlists
type Playlist = { id: Id; rev: number; name: string; serviceDate?: string; items: PlaylistItem[] };
type PlaylistItem =
  | {
      id: Id;
      kind: 'presentation';
      presentationId: Id;
      arrangementId?: Id;
      transition?: Transition;
      backgroundMediaId?: Id;
    }
  | {
      id: Id;
      kind: 'media';
      mediaId: Id;
      loop?: boolean;
      onEnd?: 'hold' | 'black' | 'advance';
      audio?: { pairId?: Id; gainDb?: number };
    }
  | { id: Id; kind: 'timer'; timer: TimerSpec }
  | { id: Id; kind: 'action'; action: ActionId };

type TimerSpec =
  | { kind: 'countdownTo'; timeOfDay: string; label?: string; showOn: LookId[] }
  | { kind: 'elapsed'; label?: string };

// Outputs and looks
type Look = {
  id: Id;
  name: string;
  layers: {
    background: LayerRule;
    slide: SlideRule;
    lowerThird: LayerRule;
    media: LayerRule;
    props: PropsRule;
  };
  clearColor: Rgba; // black, or the key colour
  transition: Transition;
};
type LayerRule = { visible: boolean };
type SlideRule =
  | { mode: 'authored' }
  | {
      mode: 'lyricOnly';
      style: TextStyle;
      band: Box;
      nextSlide?: { style: TextStyle; band: Box };
      nonSong: 'text' | 'none';
    };
type PropsRule = {
  logo: boolean;
  countdown: boolean;
  clock: boolean;
  messages: boolean;
  elapsed: boolean;
  mediaRemaining?: boolean /* stage: remaining time of the live video; absent follows `elapsed` */;
  notes?: boolean /* stage: the live slide's notes for the preacher, in style['notes'] (design/27 §11) */;
  style: Record<string, TextStyle & { box: Box }>;
};
type Transition = { kind: 'cut' } | { kind: 'crossfade'; ms: number };

type Output = {
  id: Id;
  name: string;
  hostIndex: number /* out<k> */;
  lookId: Id;
  screen?: ScreenRef;
  enabled: boolean;
  audioMaster: boolean;
  token: string;
};
type ScreenRef = { label: string; left: number; top: number; width: number; height: number };

// Audio
type AudioSettings = {
  houseDeviceId?: string;
  previewDeviceId?: string;
  pairs: { id: Id; name: string; left: number; right: number }[];
  defaultPairId?: Id;
  masterDb: number;
};

// Scripture (data model only in the prototype)
type ScriptureRef = {
  translation: string;
  book: string;
  chapter: number;
  verseFrom: number;
  verseTo?: number;
};
type ScriptureSlideSource = { ref: ScriptureRef; text: string; fetchedAt: string; provider: string };
// A slides presentation may carry `scripture?: ScriptureSlideSource` on each slide; a later
// milestone adds a provider interface (API.Bible, ESV) in the hub that creates such presentations.
```

<!-- m9:schema -->
### M9 fields: what ordo draws instead of LibreOffice (design/27 M9)

All optional, each with `.catch(undefined)`, so a malformed one is dropped without failing the slide, and
every enum inside them degrades to its default. An older build strips them and draws the legacy fields the
converter writes beside them (design/27 §3.2). No `SlideObject` member and no stored enum is added.

```ts
type ShapeObject += {
  // What the shape draws instead of its geometry; a drawer keeps at most one, in this order, and no look3d
  // with any of them. Legacy: table → a rect of the table's background; chart → the chart area's rect;
  // decor → a line without a stroke (nothing).
  table?: TableData; // origin.role 'table'
  chart?: ChartData; // origin.role 'chart' (packages/domain/src/chart.ts)
  decor?: DecorData; // origin.role 'decor', locked: a z-run of plain shapes as one object
  look3d?: Look3d; // bevel, extrusion, contour, material, light, camera (names: three-names.ts)
};
type ImageObject += { look3d?: Look3d; vectorFonts?: string[] /* ≤ 8: the families of a vector picture */ };
type TextObject += {
  warp?: { preset: TextWarpPreset /* 40 names */; adj?: [string, number][] }; // WordArt
  writing?: { upright: 'none' | 'cjk' | 'all'; reverse?: boolean }; // vertical text in a quarter-turned box
  centerBlock?: boolean; // PowerPoint anchorCtr
  look3d?: Look3d;
}; // never on TextStyle: themes, bands, the stage and props never warp, stand up or turn text
type ShapeGeom += { adjWide?: [string, number][] }; // angles past adj's ±1e7, up to ±21,600,000
type SlidePptx += { missing?: string[] }; // '<kind>' | '<kind>:<subtype>' (MISSING_KINDS), ≤ 16 of ≤ 40

type TableData = {
  cols: number[]; rows: number[]; // widths and minimum heights, scaled to the box
  cells: TableCell[]; // row-major, each at the next grid slot no earlier cell covers
  base: TextStyle; // the cells' style; palettes hold only what differs from it
  styles?: CellStyle[]; runStyles?: TableRunStyle[]; fills?: TableFill[]; lineStyles?: TableLineStyle[];
  h?: [edge, from, to, line][]; v?: [edge, from, to, line][];
  background?: number; rtl?: boolean; rowRule?: 'grow' | 'fixed';
};
type TableCell = {
  text?: string; runs?: [start, end, runStyle][]; paras?: (TextPara | null)[];
  style?: number; fill?: number; colSpan?: number; rowSpan?: number; diag?: { down?: number; up?: number };
};
type DecorData = { w: number; h: number; paints: DecorPaint[]; parts: DecorPart[]; ref?: string /* DecorFile */ };
// Files in the content store, read like pictures: GeomFile { paths } (≤ 64 paths since M9) and
// DecorFile { parts } (≤ 256), each ≤ GEOM_FILE_MAX_BYTES (2,600,000).
// Media: a vector picture is kind 'image' with original.mime VECTOR_MIME ('application/vnd.ordo.vector').
```

Limits: `TABLE_LIMITS` (256 rows, 64 columns, 4,096 grid slots, 10,000 characters a cell and 60,000 a table),
`CHART_LIMITS` (64 series of 1,024 points, 4 groups and axes, labels 255, titles 1,000), `DECOR_LIMITS`
(64 paints, 256 parts, 16,384 points, 24 shadows). Readers (`m9-readers.ts`): `tableText`, `chartText` and
`objectSearchText` for search and labels, `extraFontFamilies` and `extraText` for goLive's font scan,
`drawnShapeFileRefs` for the geometry and decoration files a slide draws; `palette.ts` dedupes palettes.
<!-- /m9:schema -->

<!-- m9:tables-render -->
**Tables: placement and edits** (`packages/domain/src/table.ts`, M9 tables-render). A table's cells have no
coordinates: walking the grid row-major, each takes the next slot no earlier cell covers (`placeCells`; a span
is cut where it would reach a covered slot or the grid's edge, cells past the grid are dropped). A cell is
read and written as a rich text body: `cellRich(t, i)` gives `{ text, style, runs?, paras? }` with the style
`cellTextStyle(base, styles[cell.style])` (no autofit: rows grow instead) and the runs expanded from
`runStyles`; `setCell(o, i, body)` writes an edited body back into the palettes (`cellStyleOf`: the fields
that differ from `base`). Ops on a table shape, each returning a new object or the same one when refused:

```ts
setCell(o, i, body);
setCellFill(o, cells, color | null);
insertRow(o, at, from);
deleteRow(o, r);
insertCol(o, at, from);
deleteCol(o, c);
gcTable(t); // palette entries nothing uses removed, indices renumbered (every op ends with it)
```

Row and column ops keep every slot covered once, grow or shrink the spans they cross, copy the source row's or
column's size, cell styles, fills and lines, keep no line inside a merged cell, keep the table's width and add
or remove a row's height to `box.h`; they refuse past `TABLE_LIMITS` and at the last row or column.
<!-- /m9:tables-render -->

## Live state

Owned by the hub (or the operator in fallback), produced by the pure reducer in
`packages/live-state`.

```ts
type LiveState = {
  seq: number; // increments on every applied event
  playlist?: { id: Id; rev: number; items: ResolvedItem[] }; // frozen copy with presentations and arrangements expanded into cues
  cues: Cue[]; // flat, ordered; index is the operator's position
  live?: CueRef;
  armed?: CueRef; // CueRef = { cueIndex: number }
  layers: {
    background?: LayerContent;
    slide?: LayerContent;
    lowerThird?: LayerContent;
    media?: LayerContent;
    props: PropsState;
  };
  media?: {
    cueIndex: number;
    state: 'playing' | 'paused' | 'ended';
    startedAtHub: number;
    positionMs: number;
    loop: boolean;
  };
  timers: Timer[];
  messages: StageMessage[];
  outputs: Record<Id, OutputHealth>;
  mode: 'idle' | 'live';
  cacheManifest?: ManifestRef;
};
type Cue = {
  index: number;
  itemId: Id;
  kind: 'slide' | 'media' | 'timer' | 'action';
  presentationId?: Id;
  sectionId?: Id;
  slideId?: Id;
  label: string;
  hidden?: boolean; // true on a hidden slide (design/27 §9): sequential navigation skips it, `go` reaches it
};
type LayerContent = { kind: 'slide' | 'media' | 'logo' | 'lowerThird'; ref: Id; sinceSeq: number };
type Timer = { id: Id; spec: TimerSpec; startedAtHub?: number; endsAtHub?: number; running: boolean };
type StageMessage = { id: Id; text: string; sentAtHub: number; expiresAtHub?: number };
type OutputHealth = {
  connected: boolean;
  armed?: CueRef;
  live?: CueRef;
  presented: number;
  missed: number;
  longTasks: number;
  cache: { ready: number; total: number };
  gpuLost: number;
  lastSeenHub: number;
};
```

The reducer handles events: `goLive(playlistId)`, `endService`, `select(cueIndex)`
(arms), `go(cueIndex?, at)`, `next`, `prev`, `clear(layer | 'all')`, `logo`,
`media.play|pause|restart`, `timer.start|stop|reset`, `message.send|dismiss`,
`output.register|health`. It is deterministic so hub, operator and outputs compute the
same state from the same event sequence.

A hidden slide keeps its cue, flagged `hidden` (design/27 §9). `next`, `prev`, the cue a GO
arms, `autoAdvance` (wrapping within the item), onEnd 'advance', `nextItem` and `prevItem` skip
hidden cues (`nextShownCue`, `prevShownCue`; an item whose slides are all hidden is passed by);
`goToSection` lands on the section's first cue that is not hidden, else its first cue
(`sectionsOfItem().entry`); `go` and `select` reach any cue. A slide sound's `untilCue` counts
shown slides only, so a hidden cue inside its range keeps the sound playing when a click shows it.

A slide cue can carry its own media (design/27 §8): the playing ImageObject's clip
(`mediaObjectId`, `mediaStart`, `mediaShowWhenStopped` with the cue's media fields) goes on
the media layer with `objectId`, and `Slide.audio` (`slideAudio` with `untilCue`) goes in
the audio slot as `slideOwned` until the live cue leaves `[cueIndex, untilCue]`.
- `expandCues` sets these fields only for media in `resolved.media`. `untilCue` is the cue
  reached after `slides` shown slides of the same playlist item (the slide itself counts as
  the first, hidden slides do not), else the item's last cue.
- A click-start video goes live paused at 0, and F8 plays it. A click-start sound waits for
  F8 (`pendingSlideSound`) without touching the audio slot; F8 starts it, after a waiting
  click video (`mediaPlayTarget`). Entering a slide restarts its video; a slide-owned sound
  of the same media still playing with the entered cue inside its range is never restarted,
  so a loop that wraps back to it, or an arrangement that repeats the slide, keeps the music
  running.
- A slide's sound replaces playlist audio once it starts (an autoplay sound when its slide
  goes live, a click-start one on F8); playlist audio otherwise plays on under slides.
  `clear('slide')` also clears the slide's video and sound. onEnd works as for media cues,
  because `cueIndex` is the slide's own cue.
- At goLive these clips and sounds are optional: one that is missing, still processing or
  failed is left out with a `degraded` note, and the slide shows its poster. So is the own
  background of a PowerPoint slide (`Slide.pptx` set: the importer makes a looping, muted
  full-slide video its motion background): left out, the cue shows the item's or the
  presentation's background instead.

## Identifiers and content addressing

- Entities: ULID strings.
- Files: SHA-256 of content; the path on disk is `media/<hash[0:2]>/<hash>.<ext>`.
  Caches key by hash so re-uploads and renames cost nothing.

## Revisions

Each presentation save writes a row to `presentation_revisions (presentation_id, rev,
json, saved_by, saved_at)`. Restore copies an old row's JSON into a new revision. Thirty
days or 50 revisions are kept per presentation, whichever is more.

## Arrangement expansion

`expandCues(playlist, presentations)` in `packages/domain` turns a playlist into the flat
`cues` list: for each presentation item, walk the arrangement's section ids and emit one
cue per slide; for media, timer and action items emit one cue. This is the single
source of the operator's position space, the Stream Deck's section buttons and the
outputs' arm targets.
