/**
 * Embedded video and sound (design/27 §4 "Media", §8; M5 hub scope): what a picture is the poster of, and
 * what each slide plays once emitted. Timing is `timing.ts`.
 *
 * Reading (`readMediaRef`, from `picture.ts`): a `p:pic` with `a:videoFile`, `a:audioFile`,
 * `a:wavAudioFile`, `a:quickTimeFile` or `p14:media`.
 * - The part is the embedded one: `p14:media r:embed`, else the element's own relationship when it stays in
 *   the package (PowerPoint writes `a:videoFile r:link` to an internal part too). A relationship with
 *   `TargetMode="External"` is a linked clip: only its host is kept, it is never fetched.
 * - The kind is the caller's sniff of the bytes when given (`ParseOptions.mediaKind`: pptxgenjs writes sounds
 *   under `a:videoFile`), else the element, else the slide's timing node (`p:video` / `p:audio`).
 * - `p14:trim` (`st`, `end`: milliseconds cut from the start and from the end) is kept for the hub, which
 *   bakes it into the clip at ingest.
 *
 * Emission (`emitMedia`, called by `emit.ts` once a slide's objects are emitted), bottom of the z-order first:
 * - **Motion background.** On a 16:9 deck, a slide video that starts by itself, loops, is muted (`mute`, or
 *   volume 0) and covers the slide (each edge within 2.5 %, unturned, uncropped, unmasked, opaque, its poster
 *   at the slide's aspect when known) with nothing of the slide's own below it becomes
 *   `Slide.backgroundMediaId`: the background layer loops it muted, cover-fitted, across slides. What it
 *   covered (the slide background, decorations under it, its poster) is left out; the poster travels in
 *   `EmittedClip.poster`, so the hub can put it back when the clip cannot be imported.
 * - **The playing video** is the first other slide video with a poster: `ImageObject.play` on its poster
 *   (start, loop, rewind → onEnd 'black', volume → gainDb, mute, showWhenStopped). `fullScrn` makes the box
 *   the slide's area with the poster contain-fitted. Later videos keep their posters (noted).
 * - **The sound** is the first slide sound: `Slide.audio` (start, loop, gainDb, muted, numSld → slides).
 *   Later sounds are left out (noted). An audio icon is drawn only when shown while stopped and on the
 *   slide; PowerPoint hides the others in the show.
 * - **Transition sounds** become the slide's sound only with `EmitOptions.transitionSounds` and when the slide
 *   has no sound of its own; animation sounds are never imported. Both are noted.
 * - Videos and sounds of layouts and masters are drawn as posters; linked and missing clips too (noted, and
 *   listed in `EmittedClip` for the hub's `[warn]` lines).
 *
 * Clip media ids are placeholders, `pptxmedia:clip<n>`, one per part and trim (`clipKey`), listed with their
 * parts in `EmittedSlide.clips`; the hub ingests each and replaces them.
 */
import type { ImageObject, Play, Slide, SlideSound } from '@ordo/domain';
import type { SlideCtx } from './context.ts';
import { decompose, slideRect } from './frame.ts';
import type { ClipTrim, ElementBase, Frame, MediaRef, PictureElement, SlideScene } from './ir.ts';
import type { Log } from './log.ts';
import { externalHost } from './opc.ts';
import { gainDbOf, type SlideTiming } from './timing.ts';
import { child, num, path, type XNode } from './xml.ts';

/** The longest trim kept (the hub's decode limit, 4 h). */
export const MAX_TRIM_MS = 4 * 3_600_000;
/** How far each edge of a motion background may be from the slide's, as a share of the slide's side. */
export const MOTION_EDGE = 0.025;
/** How far a motion background's poster may be from the slide's aspect, as a share of it. */
export const MOTION_ASPECT = 0.03;

/** The media elements under `p:nvPr`, by name. */
const VIDEO_ELEMENTS = ['a:videoFile', 'a:quickTimeFile'] as const;
const AUDIO_ELEMENTS = ['a:audioFile', 'a:wavAudioFile'] as const;

/** `p14:trim` in milliseconds; undefined when it cuts nothing. */
function trimOf(n: XNode | undefined): ClipTrim | undefined {
  if (!n) return undefined;
  const ms = (v: string | undefined) => {
    const x = num(v);
    return x === undefined || !(x > 0) ? 0 : Math.min(MAX_TRIM_MS, Math.round(x));
  };
  const out = { startMs: ms(n.attrs.st), endCutMs: ms(n.attrs.end) };
  return out.startMs || out.endCutMs ? out : undefined;
}

