import { z } from 'zod';

/** ULID string identifiers for every stored entity. */
export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

/** Logical canvas is 1920x1080; outputs scale. */
export const LOGICAL_WIDTH = 1920;
export const LOGICAL_HEIGHT = 1080;

export const Rgba = z.object({ r: z.number(), g: z.number(), b: z.number(), a: z.number() });
export type Rgba = z.infer<typeof Rgba>;

export const Box = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  rotation: z.number().default(0),
});
export type Box = z.infer<typeof Box>;

export const TextStyle = z.object({
  fontFamily: z.string(),
  fontWeight: z.number().default(400),
  fontStyle: z.enum(['normal', 'italic']).default('normal'),
  fontSizePx: z.number(),
  color: Rgba,
  align: z.enum(['left', 'center', 'right']).default('center'),
  valign: z.enum(['top', 'middle', 'bottom']).default('middle'),
  lineHeight: z.number().default(1.2),
  letterSpacing: z.number().default(0),
  padding: z.number().default(0),
  outline: z.object({ width: z.number(), color: Rgba }).optional(),
  shadow: z.object({ dx: z.number(), dy: z.number(), blur: z.number(), color: Rgba }).optional(),
  fill: z.object({ color: Rgba, radius: z.number().default(0) }).optional(),
});
export type TextStyle = z.infer<typeof TextStyle>;

export const TextObject = z.object({
  id: Id,
  type: z.literal('text'),
  box: Box,
  text: z.string(),
  style: TextStyle,
  opacity: z.number().default(1),
});
export type TextObject = z.infer<typeof TextObject>;

export const ImageObject = z.object({
  id: Id,
  type: z.literal('image'),
  box: Box,
  mediaId: Id,
  fit: z.enum(['contain', 'cover', 'stretch']).default('contain'),
  opacity: z.number().default(1),
  radius: z.number().default(0),
});
export type ImageObject = z.infer<typeof ImageObject>;

export const ShapeObject = z.object({
  id: Id,
  type: z.literal('shape'),
  box: Box,
  shape: z.enum(['rect', 'ellipse', 'line']),
  fill: Rgba.optional(),
  stroke: z.object({ width: z.number(), color: Rgba }).optional(),
  opacity: z.number().default(1),
  radius: z.number().default(0),
});
export type ShapeObject = z.infer<typeof ShapeObject>;

export const SlideObject = z.discriminatedUnion('type', [TextObject, ImageObject, ShapeObject]);
export type SlideObject = z.infer<typeof SlideObject>;

export const ExtractedText = z.object({ text: z.string(), box: Box, fontSizePx: z.number().optional() });
export type ExtractedText = z.infer<typeof ExtractedText>;

export const ScriptureRef = z.object({
  translation: z.string(),
  book: z.string(),
  chapter: z.number().int(),
  verseFrom: z.number().int(),
  verseTo: z.number().int().optional(),
});
export type ScriptureRef = z.infer<typeof ScriptureRef>;

export const ScriptureSlideSource = z.object({
  ref: ScriptureRef,
  text: z.string(),
  fetchedAt: z.string(),
  provider: z.string(),
});
export type ScriptureSlideSource = z.infer<typeof ScriptureSlideSource>;

export const Slide = z.object({
  id: Id,
  objects: z.array(SlideObject).default([]),
  lyricObjectId: Id.optional(),
  backgroundMediaId: Id.optional(),
  durationMs: z.number().optional(),
  notes: z.string().optional(),
  overrides: z.array(z.string()).optional(),
  imported: z
    .object({
      fileId: Id,
      page: z.number().int(),
      imageMediaId: Id,
      textBoxes: z.array(ExtractedText).optional(),
    })
    .optional(),
  scripture: ScriptureSlideSource.optional(),
});
export type Slide = z.infer<typeof Slide>;

export const Section = z.object({
  id: Id,
  label: z.string(),
  short: z.string(),
  slides: z.array(Slide).default([]),
  /** Chords per lyric line, kept from ChordPro imports for a future chord view. */
  chords: z.array(z.string()).optional(),
});
export type Section = z.infer<typeof Section>;

export const Arrangement = z.object({ id: Id, name: z.string(), sectionIds: z.array(Id) });
export type Arrangement = z.infer<typeof Arrangement>;

export const Transition = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cut') }),
  z.object({ kind: z.literal('crossfade'), ms: z.number().min(0).max(10000) }),
]);
export type Transition = z.infer<typeof Transition>;

export const PresentationKind = z.enum(['song', 'slides', 'loop']);
export type PresentationKind = z.infer<typeof PresentationKind>;

