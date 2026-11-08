/**
 * Clip timing from a slide's `p:timing` (design/27 §8 "p:timing mapping"; M5 hub scope). Slide transitions
 * and `advTm` are `transition.ts`; builds are drawn in their final state (§9) and not read here.
 *
 * - **Start.** `auto`: a `presetClass="mediacall"` effect that plays the clip (`playFrom(…)`, `play`,
 *   `togglePause`) with `nodeType` `afterEffect` or `withEffect` in the main sequence before its first
 *   `clickEffect`. `click`: a click effect, a play effect after the first click, or a trigger
 *   (`interactiveSeq`, PowerPoint's "When clicked on"). A clip nothing starts is a click too (PowerPoint shows
 *   play controls); `MediaTiming.start` is then undefined.
 * - **The media node** (`p:video` / `p:audio` → `p:cMediaNode` → `p:cTn`, aimed at the picture by
 *   `p:tgtEl/p:spTgt spid`): `repeatCount="indefinite"` → loop; `fill="remove"` → "Rewind after playing";
 *   `vol` (0-100,000), `mute`, `showWhenStopped`, `numSld` (1-999), `p:video fullScrn`, `p:audio isNarration`.
 * - **Sounds that are not clips.** A media node aimed at a sound part (`p:sndTgt`) is an animation sound:
 *   counted, never imported. The transition's sound (`p:transition/p:sndAc/p:stSnd/p:snd r:embed`, with
 *   `p:stSnd loop`) is returned for the import option 'Import transition sounds' (off by default).
 *
 * Bounded: the walk visits at most `MAX_TIMING_NODES` elements and keeps at most `MAX_TIMED_MEDIA` clips;
 * numbers are finite and clamped. Pure.
 */
import { chooseAlternate } from './markup.ts';
import type { MediaTiming } from './ir.ts';
import { child, num, path, type XNode } from './xml.ts';

/** Elements of one timing tree visited at most (a real slide has a few hundred). */
export const MAX_TIMING_NODES = 100_000;
/** Clips one slide's timing describes at most. */
export const MAX_TIMED_MEDIA = 1_000;
/** PowerPoint's full volume (`vol`). */
export const FULL_VOLUME = 100_000;
/** `numSld` at most (PowerPoint writes 999 for "until the end of the show"; the schema's bound). */
export const MAX_SLIDES = 999;

/** What a slide's timing says about its clips and sounds. */
export interface SlideTiming {
  /** Per picture (`p:cNvPr id`). */
  media: Map<number, MediaTiming>;
  /** The transition's sound: the relationship id of its part, and whether it loops until the next sound. */
  transitionSound?: { rid: string; loop: boolean };
  /** Sounds of animation effects (never imported). */
  animationSounds: number;
}

const flag = (v: string | undefined) => {
  const t = v?.trim();
  return t === '1' || t === 'true' || t === 'on';
};

/** A shape id (`spid`): a non-negative integer, else undefined. */
function spidOf(n: XNode | undefined): number | undefined {
  const v = num(n?.attrs.spid);
  return v !== undefined && Number.isInteger(v) && v >= 0 && v <= 2_147_483_647 ? v : undefined;
}

/** The children of `n`, with each `mc:AlternateContent` replaced by the children of the branch it reads. */
function* unwrapped(n: XNode): Generator<XNode> {
  for (const c of n.children) {
    if (c.name !== 'mc:AlternateContent') {
      yield c;
      continue;
    }
    const branch = chooseAlternate(c);
    if (branch) yield* branch.children;
  }
}

/** The first child named `name`, looking into `mc:AlternateContent` branches. */
function childOf(n: XNode | undefined, name: string): XNode | undefined {
  if (!n) return undefined;
  for (const c of unwrapped(n)) if (c.name === name) return c;
  return undefined;
}

/** Elements under `root` in document order (pre-order), at most `budget.left` in all. */
function* walk(root: XNode, budget: { left: number }): Generator<XNode> {
  const stack: XNode[] = [root];
  while (stack.length && budget.left > 0) {
    const n = stack.pop()!;
    budget.left--;
    yield n;
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = n.children[i]!;
      if (c.name !== '#text') stack.push(c);
    }
  }
}

/** Whether a `mediacall` command plays its clip (play, play from a time, or the toggle a trigger uses). */
function plays(cmd: string | undefined): boolean {
  const c = (cmd ?? '').trim().slice(0, 40);
  return c === 'play' || c.startsWith('playFrom') || c === 'togglePause';
}

/** The clips a `mediacall` effect plays: the `spid`s of its `p:cmd` targets. */
function playedBy(effect: XNode, budget: { left: number }): number[] {
  const out: number[] = [];
  for (const n of walk(effect, budget)) {
    if (n.name !== 'p:cmd' || !plays(n.attrs.cmd)) continue;
    const id = spidOf(path(n, 'p:cBhvr', 'p:tgtEl', 'p:spTgt'));
    if (id !== undefined && out.length < MAX_TIMED_MEDIA) out.push(id);
  }
  return out;
}

