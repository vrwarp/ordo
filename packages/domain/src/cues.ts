import type { Cue, ResolvedPlaylist } from './live.ts';
import { readableText } from './readable.ts';
import { playingObject } from './resolve.ts';
import type { Arrangement, Presentation, Section, Slide, TextObject } from './schemas.ts';

/** The arrangement used by a playlist item: the named one, else the first, else authoring order. */
export function arrangementFor(p: Presentation, arrangementId?: string): Arrangement {
  const found = arrangementId ? p.arrangements.find((a) => a.id === arrangementId) : undefined;
  if (found) return found;
  if (p.arrangements[0] && !arrangementId) return p.arrangements[0];
  return { id: '__authoring', name: 'Authoring order', sectionIds: p.sections.map((s) => s.id) };
}

/** Sections of a presentation in arrangement order (repeats included). Unknown ids are skipped. */
export function arrangedSections(p: Presentation, arrangementId?: string): Section[] {
  const arr = arrangementFor(p, arrangementId);
  const byId = new Map(p.sections.map((s) => [s.id, s]));
  const out: Section[] = [];
  for (const id of arr.sectionIds) {
    const s = byId.get(id);
    if (s) out.push(s);
  }
  return out;
}

/** Flatten a resolved playlist into the operator's position space. */
export function expandCues(resolved: Pick<ResolvedPlaylist, 'playlist' | 'presentations' | 'media'>): Cue[] {
  const cues: Cue[] = [];
  resolved.playlist.items.forEach((item, itemIndex) => {
    if (item.kind === 'presentation') {
      const p = resolved.presentations[item.presentationId];
      if (!p) return;
      const sections = arrangedSections(p, item.arrangementId);
      const slides = sections.flatMap((section, arrangementPos) =>
        section.slides.map((slide, slideIndexInSection) => ({
          section,
          arrangementPos,
          slide,
          slideIndexInSection,
        })),
      );
      const first = cues.length;
      const until = soundEnds(slides.map((x) => x.slide));
      slides.forEach(({ section, arrangementPos, slide, slideIndexInSection }, k) => {
        const text = firstText(slide);
        const bgId = slideBackground(slide, resolved.media) ?? item.backgroundMediaId ?? p.backgroundMediaId;
        const clearBackground =
          (slide.clearBackground && !slide.backgroundMediaId) ||
          (k === 0 && !bgId && itemIndex > 0 && !item.keepBackground);
        const mediaCues = slideCueMedia(slide, resolved.media, first + k, first + until(k));
        let itemSlideAudio = mediaCues.slideAudio;
        if (!itemSlideAudio && item.audioMediaId && resolved.media[item.audioMediaId]) {
          itemSlideAudio = {
            mediaId: item.audioMediaId,
            start: 'auto',
            loop: true,
            untilCue: first + slides.length - 1,
          };
        }
        cues.push({
          index: cues.length,
          itemId: item.id,
          itemIndex,
          kind: 'slide',
          label: truncate(
            text ? text.replace(/\n/g, ' / ') : `${section.label} ${slideIndexInSection + 1}`,
            60,
          ),
          presentationId: p.id,
          sectionId: section.id,
          sectionLabel: section.label,
          sectionShort: section.short,
          arrangementPos,
          slideId: slide.id,
          slideIndexInSection,
          backgroundMediaId: bgId,
          ...(clearBackground ? { clearBackground: true } : {}),
          transition: item.transition ?? slide.transition ?? p.transition,
          autoAdvanceMs: p.kind === 'loop' ? loopDelay(slide.durationMs, p.loop?.defaultSlideMs) : undefined,
          ...(k === 0 && item.countdownTimer
            ? { timer: item.countdownTimer, timerId: `${item.id}-timer` }
            : {}),
          // A hidden PowerPoint slide stays in the service (design/27 §9): sequential navigation skips its
          // cue (`nextShownCue`), a GO with its index shows it.
          ...(slide.hidden === true ? { hidden: true } : {}),
          ...(slide.midiCues?.length ? { midiCues: slide.midiCues } : {}),
          ...mediaCues,
          ...(itemSlideAudio ? { slideAudio: itemSlideAudio } : {}),
        });
      });
    } else if (item.kind === 'media') {
      const m = resolved.media[item.mediaId];
      if (!m) return;
      cues.push({
        index: cues.length,
        itemId: item.id,
        itemIndex,
        kind: 'media',
        label: truncate(m.name ?? '', 80),
        mediaId: m.id,
        mediaKind: m.kind,
        loop: item.loop ?? m.loop,
        onEnd: item.onEnd ?? 'hold',
        audio: item.audio ?? (m.audio ? { pairId: m.audio.pairId, gainDb: m.audio.gainDb } : undefined),
      });
    } else if (item.kind === 'timer') {
      cues.push({
        index: cues.length,
        itemId: item.id,
        itemIndex,
        kind: 'timer',
        label: truncate(
          item.timer.label ??
            (item.timer.kind === 'elapsed' ? 'Elapsed timer' : `Countdown to ${item.timer.timeOfDay}`),
          80,
        ),
        timerId: item.id,
        timer: item.timer,
      });
    } else {
      cues.push({
        index: cues.length,
        itemId: item.id,
        itemIndex,
        kind: 'action',
        label: truncate(item.action, 80),
        action: item.action,
      });
    }
  });
  return cues;
}

