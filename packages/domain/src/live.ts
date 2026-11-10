import { z } from 'zod';
import {
  FileRef,
  Font,
  Id,
  Look,
  Media,
  type MediaOnEnd,
  Playlist,
  Presentation,
  TimerSpec,
  type Transition,
  type ActionId,
  type MidiCue,
} from './schemas.ts';

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
  logoMediaId: Id.optional(),
  files: z.array(ManifestFile),
  /**
   * The geometry files the slides draw (`drawnGeomRefs`, design/27 §3.1 `ShapeGeom.ref`): their hashes are
   * in `files` too, so outputs cache them with the pictures; the live process serves them from here while
   * the library is down. Absent when no slide draws one.
   */
  geoms: z.array(FileRef).max(100_000).optional(),
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
  /** The slide clears the running background (only when it has none of its own). */
  clearBackground?: boolean;
  transition?: Transition;
  mediaId?: Id;
  mediaKind?: 'video' | 'image' | 'audio';
  loop?: boolean;
  onEnd?: z.infer<typeof MediaOnEnd>;
  audio?: { pairId?: Id; gainDb?: number };
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
  /** Outgoing MIDI cues to fire when this cue goes live. */
  midiCues?: MidiCue[];
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
export const LiveEvent = z.discriminatedUnion('k', [
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
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/**
 * Commands the operator submits. Identical to events except goLive, which carries only the playlist id;
 * the hub resolves it into a goLive event. A client-sent goLive with `resolved` is rejected by the hub.
 */
export const GoLiveCommand = z.object({ k: z.literal('goLive'), playlistId: Id }).strict();
export const LiveCommand = z.union([GoLiveCommand, LiveEvent]);
export type LiveCommand = Exclude<LiveEvent, { k: 'goLive' }> | z.infer<typeof GoLiveCommand>;

export const MANUAL_ELAPSED_TIMER_ID = 'manual-elapsed';
export const SERVICE_COUNTDOWN_TIMER_ID = 'service-countdown';
