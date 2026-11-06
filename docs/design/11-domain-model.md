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
  source?: { kind: 'pro7' | 'songselect' | 'pptx' | 'pdf' | 'manual'; fileId?: Id; log?: string };
  archived: boolean;
};

type Section = { id: Id; label: string; short: string; slides: Slide[] };

type Slide = {
  id: Id;
  objects: SlideObject[]; // z-order, first = back
  lyricObjectId?: Id; // which text box lyric-only looks read
  backgroundMediaId?: Id; // per-slide override, rare
  clearBackground?: boolean; // showing it clears the running background (ProPresenter clear actions)
  durationMs?: number; // for loop presentations
  notes?: string;
  overrides?: string[]; // paths of theme properties overridden
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
type TextObject = { id: Id; type: 'text'; box: Box; text: string; style: TextStyle; opacity: number };
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
};
type ShapeObject = {
  id: Id;
  type: 'shape';
  box: Box;
  shape: 'rect' | 'ellipse' | 'line';
  fill?: Rgba;
  stroke?: { width: number; color: Rgba };
  opacity: number;
  radius: number;
};

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
  source: 'upload' | 'google';
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

A slide cue can carry its own media (design/27 §8): the playing ImageObject's clip
(`mediaObjectId`, `mediaStart`, `mediaShowWhenStopped` with the cue's media fields) goes on
the media layer with `objectId`, and `Slide.audio` (`slideAudio` with `untilCue`) goes in
the audio slot as `slideOwned` until the live cue leaves `[cueIndex, untilCue]`.
- `expandCues` sets these fields only for media in `resolved.media`. `untilCue` is the cue
  reached after `slides` shown slides of the same playlist item (the slide itself counts as
  the first, hidden slides do not), else the item's last cue.
- A click start goes live paused at 0, and F8 plays it. Entering a slide restarts its video;
  a slide-owned sound still playing from that same cue is never restarted, so a loop that
  wraps back to it keeps the music running.
- A slide's sound replaces playlist audio, which otherwise plays on under slides.
  `clear('slide')` also clears the slide's video and sound. onEnd works as for media cues,
  because `cueIndex` is the slide's own cue.
- At goLive these clips and sounds are optional: one that is missing, still processing or
  failed is left out with a `degraded` note, and the slide shows its poster.

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