/**
 * The slide's own background, unless it is a PowerPoint slide's that goLive left out (a motion background
 * still transcoding or failed, design/27 §8): then the item's or the presentation's shows.
 */
function slideBackground(slide: Slide, media: ResolvedPlaylist['media']): string | undefined {
  const id = slide.backgroundMediaId;
  return id && slide.pptx && !media[id] ? undefined : id;
}

/**
 * A muted clip or sound still plays, so its transport and the stage's remaining time work as usual, at the
 * schema's gain floor, which is silent.
 */
const MUTED_DB = -100;

/**
 * A slide cue's own media (design/27 §8 "Domain"), only for media present in `media`, so the live state never
 * references media the outputs do not have:
 * - the playing object's clip (the first ImageObject with `play`, in z order), a video: mediaId,
 *   mediaKind 'video', loop, onEnd, audio, mediaObjectId, mediaStart, mediaShowWhenStopped;
 * - the slide's sound (an audio file, or a video's soundtrack): slideAudio, playing on until cue `untilCue`;
 * - a playing object whose clip turned out to be a sound (its media job found no picture: an import that took
 *   a sound for a video) is the slide's sound when the slide has none of its own, on this cue (`self`) only.
 */
function slideCueMedia(
  slide: Slide,
  media: ResolvedPlaylist['media'],
  self: number,
  untilCue: number,
): Partial<Cue> {
  const out: Partial<Cue> = {};
  const obj = playingObject(slide);
  const clip = obj ? media[obj.play.mediaId] : undefined;
  if (obj && clip?.kind === 'video') {
    const play = obj.play;
    const gainDb = play.muted ? MUTED_DB : play.gainDb;
    out.mediaId = play.mediaId;
    out.mediaKind = 'video';
    out.loop = play.loop ?? clip.loop;
    out.onEnd = play.onEnd ?? 'hold';
    if (gainDb !== undefined) out.audio = { gainDb };
    out.mediaObjectId = obj.id;
    out.mediaStart = play.start ?? 'auto';
    out.mediaShowWhenStopped = play.showWhenStopped ?? true;
  }
  const sound = slide.audio;
  const track = sound ? media[sound.mediaId] : undefined;
  if (sound && (track?.kind === 'audio' || track?.kind === 'video')) {
    const gainDb = sound.muted ? MUTED_DB : sound.gainDb;
    out.slideAudio = {
      mediaId: sound.mediaId,
      start: sound.start ?? 'auto',
      loop: !!(sound.loop ?? track.loop),
      ...(gainDb !== undefined ? { gainDb } : {}),
      untilCue,
    };
  } else if (obj && clip?.kind === 'audio') {
    const play = obj.play;
    const gainDb = play.muted ? MUTED_DB : play.gainDb;
    out.slideAudio = {
      mediaId: play.mediaId,
      start: play.start ?? 'auto',
      loop: !!(play.loop ?? clip.loop),
      ...(gainDb !== undefined ? { gainDb } : {}),
      untilCue: self,
    };
  }
  return out;
}

