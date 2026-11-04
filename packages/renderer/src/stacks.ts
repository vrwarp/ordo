import { crossfadeWeight, flipDue, isLateFlip } from './timing.ts';

/** Render layers back to front. Indices are used in typed arrays and messages. */
export const LAYERS = ['background', 'slide', 'lowerThird', 'media', 'props'] as const;
export type RenderLayer = (typeof LAYERS)[number];
export const LAYER_INDEX: Record<RenderLayer, number> = {
  background: 0,
  slide: 1,
  lowerThird: 2,
  media: 3,
  props: 4,
};

/** What a stack draws. */
export const SRC_EMPTY = 0;
export const SRC_BITMAP = 1;
export const SRC_VIDEO = 2;

/** How a video is fitted to the frame (bitmaps are always full-frame). */
export const FIT_COVER = 0;
export const FIT_CONTAIN = 1;

/** Content offered to a layer: a prepared bitmap, a video slot, or nothing. */
export type StackContent<B> = {
  key: string;
  kind: number;
  bitmap?: B | null;
  videoSlot?: number;
  fit?: number;
  cueIndex?: number;
  /** Replace the held copy of this key in place (a re-draw with content that arrived late). */
  refresh?: boolean;
};

/** One fully prepared stack. Objects are pre-allocated and mutated in place. */
export class Stack<B> {
  key = '';
  kind = SRC_EMPTY;
  bitmap: B | null = null;
  videoSlot = -1;
  fit = FIT_COVER;
  cueIndex = -1;
  /** Bumped whenever the content changes so the compositor knows to re-upload. */
  version = 0;
}

/**
 * The two stacks (live and armed) of one layer, the pending flip and the crossfade between them.
 *
 * - `offer` places prepared content into the armed stack. While a crossfade is running the armed stack
 *   is the outgoing one, so the content waits in a one-deep queue until the fade ends (latest wins).
 * - `requestFlip` schedules a swap to `key` at hub time `at`. If the content for `key` is not there yet
 *   when `at` passes, the previous content is held and the flip happens on the first frame after it
 *   arrives (arm-then-flip ASAP).
 * - `tick` runs once per frame: ends finished fades, promotes queued content, performs due flips.
 */
export class LayerStack<B> {
  readonly stacks: [Stack<B>, Stack<B>] = [new Stack<B>(), new Stack<B>()];
  readonly queued = new Stack<B>();
  hasQueued = false;
  live = 0;
  fading = false;
  fadeStart = 0;
  fadeMs = 0;

  flipPending = false;
  flipKey = '';
  flipAt = 0;
  flipFadeMs = 0;
  flipRequestedAt = 0;

  lateFlips = 0;
  flips = 0;
  /** Set whenever held keys change; the owner reports and clears it outside the frame loop. */
  dirty = false;

  constructor(private release: (b: B) => void = () => undefined) {}

  get liveStack(): Stack<B> {
    return this.stacks[this.live]!;
  }

  get armedStack(): Stack<B> {
    return this.stacks[1 - this.live]!;
  }

  /** Keys this layer holds (live, armed, queued), for arm bookkeeping on the main thread. */
  heldKeys(): { live: string; armed: string; queued: string } {
    return {
      live: this.liveStack.key,
      armed: this.armedStack.key,
      queued: this.hasQueued ? this.queued.key : '',
    };
  }

  offer(c: StackContent<B>): void {
    if (c.key === this.liveStack.key && c.key !== '') {
      if (c.refresh) {
        // The live content drawn again (an image that arrived after the slide was armed): swap the copy
        // in place, no flip; a running fade keeps fading into the new copy.
        this.assign(this.liveStack, c);
        this.dirty = true;
        return;
      }
      if (!this.fading) {
        // Already live (a duplicate arm): refresh nothing, drop the copy.
        if (c.bitmap) this.release(c.bitmap);
        return;
      }
    }
    // The armed stack is busy when it is the outgoing side of a fade, or when it holds the content of a
    // scheduled flip that has not happened yet (the next cue's arm must not evict the GO target).
    const armedBusy =
      this.fading || (this.flipPending && this.armedStack.key === this.flipKey && c.key !== this.flipKey);
    if (armedBusy) {
      this.assign(this.queued, c);
      this.hasQueued = true;
    } else {
      this.assign(this.armedStack, c);
    }
    this.dirty = true;
  }