/**
 * The video or sound a `p:pic` is the poster of, or undefined when it is an ordinary picture (see the module
 * comment). `source` is the part that holds the element's XML.
 */
export function readMediaRef(
  ctx: SlideCtx,
  el: XNode,
  source: string,
  base: ElementBase,
): MediaRef | undefined {
  const nvPr = path(el, 'p:nvPicPr', 'p:nvPr');
  if (!nvPr) return undefined;
  let video: XNode | undefined;
  for (const n of VIDEO_ELEMENTS) video ??= child(nvPr, n);
  let audio: XNode | undefined;
  for (const n of AUDIO_ELEMENTS) audio ??= child(nvPr, n);
  let p14: XNode | undefined;
  const exts = child(nvPr, 'p:extLst')?.children ?? [];
  for (let i = 0; i < exts.length && i < 64 && !p14; i++) p14 = child(exts[i], 'p14:media');
  if (!video && !audio && !p14) return undefined;
  const timing = base.from === 'slide' ? ctx.timing?.media.get(base.shapeId) : undefined;
  const own = video ?? audio;
  let part: string | undefined;
  let external: string | undefined;
  for (const rid of [
    p14?.attrs['r:embed'],
    p14?.attrs['r:link'],
    own?.attrs['r:link'],
    own?.attrs['r:embed'],
  ]) {
    if (!rid) continue;
    const rel = ctx.pkg.rel(source, rid);
    if (!rel) continue;
    if (rel.external) external ??= externalHost(rel.target);
    else if (ctx.pkg.has(rel.target)) {
      part = rel.target;
      break;
    }
  }
  const sniffed = part === undefined ? undefined : ctx.mediaKind?.(part);
  const kind = sniffed ?? (video ? 'video' : audio ? 'audio' : (timing?.kind ?? 'video'));
  const out: MediaRef = { kind };
  if (part !== undefined) out.part = part;
  else if (external !== undefined) out.external = external;
  const trim = trimOf(child(p14, 'p14:trim'));
  if (trim) out.trim = trim;
  if (timing) out.timing = timing;
  return out;
}

/** A slide's transition sound and animation sounds, its relationships resolved (`SlideScene`). */
export function readSlideSounds(
  ctx: SlideCtx,
  timing: SlideTiming,
): Pick<SlideScene, 'transitionSound' | 'animationSounds'> {
  const out: Pick<SlideScene, 'transitionSound' | 'animationSounds'> = {};
  if (timing.animationSounds) out.animationSounds = timing.animationSounds;
  const t = timing.transitionSound;
  if (!t) return out;
  const rel = ctx.pkg.rel(ctx.part, t.rid);
  const sound: NonNullable<SlideScene['transitionSound']> = { loop: t.loop };
  if (rel?.external) sound.external = externalHost(rel.target);
  else if (rel && ctx.pkg.has(rel.target)) sound.part = rel.target;
  out.transitionSound = sound;
  return out;
}

// ── Emission ────────────────────────────────────────────────────────────────────────────────────────────

/** A clip a slide plays or names, for the hub (`EmittedSlide.clips`). */
export interface EmittedClip {
  /**
   * play: the playing video of `objectId`; sound: `Slide.audio`; background: `Slide.backgroundMediaId`;
   * linked: a clip outside the package (never fetched); missing: a clip whose part is not in the deck.
   */
  role: 'play' | 'sound' | 'background' | 'linked' | 'missing';
  kind: 'video' | 'audio';
  /** The placeholder written in `play.mediaId`, `audio.mediaId` or `backgroundMediaId`. */
  id?: string;
  /** The embedded part. */
  part?: string;
  /** A linked clip's host. */
  external?: string;
  trim?: ClipTrim;
  /** The poster object (play, and linked or missing videos). */
  objectId?: string;
  /** background: the poster the motion background replaced, to put back at the bottom when the clip fails. */
  poster?: ImageObject;
}

/** What `emitMedia` needs of the emitter's context. */
export interface MediaEmitCtx {
  frame: Frame;
  log: Log;
  /** The placeholder media id of a clip, by `clipKey` (`pptxmedia:clip<n>`). */
  clipId: (key: string) => string;
  /** 'Import transition sounds'. */
  transitionSounds: boolean;
}