/**
 * For each slide of a playlist item, the position of the last slide its sound plays on: the slide reached
 * after `audio.slides` shown slides (the slide itself is the first; hidden slides do not count), else the
 * item's last slide. Without `slides`, a sound plays on its own slide only.
 */
function soundEnds(slides: Slide[]): (k: number) => number {
  const shown: number[] = [];
  slides.forEach((s, k) => {
    if (s.hidden !== true) shown.push(k);
  });
  return (k) => {
    const n = slides[k]?.audio?.slides;
    const count = typeof n === 'number' && Number.isFinite(n) ? Math.min(999, Math.floor(n)) : 1;
    if (count <= 1) return k;
    // The first shown slide after k, then count - 2 more.
    let lo = 0;
    let hi = shown.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (shown[mid]! <= k) lo = mid + 1;
      else hi = mid;
    }
    return shown[lo + count - 2] ?? slides.length - 1;
  };
}

/**
 * The text a slide is known by (cue labels, lyric-only bands, thumbnails): its lyric object, else its
 * first text box, as people read it (`readableText`: automatic numbers and bullets written as text).
 */
export function firstText(slide: {
  objects: { type: string; text?: string; id: string; paras?: TextObject['paras'] }[];
  lyricObjectId?: string;
  imported?: ImportedTextSource['imported'];
  pptx?: ImportedTextSource['pptx'];
}): string {
  // A slide whose text is only in a picture: the picture's own text (design/27 §11), never a neighbour's.
  if (!slide.objects.some((x) => x.type === 'text' && x.text)) {
    const t = importedText(slide);
    if (t) return t;
  }
  if (slide.lyricObjectId) {
    const o = slide.objects.find((x) => x.id === slide.lyricObjectId);
    if (o && o.type === 'text' && o.text) return readableText({ text: o.text, paras: o.paras });
  }
  const t = slide.objects.find((x) => x.type === 'text');
  return t?.text ? readableText({ text: t.text, paras: t.paras }) : '';
}

/** Auto-advance delay of a loop slide, bounded to [0.5 s, 1 h] whatever the stored values. */
export const LOOP_SLIDE_MIN_MS = 500;
export const LOOP_SLIDE_MAX_MS = 3_600_000;
function loopDelay(slideMs: number | undefined, defaultMs: number | undefined): number {
  const pick = (v: number | undefined) =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
  const ms = pick(slideMs) ?? pick(defaultMs) ?? 8000;
  return Math.round(Math.max(LOOP_SLIDE_MIN_MS, Math.min(LOOP_SLIDE_MAX_MS, ms)));
}

/** Replace lone surrogates (from mis-decoded imports) with U+FFFD so labels are valid text everywhere. */
function wellFormed(s: string): string {
  return s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
}

/** Shorten to `n` code units with an ellipsis, never splitting a surrogate pair. */
function truncate(raw: string, n: number): string {
  const s = wellFormed(raw);
  if (s.length <= n) return s;
  let end = n - 1;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end) + '…';
}

/*
 * Hidden cues (design/27 §9). A hidden PowerPoint slide keeps its cue, flagged `hidden`. Sequential
 * navigation skips it: Next, Prev, the cue a GO arms, a loop's auto-advance, onEnd 'advance', Next item and
 * Previous item. A GO with its index (a click in the slide grid, goToSlide, a Stream Deck slide key) shows
 * it, as PowerPoint does. A jump to a named group of cues (a section key, a section header, a playlist item
 * picked in the playlist) lands on the group's first cue that is not hidden (`entryCue`).
 */

/** Whether sequential navigation skips cue `c`: a hidden PowerPoint slide (design/27 §9). */
export function isHiddenCue(c: Pick<Cue, 'hidden'> | undefined): boolean {
  return c?.hidden === true;
}

/**
 * The first cue after `from` that is not hidden: what Next goes to and what a GO on `from` arms. `from` -1
 * gives the first cue that is not hidden. Undefined when none follows.
 */