/** A media node's facts (`p:video` / `p:audio`). */
function mediaNode(n: XNode): { spid?: number; sound: boolean; timing: MediaTiming } {
  const node = child(n, 'p:cMediaNode');
  const ctn = child(node, 'p:cTn');
  const tgt = child(node, 'p:tgtEl');
  const vol = num(node?.attrs.vol);
  const slides = num(node?.attrs.numSld);
  const timing: MediaTiming = {
    loop: ctn?.attrs.repeatCount?.trim() === 'indefinite',
    rewind: ctn?.attrs.fill?.trim() === 'remove',
    muted: flag(node?.attrs.mute),
    showWhenStopped: node?.attrs.showWhenStopped === undefined || flag(node.attrs.showWhenStopped),
    fullScreen: n.name === 'p:video' && flag(n.attrs.fullScrn),
    narration: n.name === 'p:audio' && flag(n.attrs.isNarration),
    kind: n.name === 'p:video' ? 'video' : 'audio',
  };
  if (vol !== undefined) timing.vol = Math.min(FULL_VOLUME, Math.max(0, vol));
  if (slides !== undefined && slides > 1) timing.slides = Math.min(MAX_SLIDES, Math.floor(slides));
  const spid = spidOf(child(tgt, 'p:spTgt'));
  return { ...(spid !== undefined ? { spid } : {}), sound: !!child(tgt, 'p:sndTgt'), timing };
}

/** What starts each clip: from the main sequence and the triggers. */
function starts(timing: XNode, budget: { left: number }): Map<number, 'auto' | 'click'> {
  const out = new Map<number, 'auto' | 'click'>();
  const set = (id: number, how: 'auto' | 'click') => {
    // An automatic start wins: PowerPoint plays the clip at once, a later click pauses or replays it.
    if (out.get(id) === 'auto' || out.size >= MAX_TIMED_MEDIA) return;
    out.set(id, how);
  };
  for (const n of walk(timing, budget)) {
    if (n.name !== 'p:cTn') continue;
    const type = n.attrs.nodeType?.trim();
    if (type === 'mainSeq') {
      let clicked = false;
      for (const e of walk(n, budget)) {
        if (e.name !== 'p:cTn') continue;
        const t = e.attrs.nodeType?.trim();
        if (t === 'clickEffect') clicked = true;
        if (e.attrs.presetClass?.trim() !== 'mediacall') continue;
        const auto = !clicked && (t === 'afterEffect' || t === 'withEffect');
        for (const id of playedBy(e, budget)) set(id, auto ? 'auto' : 'click');
      }
    } else if (type === 'interactiveSeq') {
      for (const e of walk(n, budget))
        if (e.name === 'p:cTn' && e.attrs.presetClass?.trim() === 'mediacall')
          for (const id of playedBy(e, budget)) set(id, 'click');
    }
  }
  return out;
}

/** The slide's `p:timing` and transition sound, read (see the module comment). */
export function readSlideTiming(slide: XNode): SlideTiming {
  const out: SlideTiming = { media: new Map(), animationSounds: 0 };
  const snd = path(childOf(slide, 'p:transition'), 'p:sndAc', 'p:stSnd');
  const rid = child(snd, 'p:snd')?.attrs['r:embed'];
  if (snd && rid) out.transitionSound = { rid: rid.slice(0, 100), loop: flag(snd.attrs.loop) };
  const timing = childOf(slide, 'p:timing');
  if (!timing) return out;
  for (const n of walk(timing, { left: MAX_TIMING_NODES })) {
    if (n.name !== 'p:video' && n.name !== 'p:audio') continue;
    const m = mediaNode(n);
    if (m.sound) out.animationSounds++;
    else if (m.spid !== undefined && !out.media.has(m.spid) && out.media.size < MAX_TIMED_MEDIA)
      out.media.set(m.spid, m.timing);
  }
  // Its own budget, shared by the nested walks of the sequences (each element is counted once per walk).
  for (const [id, how] of starts(timing, { left: MAX_TIMING_NODES })) {
    const t = out.media.get(id);
    if (t) t.start = how;
    // A clip that a play effect starts but no media node describes still plays, with PowerPoint's defaults.
    else if (out.media.size < MAX_TIMED_MEDIA)
      out.media.set(id, {
        start: how,
        loop: false,
        rewind: false,
        muted: false,
        showWhenStopped: true,
        fullScreen: false,
        narration: false,
      });
  }
  return out;
}

/**
 * PowerPoint's volume as a gain in dB: 20·log10(vol/100,000), to 0.01 dB, clamped to −100 (silent) .. 0
 * (design/27 §8 "Hub"; the hub's `volumeGainDb` computes the same). Undefined for a volume not written.
 */
export function gainDbOf(vol: number | undefined): number | undefined {
  if (vol === undefined || Number.isNaN(vol)) return undefined;
  if (vol <= 0) return -100;
  const db = Math.round(2000 * Math.log10(vol / FULL_VOLUME)) / 100;
  return Math.min(0, Math.max(-100, db)) || 0;
}
