import { z } from 'zod';
import {
  type ActionId,
  ContentHash,
  FileRef,
  Font,
  Id,
  Look,
  Media,
  type MediaOnEnd,
  type MidiCue,
  MidiPreset,
  Playlist,
  Presentation,
  TimerSpec,
  type Transition,
} from './schemas.ts';

/** A resolved MIDI cue carried on a flattened Cue, optionally annotated with its venue preset name. */
export type ResolvedMidiCue = MidiCue & { presetName?: string };

/** The sizes a screen fetches of a pre-rendered slide's picture (design/29 §1.2, §1.7): 4K, and the 1080p copy. */
export const PrerenderSize = z.union([z.literal(3840), z.literal(1920)]);
export type PrerenderSize = z.infer<typeof PrerenderSize>;

/**
 * A pre-rendered slide's picture file (design/29 §1.7): which slide it is of, its key (the variant without
 * backdrops has a key of its own), its size and its content-store file. What goLive lists and `prerender.add`
 * announces; outputs never compute keys.
 */
export const PrerenderPicture = z.object({
  presentationId: Id,
  slideId: Id,
  key: ContentHash,
  size: PrerenderSize,
  file: ContentHash,
});
export type PrerenderPicture = z.infer<typeof PrerenderPicture>;

/** At most this many pictures and keys a goLive carries. */
export const PRERENDERS_MAX = 20_000;
/**
 * At most this many pictures `state.prerendered` keeps (the go-live bake's, newest last): two sizes of the
 * slides of a long service. Past it the oldest go; their slides are drawn live, never cut.
 */
export const PRERENDERED_MAX = 4_096;
/** At most this many slides `state.drawOverride` keeps ("Use the picture during this service"). */
export const DRAW_OVERRIDE_MAX = 1_000;

/** One entry of the service cache manifest. Content addressed by sha256. */
export const ManifestFile = z.object({ hash: z.string(), bytes: z.number().int(), mime: z.string() });
export type ManifestFile = z.infer<typeof ManifestFile>;

/**
 * The frozen copy of a playlist made live, with everything an output needs to render any cue
 * without asking the hub again.
 */
export const ResolvedPlaylist = z.object({
  playlist: Playlist,
  presentations: z.record(z.string(), Presentation),
  media: z.record(z.string(), Media),
  fonts: z.array(Font),
  looks: z.array(Look),
  /** Snapshot of venue MIDI presets at goLive so live services are immune to mid-week preset edits. */
  midiPresets: z.array(MidiPreset).max(64).optional(),
  logoMediaId: Id.optional(),
  files: z.array(ManifestFile),
  /**
   * The content-store files the slides draw besides media and fonts: geometry and decoration files
   * (`drawnShapeFileRefs`, design/27 §3.1 `ShapeGeom.ref`) and pre-rendered slides' pictures, heads and pages
   * (design/29 §1.7), in cue order. Their hashes are in `files` too, so outputs cache them with the pictures;
   * the live process serves them from here while the library is down. Absent when no slide draws one.
   */
  geoms: z.array(FileRef).max(100_000).optional(),
  /**
   * design/29 §1.7: the pictures of the service's pre-rendered slides the hub has, the newest per slide, variant
   * and size; `standby` marks one found by its stand-by id (an older renderer or font set, W39). Their files are
   * in `files` (and `geoms`, for the live process) in cue order. Absent when there are none.
   */
  prerenders: z
    .array(PrerenderPicture.extend({ standby: z.boolean().optional() }))
    .max(PRERENDERS_MAX)
    .optional(),
  /**
   * design/29 §1.3: the picture keys of the service's presentations (the hub's `prerender_keys`): the live
   * process accepts `prerender.add` only for one of them. Absent when there are none.
   */
  prerenderKeys: z.array(ContentHash).max(PRERENDERS_MAX).optional(),
  manifestId: z.string(),
  /**
   * Content that failed validation at goLive and was quarantined (design/25): a bad slide is replaced by an
   * empty slide, a damaged presentation is reset. One entry per affected cue; `cueIndex` is -1 when the bad
   * content produced no cue (a skipped playlist item, an unreadable presentation). Absent when all is well.
   */
  degraded: z
    .array(
      z.object({
        cueIndex: z.number().int().min(-1),
        reason: z.string().max(500),
        presentationId: Id.optional(),
        slideId: Id.optional(),
      }),
    )
    .max(1000)
    .optional(),
});
export type ResolvedPlaylist = z.infer<typeof ResolvedPlaylist>;

export type CueKind = 'slide' | 'media' | 'timer' | 'action';