export const Presentation = z.object({
  id: Id,
  rev: z.number().int().default(1),
  title: z.string(),
  kind: PresentationKind,
  meta: z
    .object({
      author: z.string().optional(),
      ccli: z.string().optional(),
      copyright: z.string().optional(),
      key: z.string().optional(),
      tempo: z.number().optional(),
      tags: z.array(z.string()).default([]),
    })
    .default({ tags: [] }),
  folderId: Id.optional(),
  themeId: Id.optional(),
  backgroundMediaId: Id.optional(),
  transition: Transition.optional(),
  sections: z.array(Section).default([]),
  arrangements: z.array(Arrangement).default([]),
  loop: z.object({ defaultSlideMs: z.number() }).optional(),
  linesPerSlide: z.number().int().min(1).max(12).optional(),
  source: z
    .object({
      kind: z.enum(['pro7', 'songselect', 'pptx', 'pdf', 'manual', 'paste']),
      fileId: Id.optional(),
      log: z.string().optional(),
    })
    .optional(),
  archived: z.boolean().default(false),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Presentation = z.infer<typeof Presentation>;

export const Theme = z.object({
  id: Id,
  name: z.string(),
  lyricBox: Box,
  text: TextStyle,
  textBoxDefaults: TextStyle,
});
export type Theme = z.infer<typeof Theme>;

export const FileRef = z.object({
  hash: z.string(),
  bytes: z.number().int(),
  mime: z.string(),
  path: z.string(),
});
export type FileRef = z.infer<typeof FileRef>;

export const MediaKind = z.enum(['video', 'image', 'audio']);
export type MediaKind = z.infer<typeof MediaKind>;

export const Media = z.object({
  id: Id,
  rev: z.number().int().default(1),
  name: z.string(),
  tags: z.array(z.string()).default([]),
  kind: MediaKind,
  original: FileRef,
  delivery: FileRef.optional(),
  poster: FileRef.optional(),
  state: z.enum(['uploaded', 'processing', 'ready', 'failed']),
  error: z.string().optional(),
  durationMs: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  hasAlpha: z.boolean().optional(),
  loop: z.boolean().default(false),
  isBackground: z.boolean().default(false),
  audio: z
    .object({ pairId: Id.optional(), gainDb: z.number().default(0), loudnessLufs: z.number().optional() })
    .optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Media = z.infer<typeof Media>;

export const Font = z.object({
  id: Id,
  family: z.string(),
  weight: z.number(),
  style: z.enum(['normal', 'italic']),
  file: FileRef,
  source: z.enum(['upload', 'google', 'bundled']),
});
export type Font = z.infer<typeof Font>;

export const TimerSpec = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('countdownTo'),
    /** HH:MM in the venue's time zone. */
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/),
    label: z.string().optional(),
  }),
  z.object({ kind: z.literal('elapsed'), label: z.string().optional() }),
]);
export type TimerSpec = z.infer<typeof TimerSpec>;

export const ActionId = z.enum([
  'go',
  'next',
  'prev',
  'nextItem',
  'prevItem',
  'goToSection',
  'goToSlide',
  'clearSlide',
  'clearAll',
  'clearLowerThird',
  'clearProps',
  'clearMedia',
  'clearBackground',
  'logo',
  'mediaPlayPause',
  'mediaRestart',
  'timerStart',
  'timerStop',
  'timerReset',
  'messagePreset',
  'messageDismiss',
  'audioMute',
  'audioMasterUp',
  'audioMasterDown',
  'audioFadeOut',
  'launchOutputs',
  'relaunchOutputs',
]);
export type ActionId = z.infer<typeof ActionId>;

export const MediaOnEnd = z.enum(['hold', 'black', 'advance']);
export type MediaOnEnd = z.infer<typeof MediaOnEnd>;

export const PlaylistItem = z.discriminatedUnion('kind', [
  z.object({
    id: Id,
    kind: z.literal('presentation'),
    presentationId: Id,
    arrangementId: Id.optional(),
    transition: Transition.optional(),
    backgroundMediaId: Id.optional(),
  }),
  z.object({
    id: Id,
    kind: z.literal('media'),
    mediaId: Id,
    loop: z.boolean().optional(),
    onEnd: MediaOnEnd.optional(),
    audio: z.object({ pairId: Id.optional(), gainDb: z.number().optional() }).optional(),
  }),
  z.object({ id: Id, kind: z.literal('timer'), timer: TimerSpec }),
  z.object({ id: Id, kind: z.literal('action'), action: ActionId }),
]);
export type PlaylistItem = z.infer<typeof PlaylistItem>;

export const Playlist = z.object({
  id: Id,
  rev: z.number().int().default(1),
  name: z.string(),
  serviceDate: z.string().optional(),
  items: z.array(PlaylistItem).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type Playlist = z.infer<typeof Playlist>;

export const LayerName = z.enum(['background', 'slide', 'lowerThird', 'media', 'props']);
export type LayerName = z.infer<typeof LayerName>;
export const LAYER_ORDER: readonly LayerName[] = ['background', 'slide', 'lowerThird', 'media', 'props'];

export const LayerRule = z.object({ visible: z.boolean() });
export type LayerRule = z.infer<typeof LayerRule>;

export const SlideRule = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('authored') }),
  z.object({
    mode: z.literal('lyricOnly'),
    style: TextStyle,
    band: Box,
    nextSlide: z.object({ style: TextStyle, band: Box }).optional(),
    nonSong: z.enum(['text', 'none']).default('text'),
  }),
  z.object({ mode: z.literal('hidden') }),
]);
export type SlideRule = z.infer<typeof SlideRule>;

