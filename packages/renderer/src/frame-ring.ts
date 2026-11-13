import { MAX_VIDEO_SLOTS, type VideoFrames } from './compositor.ts';

/**
 * Video frame selection (design/27 §7.2 "Frame selection", design/14 "Video playback").
 *
 * The host posts every frame its element presents (`vframe`, from requestVideoFrameCallback), tagged with
 * the slot's load generation and, while the element plays, the clock it plays by: the hub time of media
 * time 0 (the transport's `startedAt`) and the clip length when it loops. Each slot keeps its two newest
 * frames. Before each draw the engine presents, per slot, the newest frame whose timestamp is at or before
 * the media time due on the vsync being drawn, `hubNow + frameMs/2 - startedAt` (the half-frame rule of
 * `flipDue`), taken modulo the length when looping. An element running slightly ahead of hub time is held
 * back to the hub's frame, one running behind shows its newest frame (older, late frames are never shown),
 * and every output presents the same frame on the same vsync within the element's own sync.
 *
 * The newest frame is presented whenever the clock cannot time it: no clock (paused, ended, not started),
 * one frame only, or a newest frame further than FRAME_SYNC_WINDOW_MS from the expected time (a seek or a
 * restart the clock has not caught up with). The older frame is presented only when it comes before the
 * newest in media time and lies within that window, so a frame from before a seek or a reload never shows.
 *
 * Frames are closed when a newer one evicts them, when a frame of another generation arrives (a reloaded
 * slot), when the slot is cleared (`vclear`) and on `release`: never while presented, since every close is
 * followed at once by a new selection. The selection writes `VideoFrames` (the compositors' input) in place.
 */

/** Frames kept per slot. */
export const FRAME_RING_DEPTH = 2;

/**
 * How far (ms) a frame may be from the expected media time and still be timed by the clock. Further away,
 * the clock does not describe what the element shows, and the newest frame is presented. The host seeks an
 * element that is more than 250 ms off its transport (media.ts `apply`), so a synced clip stays inside.
 */
export const FRAME_SYNC_WINDOW_MS = 250;

/** A media time difference (ms), wrapped into [-loopMs/2, loopMs/2) for a clip that loops (loopMs > 0). */
export function mediaLag(d: number, loopMs: number): number {
  /* @hot */
  if (loopMs > 0) return d - loopMs * Math.round(d / loopMs);
  return d;
}

/** The clock fields of a `vframe`: present only while the element plays (design/27 §7.2). */
export type VFrameClock = { startedAt?: number; loopMs?: number };

/**
 * The clock a frame of `el` is presented by. `startedAt` is the hub time of media time 0 of the transport
 * the slot plays (NaN when its transport is not 'playing'); a paused element, or one waiting for its start
 * time, sends no clock and its newest frame shows.
 */
export function vframeClock(
  el: { paused: boolean; loop: boolean; duration: number },
  startedAt: number,
): VFrameClock {
  if (el.paused || !Number.isFinite(startedAt)) return {};
  const dur = el.duration;
  if (el.loop && Number.isFinite(dur) && dur > 0) return { startedAt, loopMs: dur * 1000 };
  return { startedAt };
}

/** The two newest frames of each media slot and the choice among them (see the module comment). */
export class FrameRing {
  /** Held frames, `slot * FRAME_RING_DEPTH + i`. */
  private readonly held: (VideoFrame | null)[] = [];
  /** Media timestamp (ms) of each held frame. */
  private readonly ts = new Float64Array(MAX_VIDEO_SLOTS * FRAME_RING_DEPTH);
  /** Per slot: index (0, 1) of its newest frame, and how many frames it holds. */
  private readonly newest = new Int32Array(MAX_VIDEO_SLOTS);
  private readonly count = new Int32Array(MAX_VIDEO_SLOTS);
  /** Per slot: the load generation of the frames it holds (one per slot; -1 none). */
  private readonly ringGen = new Int32Array(MAX_VIDEO_SLOTS).fill(-1);
  /** Per slot: hub time of media time 0 while it plays (NaN: no clock), and its loop length (0: none). */
  private readonly startedAt = new Float64Array(MAX_VIDEO_SLOTS).fill(Number.NaN);
  private readonly loopMs = new Float64Array(MAX_VIDEO_SLOTS);

  readonly out: VideoFrames;
  constructor(out: VideoFrames) {
    this.out = out;
    for (let i = 0; i < MAX_VIDEO_SLOTS * FRAME_RING_DEPTH; i++) this.held.push(null);
  }

  /** Frames held now, across all slots (at most FRAME_RING_DEPTH per slot). */
  get size(): number {
    let n = 0;
    for (let s = 0; s < MAX_VIDEO_SLOTS; s++) n += this.count[s]!;
    return n;
  }