/** A flat, ordered position the operator can go to. Produced by expandCues. */
export type Cue = {
  index: number;
  itemId: Id;
  itemIndex: number;
  kind: CueKind;
  label: string;
  presentationId?: Id;
  sectionId?: Id;
  sectionLabel?: string;
  sectionShort?: string;
  /** Index of this section occurrence within the arrangement (a repeated chorus has distinct indices). */
  arrangementPos?: number;
  slideId?: Id;
  slideIndexInSection?: number;
  backgroundMediaId?: Id;
  /**
   * `backgroundMediaId` is the playlist item's Background override (the slide has no background picture of
   * its own): the slide is drawn without its backdrops (`withoutBackdrops`: the imported solid or gradient
   * background under its objects, a ProPresenter slide's or presentation's colour), so the override shows.
   */
  backgroundOverride?: true;
  /** The slide clears the running background (only when it has none of its own). */
  clearBackground?: boolean;
  /**
   * The slide has no background (its own, its item's or its presentation's) and its item does not keep the
   * running one: a GO that enters the item on this cue clears the running background. Moving within the
   * item does not.
   */
  clearOnEntry?: boolean;
  transition?: Transition;
  mediaId?: Id;
  mediaKind?: 'video' | 'image' | 'audio';
  loop?: boolean;
  onEnd?: z.infer<typeof MediaOnEnd>;
  audio?: { pairId?: Id; gainDb?: number };
  /**
   * A timer cue's timer, or on every slide cue of an item its countdown (`PlaylistItem.countdownTimer`),
   * started by the GO that enters the item, whichever cue that is.
   */
  timerId?: Id;
  timer?: TimerSpec;
  action?: ActionId;
  /** Loop presentations auto-advance after this many ms. */
  autoAdvanceMs?: number;
  /**
   * A hidden PowerPoint slide (design/27 §9): Next, Prev, the cue a GO arms, auto-advance, onEnd 'advance',
   * Next item and Previous item skip it; a GO with its index shows it. Only ever `true` on a slide cue.
   */
  hidden?: boolean;
  /*
   * A slide cue's own media (design/27 §3.3, §8), set by expandCues only for media in `resolved.media`.
   * The playing video also fills mediaId, mediaKind 'video', loop, onEnd and audio above.
   */
  /** The ImageObject that plays `mediaId` in its box. */
  mediaObjectId?: string;
  mediaStart?: 'auto' | 'click';
  mediaShowWhenStopped?: boolean;
  /** The slide's sound; it plays on until the live cue leaves [this cue, untilCue]. */
  slideAudio?: { mediaId: string; start: 'auto' | 'click'; loop: boolean; gainDb?: number; untilCue: number };
  /** Outgoing MIDI cues fired when this slide's background media becomes active (e.g. stage color). */
  backgroundMidi?: ResolvedMidiCue[];
  /** Outgoing MIDI cues fired once when entering this playlist item. */
  itemMidi?: ResolvedMidiCue[];
  /** Outgoing MIDI cues fired once when entering this section occurrence (repeats included). */
  sectionMidi?: ResolvedMidiCue[];
  /** Outgoing MIDI cues fired when landing on this specific slide cue. */
  midiCues?: ResolvedMidiCue[];
};

export type SlideContent = { kind: 'slide'; cueIndex: number; presentationId: Id; slideId: Id };
export type BackgroundContent = { kind: 'background'; mediaId: Id };
export type MediaContent = {
  kind: 'media';
  cueIndex: number;
  mediaId: Id;
  mediaKind: 'video' | 'image';
  loop: boolean;
  onEnd: 'hold' | 'black' | 'advance';
  state: 'playing' | 'paused' | 'ended';
  /** Hub ms at which position 0 played (for playing) */
  startedAt: number;
  /** Position in ms when paused or ended. */
  positionMs: number;
  /** A slide cue's video: the ImageObject of slide `cueIndex` it plays in (design/27 §7.2). */
  objectId?: string;
};
export type LowerThirdContent = { kind: 'lowerThird'; text: string };
export type AudioContent = {
  cueIndex: number;
  mediaId: Id;
  loop: boolean;
  state: 'playing' | 'paused' | 'ended';
  startedAt: number;
  positionMs: number;
  pairId?: Id;
  gainDb?: number;
  /** A slide's own sound (design/27 §8): cleared once the live cue leaves [cueIndex, untilCue]. */
  slideOwned?: boolean;
  untilCue?: number;
};

/** A layer always exists; `at` is the hub time its current content (or emptiness) takes effect. */
export type LayerState<T> = { content: T | null; at: number; seq: number; transition?: Transition };

export type Timer = {
  id: Id;
  spec: TimerSpec;
  running: boolean;
  startedAt?: number;
  /** For elapsed timers that were stopped: the frozen elapsed value. */
  elapsedMs?: number;
};

export type StageMessage = { id: Id; text: string; sentAt: number; expiresAt?: number };

export type PropsState = { logo: boolean; countdownTimerId?: Id; at: number; seq: number };