  requestFlip(key: string, at: number, fadeMs: number, now: number): void {
    if (key === this.liveStack.key && !this.flipPending) return;
    this.flipPending = true;
    this.flipKey = key;
    this.flipAt = at;
    this.flipFadeMs = fadeMs;
    this.flipRequestedAt = now;
  }

  /** Returns true if the layer flipped on this frame. */
  tick(now: number, frameMs: number): boolean {
    /* @hot */
    if (this.fading && now >= this.fadeStart + this.fadeMs) this.endFade();
    if (!this.flipPending || !flipDue(now, this.flipAt, frameMs)) return false;
    const key = this.flipKey;
    if (key === this.liveStack.key) {
      this.flipPending = false;
      return false;
    }
    if (this.armedStack.key !== key) {
      if (this.hasQueued && this.queued.key === key) {
        if (this.fading) this.endFade();
        else this.promoteQueued();
      } else if (key === '') {
        if (this.fading) this.endFade();
        this.clearStack(this.armedStack);
      } else {
        return false; // not armed yet: hold the previous content
      }
    } else if (this.fading) {
      // Flipping back to the outgoing stack of a running fade (GO, then Prev quickly): stop the fade and
      // swap back; a new fade starts below from the current frame.
      this.fading = false;
    }
    this.live = 1 - this.live;
    this.flipPending = false;
    this.flips++;
    if (isLateFlip(now, this.flipAt, this.flipRequestedAt, frameMs)) this.lateFlips++;
    if (this.flipFadeMs > 0) {
      this.fading = true;
      this.fadeMs = this.flipFadeMs;
      // A held flip (late) fades from now so the transition is still visible; on time it fades from `at`.
      this.fadeStart = now - this.flipAt > frameMs ? now : this.flipAt;
    } else if (this.hasQueued) this.promoteQueued();
    this.dirty = true;
    return true;
  }

  /** Incoming (live) weight of the running crossfade; 1 when not fading. */
  weight(now: number): number {
    /* @hot */
    return this.fading ? crossfadeWeight(now, this.fadeStart, this.fadeMs) : 1;
  }

  /** Drop everything (used on look change or teardown). */
  reset(): void {
    this.clearStack(this.stacks[0]);
    this.clearStack(this.stacks[1]);
    this.clearStack(this.queued);
    this.hasQueued = false;
    this.fading = false;
    this.flipPending = false;
    this.dirty = true;
  }

  private endFade(): void {
    /* @hot */
    this.fading = false;
    if (this.hasQueued) this.promoteQueued();
    this.dirty = true;
  }

  private promoteQueued(): void {
    /* @hot */
    const a = this.armedStack;
    const q = this.queued;
    if (a.bitmap && a.bitmap !== q.bitmap) this.release(a.bitmap);
    a.key = q.key;
    a.kind = q.kind;
    a.bitmap = q.bitmap;
    a.videoSlot = q.videoSlot;
    a.fit = q.fit;
    a.cueIndex = q.cueIndex;
    a.version++;
    q.bitmap = null;
    q.key = '';
    q.kind = SRC_EMPTY;
    this.hasQueued = false;
  }

  private clearStack(s: Stack<B>): void {
    /* @hot */
    if (s.bitmap) this.release(s.bitmap);
    s.bitmap = null;
    s.key = '';
    s.kind = SRC_EMPTY;
    s.videoSlot = -1;
    s.cueIndex = -1;
    s.version++;
  }

  private assign(s: Stack<B>, c: StackContent<B>): void {
    if (s.bitmap && s.bitmap !== c.bitmap) this.release(s.bitmap);
    s.key = c.key;
    s.kind = c.key === '' ? SRC_EMPTY : c.kind;
    s.bitmap = c.bitmap ?? null;
    s.videoSlot = c.videoSlot ?? -1;
    s.fit = c.fit ?? FIT_COVER;
    s.cueIndex = c.cueIndex ?? -1;
    s.version++;
  }
}

/** Rect (x, y, w, h in device px) of a source of size sw x sh fitted into a dw x dh frame. */
export function fitRect(
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  fit: number,
  out: Float32Array,
  offset = 0,
): void {
  /* @hot */
  if (sw <= 0 || sh <= 0) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = dw;
    out[offset + 3] = dh;
    return;
  }
  const s = fit === FIT_CONTAIN ? Math.min(dw / sw, dh / sh) : Math.max(dw / sw, dh / sh);
  const w = sw * s;
  const h = sh * s;
  out[offset] = (dw - w) / 2;
  out[offset + 1] = (dh - h) / 2;
  out[offset + 2] = w;
  out[offset + 3] = h;
}