  /**
   * Take a frame of `slot` loaded under `gen`, with the clock of its `vframe` (`startedAt` NaN: none), and
   * present the slot's frame for hub time `now`. Takes ownership: the frame is closed here or later.
   */
  push(
    slot: number,
    frame: VideoFrame,
    gen: number,
    startedAt: number,
    loopMs: number,
    now: number,
    frameMs: number,
  ): void {
    if (!(slot >= 0 && slot < MAX_VIDEO_SLOTS && Number.isInteger(slot))) {
      frame.close();
      return;
    }
    const b = slot * FRAME_RING_DEPTH;
    const c = this.count[slot]!;
    // Another generation: the slot was reloaded with another clip; its earlier frames go at once.
    if (c > 0 && this.ringGen[slot] !== gen) this.drop(slot, frame);
    const n = this.newest[slot]!;
    if (this.count[slot]! === 0) {
      this.held[b] = frame;
      this.ts[b] = frame.timestamp / 1000;
      this.newest[slot] = 0;
      this.count[slot] = 1;
    } else if (this.held[b + n] !== frame) {
      // The older frame makes room (it is re-selected below, so it is never presented once closed).
      const i = 1 - n;
      const old = this.held[b + i];
      if (old && old !== frame) old.close();
      this.held[b + i] = frame;
      this.ts[b + i] = frame.timestamp / 1000;
      this.newest[slot] = i;
      this.count[slot] = FRAME_RING_DEPTH;
    }
    this.ringGen[slot] = gen;
    this.startedAt[slot] = Number.isFinite(startedAt) ? startedAt : Number.NaN;
    this.loopMs[slot] = Number.isFinite(loopMs) && loopMs > 0 ? loopMs : 0;
    this.selectSlot(slot, now, frameMs);
  }

  /** Close the slot's frames and present nothing for it (`vclear`). */
  clear(slot: number): void {
    if (!(slot >= 0 && slot < MAX_VIDEO_SLOTS && Number.isInteger(slot))) return;
    this.drop(slot, null);
    this.present(slot, null);
  }

  /** Close every held frame (the engine stops). */
  release(): void {
    for (let s = 0; s < MAX_VIDEO_SLOTS; s++) this.clear(s);
  }

  /** Present each slot's frame for the frame drawn at hub time `now`; once per frame, before drawing. */
  select(now: number, frameMs: number): void {
    /* @hot */
    // A slot with one frame or none presents it from `push`/`clear`; only a pair can change with time.
    for (let s = 0; s < MAX_VIDEO_SLOTS; s++) if (this.count[s]! > 1) this.selectSlot(s, now, frameMs);
  }

  private selectSlot(slot: number, now: number, frameMs: number): void {
    /* @hot */
    const b = slot * FRAME_RING_DEPTH;
    const c = this.count[slot]!;
    if (c === 0) {
      this.present(slot, null);
      return;
    }
    const n = b + this.newest[slot]!;
    let pick = n;
    const at = this.startedAt[slot]!;
    if (c > 1 && !Number.isNaN(at)) {
      // The media time due on the vsync this frame is shown at.
      const due = now + frameMs / 2 - at;
      const loop = this.loopMs[slot]!;
      const dn = mediaLag(due - this.ts[n]!, loop);
      // The newest frame is a little early: the older one shows until it is due, if it comes before it.
      if (dn < 0 && dn >= -FRAME_SYNC_WINDOW_MS) {
        const o = b + 1 - this.newest[slot]!;
        const dOld = mediaLag(due - this.ts[o]!, loop);
        if (dOld > dn && dOld <= FRAME_SYNC_WINDOW_MS) pick = o;
      }
    }
    this.present(slot, this.held[pick] ?? null);
  }

  private present(slot: number, frame: VideoFrame | null): void {
    /* @hot */
    const out = this.out;
    out.gen[slot] = frame ? this.ringGen[slot]! : -1;
    if (out.frames[slot] === frame) return;
    out.frames[slot] = frame;
    out.version[slot]!++;
  }

  /** Close the slot's frames (except `keep`) and forget them and its clock; presents nothing new. */
  private drop(slot: number, keep: VideoFrame | null): void {
    const b = slot * FRAME_RING_DEPTH;
    for (let i = 0; i < FRAME_RING_DEPTH; i++) {
      const f = this.held[b + i];
      if (f && f !== keep) f.close();
      this.held[b + i] = null;
    }
    this.count[slot] = 0;
    this.newest[slot] = 0;
    this.ringGen[slot] = -1;
    this.startedAt[slot] = Number.NaN;
    this.loopMs[slot] = 0;
  }
}