export type LiveState = {
  seq: number;
  mode: 'idle' | 'live';
  resolved?: ResolvedPlaylist;
  cues: Cue[];
  live?: number;
  armed?: number;
  layers: {
    background: LayerState<BackgroundContent>;
    slide: LayerState<SlideContent>;
    lowerThird: LayerState<LowerThirdContent>;
    media: LayerState<MediaContent>;
  };
  props: PropsState;
  audio: LayerState<AudioContent>;
  timers: Record<Id, Timer>;
  messages: StageMessage[];
  /** Set on clear-all; outputs fade audio and draw clear colour. */
  black: boolean;
  /**
   * design/29 §1.7: pictures the go-live bake made during the service (`prerender.add`, the hub's), newest last,
   * at most `PRERENDERED_MAX`; `resolved` stays as it went live. Absent until the first; cleared at End service.
   */
  prerendered?: PrerenderPicture[];
  /**
   * design/29 §1.7: slides set to Live that draw from their picture for this service (`prerender.use`, the
   * operator's "Use the picture for this slide during this service"), at most `DRAW_OVERRIDE_MAX`. The
   * presentation (locked while live) is unchanged; cleared at End service.
   */
  drawOverride?: { presentationId: Id; slideId: Id }[];
};

/** Hub ms; clients derive it from a clock-offset estimate, so it need not be an integer. */
const at = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
/** Cue positions are small; the hub also rejects indices beyond the live cue list. */
const cueIndex = z.number().int().min(0).max(1_000_000);
const sectionIndex = z.number().int().min(0).max(100_000);
/** Stage message lifetime: at most a day. */
const ttlMs = z.number().int().min(0).max(86_400_000);

/**
 * Events applied by the reducer. All times are hub ms carried in the event (the reducer never reads a
 * clock). Every variant is strict: unknown keys are rejected rather than silently stripped, so a client
 * on a newer protocol cannot smuggle fields the hub does not validate.
 */
const CLIENT_EVENTS = [
  z.object({ k: z.literal('goLive'), resolved: ResolvedPlaylist }).strict(),
  z.object({ k: z.literal('endService'), at }).strict(),
  z.object({ k: z.literal('select'), cueIndex }).strict(),
  z.object({ k: z.literal('go'), cueIndex, at }).strict(),
  z.object({ k: z.literal('next'), at }).strict(),
  z.object({ k: z.literal('prev'), at }).strict(),
  z.object({ k: z.literal('nextItem'), at }).strict(),
  z.object({ k: z.literal('prevItem'), at }).strict(),
  z.object({ k: z.literal('goToSection'), sectionIndex, at }).strict(),
  z
    .object({
      k: z.literal('clear'),
      layer: z.enum(['slide', 'lowerThird', 'props', 'media', 'background', 'audio', 'all']),
      at,
    })
    .strict(),
  z.object({ k: z.literal('logo'), at }).strict(),
  z.object({ k: z.literal('lowerThird'), text: z.string().max(2000), at }).strict(),
  z.object({ k: z.literal('media.play'), at }).strict(),
  z.object({ k: z.literal('media.pause'), at }).strict(),
  z.object({ k: z.literal('media.restart'), at }).strict(),
  z.object({ k: z.literal('media.ended'), cueIndex, at }).strict(),
  z.object({ k: z.literal('audio.stop'), at }).strict(),
  z.object({ k: z.literal('audio.ended'), cueIndex, at }).strict(),
  z.object({ k: z.literal('timer.start'), timerId: Id, spec: TimerSpec.optional(), at }).strict(),
  z.object({ k: z.literal('timer.stop'), timerId: Id, at }).strict(),
  z.object({ k: z.literal('timer.reset'), timerId: Id, at }).strict(),
  z
    .object({
      k: z.literal('message.send'),
      id: Id,
      text: z.string().max(500),
      ttlMs: ttlMs.optional(),
      at,
    })
    .strict(),
  z.object({ k: z.literal('message.dismiss'), id: Id }).strict(),
  z.object({ k: z.literal('message.clear') }).strict(),
  /** design/29 §1.7: the operator's "Use the picture for this slide during this service" (operate role). */
  z.object({ k: z.literal('prerender.use'), presentationId: Id, slideId: Id }).strict(),
] as const;
/**
 * design/29 §1.7, §1.11: a picture of a key of the live service the hub accepted during it (the go-live bake).
 * Applied by the hub only (`LiveService.apply`): `LiveCommand` leaves it out, so no socket can send one.
 */
const PrerenderAdd = PrerenderPicture.extend({ k: z.literal('prerender.add') }).strict();
export const LiveEvent = z.discriminatedUnion('k', [...CLIENT_EVENTS, PrerenderAdd]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/**
 * Commands the operator submits. Identical to events except goLive, which carries only the playlist id (the
 * hub resolves it into a goLive event; a client-sent goLive with `resolved` is rejected by the hub), and
 * `prerender.add`, which only the hub applies (design/29 §1.11): a protocol `live.event` or a POST /live/events
 * carrying it is refused at its parse.
 */
export const GoLiveCommand = z.object({ k: z.literal('goLive'), playlistId: Id }).strict();
export const LiveCommand = z.union([GoLiveCommand, z.discriminatedUnion('k', [...CLIENT_EVENTS])]);
export type LiveCommand =
  | Exclude<LiveEvent, { k: 'goLive' | 'prerender.add' }>
  | z.infer<typeof GoLiveCommand>;

export const MANUAL_ELAPSED_TIMER_ID = 'manual-elapsed';
export const SERVICE_COUNTDOWN_TIMER_ID = 'service-countdown';
