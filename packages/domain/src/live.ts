import { z } from 'zod';
import {
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
  manifestId: z.string(),
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

const at = z.number();

/** Events applied by the reducer. All times are hub ms carried in the event (the reducer never reads a clock). */
export const LiveEvent = z.discriminatedUnion('k', [
  z.object({ k: z.literal('goLive'), resolved: ResolvedPlaylist }),
  z.object({ k: z.literal('endService'), at }),
  z.object({ k: z.literal('select'), cueIndex: z.number().int() }),
  z.object({ k: z.literal('go'), cueIndex: z.number().int(), at }),
  z.object({ k: z.literal('next'), at }),
  z.object({ k: z.literal('prev'), at }),
  z.object({ k: z.literal('nextItem'), at }),
  z.object({ k: z.literal('prevItem'), at }),
  z.object({ k: z.literal('goToSection'), sectionIndex: z.number().int(), at }),
  z.object({
    k: z.literal('clear'),
    layer: z.enum(['slide', 'lowerThird', 'props', 'media', 'background', 'audio', 'all']),
    at,
  }),
  z.object({ k: z.literal('logo'), at }),
  z.object({ k: z.literal('lowerThird'), text: z.string(), at }),
  z.object({ k: z.literal('media.play'), at }),
  z.object({ k: z.literal('media.pause'), at }),
  z.object({ k: z.literal('media.restart'), at }),
  z.object({ k: z.literal('media.ended'), cueIndex: z.number().int(), at }),
  z.object({ k: z.literal('audio.stop'), at }),
  z.object({ k: z.literal('audio.ended'), cueIndex: z.number().int(), at }),
  z.object({ k: z.literal('timer.start'), timerId: Id, spec: TimerSpec.optional(), at }),
  z.object({ k: z.literal('timer.stop'), timerId: Id, at }),
  z.object({ k: z.literal('timer.reset'), timerId: Id, at }),
  z.object({
    k: z.literal('message.send'),
    id: Id,
    text: z.string().max(500),
    ttlMs: z.number().optional(),
    at,
  }),
  z.object({ k: z.literal('message.dismiss'), id: Id }),
  z.object({ k: z.literal('message.clear') }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/**
 * Commands the operator submits. Identical to events except goLive, which carries only the playlist id;
 * the hub resolves it into a goLive event. A client-sent goLive with `resolved` is rejected by the hub.
 */
export const GoLiveCommand = z.object({ k: z.literal('goLive'), playlistId: Id });
export const LiveCommand = z.union([GoLiveCommand, LiveEvent]);
export type LiveCommand = Exclude<LiveEvent, { k: 'goLive' }> | z.infer<typeof GoLiveCommand>;

export const MANUAL_ELAPSED_TIMER_ID = 'manual-elapsed';
export const SERVICE_COUNTDOWN_TIMER_ID = 'service-countdown';