export function nextShownCue(cues: readonly Cue[], from: number): number | undefined {
  for (let i = Math.max(0, Math.floor(from) + 1); i < cues.length; i++) if (!isHiddenCue(cues[i])) return i;
  return undefined;
}

/** The last cue before `from` that is not hidden: what Prev goes to. Undefined when none precedes. */
export function prevShownCue(cues: readonly Cue[], from: number): number | undefined {
  for (let i = Math.min(Math.ceil(from), cues.length) - 1; i >= 0; i--) if (!isHiddenCue(cues[i])) return i;
  return undefined;
}

/**
 * Where a jump to a named group of cues lands (the cues of one section occurrence or one playlist item, in
 * cue order): its first cue that is not hidden; for a group whose slides are all hidden, its first cue, since
 * the operator named the group.
 */
export function entryCue<C extends Pick<Cue, 'hidden'>>(group: readonly C[]): C | undefined {
  return group.find((c) => !isHiddenCue(c)) ?? group[0];
}

/** First cue index of each playlist item. */
export function itemStarts(cues: Cue[]): number[] {
  const starts: number[] = [];
  let last = -1;
  for (const c of cues) {
    if (c.itemIndex !== last) {
      starts.push(c.index);
      last = c.itemIndex;
    }
  }
  return starts;
}

/**
 * Sections (by arrangement position) of the item containing cue `index`, with their first cue and the cue a
 * jump to the section lands on (`entry`: its first cue that is not hidden, else its first cue; `entryCue`).
 */
export function sectionsOfItem(
  cues: Cue[],
  index: number,
): { label: string; short: string; first: number; entry: number; pos: number }[] {
  const c = cues[index];
  if (!c) return [];
  const out: { label: string; short: string; first: number; entry: number; pos: number }[] = [];
  for (const x of cues) {
    if (x.itemIndex !== c.itemIndex || x.arrangementPos === undefined) continue;
    const o = out.find((o) => o.pos === x.arrangementPos);
    if (!o) {
      out.push({
        label: x.sectionLabel ?? '',
        short: x.sectionShort ?? '',
        first: x.index,
        entry: x.index,
        pos: x.arrangementPos,
      });
    } else if (isHiddenCue(cues[o.entry]) && !isHiddenCue(x)) o.entry = x.index;
  }
  return out;
}

/** What `importedText` reads of a slide: structural, so stored, clamped and resolved slides all fit. */
export type ImportedTextSource = {
  imported?: { textBoxes?: readonly { text: string }[]; textAligned?: boolean };
  pptx?: { class?: string; artText?: string };
};

/** Longest fallback text: the schema's bound on one text. */
const MAX_IMPORTED_TEXT = 20_000;

/**
 * The text a slide shows only inside a picture (design/27 §11 "Round trip and migration"), which cue
 * labels, lyric-only bands, the stage and search fall back to when the slide has no text of its own:
 * - an imported page's text boxes, only once they are known to be that page's (`imported.textAligned`).
 *   Legacy boxes were matched by list index and hold another slide's text after a hidden slide;
 * - else the text baked into a hybrid or picture slide's PowerPoint art (`pptx.artText`).
 * Boxes are joined with newlines, bottom first, cut at 20,000 characters; '' when there is none.
 */
export function importedText(slide: ImportedTextSource): string {
  const imp = slide.imported;
  if (imp && imp.textAligned === true && Array.isArray(imp.textBoxes)) {
    let out = '';
    for (const b of imp.textBoxes) {
      const t = typeof b?.text === 'string' ? b.text.trim() : '';
      if (!t) continue;
      out = out ? `${out}\n${t}` : t;
      if (out.length >= MAX_IMPORTED_TEXT) return cutText(out, MAX_IMPORTED_TEXT);
    }
    if (out) return out;
  }
  const p = slide.pptx;
  if (p && (p.class === 'hybrid' || p.class === 'picture') && typeof p.artText === 'string')
    return cutText(p.artText.trim(), MAX_IMPORTED_TEXT);
  return '';
}

/** `s` cut to `n` code units without splitting a surrogate pair. */
function cutText(s: string, n: number): string {
  if (s.length <= n) return s;
  const c = s.charCodeAt(n - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? n - 1 : n);
}