/** One placeholder per part and trim: the same file used whole and trimmed gives two clips. */
export function clipKey(part: string, trim?: ClipTrim): string {
  return trim ? `${part}#${trim.startMs}-${trim.endCutMs}` : part;
}

type Item = {
  e: PictureElement;
  m: MediaRef;
  /** Index in `SlideScene.elements`. */
  i: number;
  /** The element's objects, `[at, end)` in `Slide.objects`. */
  at: number;
  end: number;
  poster?: ImageObject;
};

type Box = { x: number; y: number; w: number; h: number };

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whether the deck is 16:9 (the background layer cover-fits on a 16:9 frame). */
function sixteenNine(f: Frame): boolean {
  return Math.abs(f.cx / f.cy - 16 / 9) < (16 / 9) * 0.01;
}

/** Whether a video is the slide's motion background (see the module comment). */
function motionBackground(f: Frame, s: SlideScene, x: Item): boolean {
  const t = x.m.timing;
  const p = x.poster;
  if (x.m.kind !== 'video' || x.e.from !== 'slide' || !x.m.part || !p || !t) return false;
  if (t.start !== 'auto' || !t.loop || !(t.muted || t.vol === 0) || t.fullScreen) return false;
  if (p.opacity < 1 || p.crop || p.radius > 0 || p.box.rotation !== 0 || x.e.geom !== 'rect') return false;
  if (decompose(x.e.xf).flipH || x.e.picture.crop || x.e.picture.fillRect) return false;
  const r = slideRect(f);
  const dx = MOTION_EDGE * r.w;
  const dy = MOTION_EDGE * r.h;
  const b = p.box;
  if (
    Math.abs(b.x - r.x) > dx ||
    Math.abs(b.y - r.y) > dy ||
    Math.abs(b.x + b.w - (r.x + r.w)) > dx ||
    Math.abs(b.y + b.h - (r.y + r.h)) > dy
  )
    return false;
  const px = x.e.picture.px;
  const aspect = r.w / r.h;
  if (px && Math.abs(px.w / px.h - aspect) > aspect * MOTION_ASPECT) return false;
  // Nothing of the slide's own under it (layout and master decorations are covered, like the background).
  for (let k = 0; k < x.i; k++) {
    const e = s.elements[k]!;
    if (!e.hidden && (e.from === 'slide' || e.support === 'residual')) return false;
  }
  return true;
}

/**
 * The clips of an emitted slide (see the module comment): sets `play`, `Slide.audio` and a motion
 * background, and returns the clips with the indexes of `slide.objects` to leave out (audio icons that are not
 * shown; what a motion background covers). `spans[i]` is the range of `slide.objects` element `i` emitted.
 */