export const PropBox = TextStyle.extend({ box: Box });
export type PropBox = z.infer<typeof PropBox>;

export const PropsRule = z.object({
  logo: z.boolean().default(false),
  countdown: z.boolean().default(false),
  clock: z.boolean().default(false),
  messages: z.boolean().default(false),
  elapsed: z.boolean().default(false),
  style: z.record(z.string(), PropBox).default({}),
});
export type PropsRule = z.infer<typeof PropsRule>;

export const Look = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(['main', 'stage', 'lowerThird', 'stream', 'custom']).default('custom'),
  layers: z.object({
    background: LayerRule,
    slide: SlideRule,
    lowerThird: LayerRule,
    media: LayerRule,
    props: PropsRule,
  }),
  /** Fill drawn under everything: black, or the key colour for the stream look. */
  clearColor: Rgba,
  /** Optional holding slide image shown when the background layer is hidden (lobby). */
  holdingMediaId: Id.optional(),
  transition: Transition,
});
export type Look = z.infer<typeof Look>;

export const ScreenRef = z.object({
  label: z.string(),
  left: z.number(),
  top: z.number(),
  width: z.number(),
  height: z.number(),
});
export type ScreenRef = z.infer<typeof ScreenRef>;

export const OutputKind = z.enum(['output', 'stage']);
export const Output = z.object({
  id: Id,
  name: z.string(),
  kind: OutputKind.default('output'),
  /** out<k> hostname index; 0 for stage. */
  hostIndex: z.number().int().min(0).max(6),
  lookId: Id,
  screen: ScreenRef.optional(),
  enabled: z.boolean().default(true),
  audioMaster: z.boolean().default(false),
  /** Plain token is only returned to the operate role; stored hashed at rest is not required for the prototype. */
  token: z.string().optional(),
});
export type Output = z.infer<typeof Output>;

export const AudioPair = z.object({
  id: Id,
  name: z.string(),
  left: z.number().int(),
  right: z.number().int(),
});
export type AudioPair = z.infer<typeof AudioPair>;

export const AudioSettings = z.object({
  houseDeviceId: z.string().optional(),
  houseDeviceLabel: z.string().optional(),
  previewDeviceId: z.string().optional(),
  previewDeviceLabel: z.string().optional(),
  pairs: z.array(AudioPair).default([]),
  defaultPairId: Id.optional(),
  masterDb: z.number().default(0),
});
export type AudioSettings = z.infer<typeof AudioSettings>;

export const KeyMap = z.record(
  z.string(),
  z.object({ id: ActionId, arg: z.union([z.number(), z.string()]).optional() }),
);
export type KeyMap = z.infer<typeof KeyMap>;

export const StreamDeckKey = z.object({
  action: z.object({ id: ActionId, arg: z.union([z.number(), z.string()]).optional() }).optional(),
  /** Dynamic keys bind to live state instead of a fixed action. */
  dynamic: z.enum(['section', 'nextItem']).optional(),
  dynamicIndex: z.number().int().optional(),
  label: z.string().optional(),
  color: z.string().optional(),
});
export type StreamDeckKey = z.infer<typeof StreamDeckKey>;

export const StreamDeckPage = z.object({ name: z.string(), keys: z.record(z.string(), StreamDeckKey) });
export type StreamDeckPage = z.infer<typeof StreamDeckPage>;

export const MidiMapping = z.object({
  id: Id,
  deviceName: z.string().optional(),
  kind: z.enum(['note', 'cc']),
  number: z.number().int().min(0).max(127),
  channel: z.number().int().min(1).max(16).optional(),
  threshold: z.number().int().min(0).max(127).default(64),
  action: z.object({ id: ActionId, arg: z.union([z.number(), z.string()]).optional() }),
});
export type MidiMapping = z.infer<typeof MidiMapping>;

export const SurfaceSettings = z.object({
  streamDeckPages: z.array(StreamDeckPage).default([]),
  midi: z.array(MidiMapping).default([]),
  messagePresets: z.array(z.string()).default([]),
});
export type SurfaceSettings = z.infer<typeof SurfaceSettings>;

export const GeneralSettings = z.object({
  venueName: z.string().default('ordo'),
  timeZone: z.string().default('UTC'),
  clock24h: z.boolean().default(false),
  logoMediaId: Id.optional(),
  defaultThemeId: Id.optional(),
  defaultLinesPerSlide: z.number().int().default(2),
  defaultPreRollMs: z.number().int().default(33),
});
export type GeneralSettings = z.infer<typeof GeneralSettings>;