export function emitMedia(
  ctx: MediaEmitCtx,
  s: SlideScene,
  slide: Slide,
  spans: readonly (readonly [number, number])[],
): { clips: EmittedClip[]; remove: Set<number> } {
  const clips: EmittedClip[] = [];
  const remove = new Set<number>();
  const items: Item[] = [];
  s.elements.forEach((e, i) => {
    if (e.kind !== 'picture' || !e.media || e.hidden) return;
    const [at, end] = spans[i] ?? [0, 0];
    const o = at < end ? slide.objects[at] : undefined;
    items.push({ e, m: e.media, i, at, end, ...(o?.type === 'image' ? { poster: o } : {}) });
  });
  const area = slideRect(ctx.frame);

  for (const x of items) {
    const what = x.m.kind === 'video' ? 'video' : 'sound';
    const shown = x.m.kind === 'video' ? 'its poster is shown' : 'it does not play';
    if (x.m.external !== undefined) {
      ctx.log(`a linked ${what} (${x.m.external}) is not imported: ${shown}`);
      clips.push({ role: 'linked', kind: x.m.kind, external: x.m.external, ...posterOf(x) });
    } else if (x.m.part === undefined) {
      ctx.log(`a ${what} is missing from the deck: ${shown}`);
      clips.push({ role: 'missing', kind: x.m.kind, ...posterOf(x) });
    } else if (x.e.from !== 'slide') ctx.log(`a ${what} of the layout or master does not play: ${shown}`);
  }
  const ownClip = (x: Item) => x.e.from === 'slide' && x.m.part !== undefined;

  // The motion background: at most one, the lowest.
  const bg = sixteenNine(ctx.frame) ? items.find((x) => motionBackground(ctx.frame, s, x)) : undefined;
  if (bg?.poster && bg.m.part !== undefined) {
    const id = ctx.clipId(clipKey(bg.m.part, bg.m.trim));
    slide.backgroundMediaId = id;
    for (let k = 0; k < bg.end; k++) remove.add(k);
    const { play: _, ...poster } = bg.poster;
    clips.push({ role: 'background', kind: 'video', id, part: bg.m.part, ...trimField(bg.m), poster });
    ctx.log('a looping, muted video over the whole slide is its motion background');
  }

  // The playing video: the first other slide video with a poster.
  const videos = items.filter((x) => x !== bg && x.m.kind === 'video' && ownClip(x));
  let playing = false;
  for (const x of videos) {
    if (!x.poster) {
      ctx.log('a video without a box on the slide does not play');
      continue;
    }
    if (playing) {
      ctx.log('only the first video of a slide plays: another is shown as its poster');
      continue;
    }
    playing = true;
    const id = ctx.clipId(clipKey(x.m.part!, x.m.trim));
    x.poster.play = playOf(id, x.m);
    if (x.m.timing?.fullScreen) {
      x.poster.box = { x: area.x, y: area.y, w: area.w, h: area.h, rotation: 0 };
      x.poster.fit = 'contain';
      x.poster.radius = 0;
      ctx.log('a full-screen video plays over the slide, its poster fitted inside');
    }
    clips.push({
      role: 'play',
      kind: 'video',
      id,
      part: x.m.part,
      ...trimField(x.m),
      objectId: x.poster.id,
    });
  }

  // The sound: the first slide sound.
  const sounds = items.filter((x) => x.m.kind === 'audio' && ownClip(x));
  sounds.forEach((x, n) => {
    if (n > 0) {
      ctx.log('only the first sound of a slide plays: another is left out');
      return;
    }
    const id = ctx.clipId(clipKey(x.m.part!, x.m.trim));
    slide.audio = soundOf(id, x.m);
    clips.push({ role: 'sound', kind: 'audio', id, part: x.m.part, ...trimField(x.m) });
  });
  // Audio icons show in the show only when not hidden while stopped and on the slide.
  for (const x of items) {
    if (x.m.kind !== 'audio') continue;
    const visible = x.m.timing?.showWhenStopped !== false && !!x.poster && intersects(x.poster.box, area);
    if (!visible) for (let k = x.at; k < x.end; k++) remove.add(k);
  }

  const ts = s.transitionSound;
  if (ts) {
    if (!ctx.transitionSounds)
      ctx.log("a transition sound is not imported (option 'Import transition sounds')");
    else if (ts.external !== undefined) ctx.log(`a linked transition sound (${ts.external}) is not imported`);
    else if (ts.part === undefined) ctx.log('a transition sound is missing from the deck');
    else if (slide.audio) ctx.log('a transition sound is left out: the slide has a sound of its own');
    else {
      const id = ctx.clipId(clipKey(ts.part));
      slide.audio = { mediaId: id, start: 'auto', ...(ts.loop ? { loop: true } : {}) };
      clips.push({ role: 'sound', kind: 'audio', id, part: ts.part });
    }
  }
  if (s.animationSounds) ctx.log(`${s.animationSounds} animation sound(s) are not imported`);
  return { clips, remove };
}

function posterOf(x: Item): { objectId?: string } {
  return x.poster && x.m.kind === 'video' ? { objectId: x.poster.id } : {};
}

function trimField(m: MediaRef): { trim?: ClipTrim } {
  return m.trim ? { trim: { ...m.trim } } : {};
}

/** `ImageObject.play` from a clip's timing (only what differs from the defaults is written). */
function playOf(mediaId: string, m: MediaRef): Play {
  const t = m.timing;
  const play: Play = { mediaId, start: t?.start ?? 'click' };
  if (t?.loop) play.loop = true;
  if (t?.rewind) play.onEnd = 'black';
  const gain = gainDbOf(t?.vol);
  if (gain) play.gainDb = gain;
  if (t?.muted) play.muted = true;
  if (t?.showWhenStopped === false) play.showWhenStopped = false;
  return play;
}

/** `Slide.audio` from a sound's timing. */
function soundOf(mediaId: string, m: MediaRef): SlideSound {
  const t = m.timing;
  const sound: SlideSound = { mediaId, start: t?.start ?? 'click' };
  if (t?.loop) sound.loop = true;
  const gain = gainDbOf(t?.vol);
  if (gain) sound.gainDb = gain;
  if (t?.muted) sound.muted = true;
  if (t?.slides) sound.slides = t.slides;
  return sound;
}
