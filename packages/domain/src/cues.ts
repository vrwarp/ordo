import type { Cue, ResolvedPlaylist } from './live.ts';
import { playingObject } from './resolve.ts';
import type { Arrangement, Presentation, Section, Slide } from './schemas.ts';

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
          backgroundMediaId: slide.backgroundMediaId ?? item.backgroundMediaId ?? p.backgroundMediaId,
          ...(slide.clearBackground && !slide.backgroundMediaId ? { clearBackground: true } : {}),
          transition: item.transition ?? p.transition,
          autoAdvanceMs: p.kind === 'loop' ? loopDelay(slide.durationMs, p.loop?.defaultSlideMs) : undefined,
          ...slideCueMedia(slide, resolved.media, first + until(k)),
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
 * A muted clip or sound still plays, so its transport and the stage's remaining time work as usual, at the
 * schema's gain floor, which is silent.
 */
const MUTED_DB = -100;

/**
 * A slide cue's own media (design/27 §8 "Domain"), only for media present in `media`, so the live state never
 * references media the outputs do not have:
 * - the playing object's clip (the first ImageObject with `play`, in z order), a video: mediaId,
 *   mediaKind 'video', loop, onEnd, audio, mediaObjectId, mediaStart, mediaShowWhenStopped;
 * - the slide's sound (an audio file, or a video's soundtrack): slideAudio, playing on until cue `untilCue`.
 */
function slideCueMedia(slide: Slide, media: ResolvedPlaylist['media'], untilCue: number): Partial<Cue> {
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
  }
  return out;
}

/**
 * For each slide of a playlist item, the position of the last slide its sound plays on: the slide reached
 * after `audio.slides` shown slides (the slide itself is the first; hidden slides do not count), else the
 * item's last slide. Without `slides`, a sound plays on its own slide only.
 */
function soundEnds(slides: Slide[]): (k: number) => number {
  // Hidden slides are M3's (`Slide.hidden`); read structurally until that field lands.
  const shown: number[] = [];
  slides.forEach((s, k) => {
    if ((s as { hidden?: unknown }).hidden !== true) shown.push(k);
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

export function firstText(slide: {
  objects: { type: string; text?: string; id: string }[];
  lyricObjectId?: string;
}): string {
  if (slide.lyricObjectId) {
    const o = slide.objects.find((x) => x.id === slide.lyricObjectId);
    if (o && o.type === 'text' && o.text) return o.text;
  }
  const t = slide.objects.find((x) => x.type === 'text');
  return t?.text ?? '';
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

/** Sections (by arrangement position) of the item containing cue `index`, with their first cue. */
export function sectionsOfItem(
  cues: Cue[],
  index: number,
): { label: string; short: string; first: number; pos: number }[] {
  const c = cues[index];
  if (!c) return [];
  const out: { label: string; short: string; first: number; pos: number }[] = [];
  for (const x of cues) {
    if (x.itemIndex !== c.itemIndex || x.arrangementPos === undefined) continue;
    if (!out.some((o) => o.pos === x.arrangementPos)) {
      out.push({
        label: x.sectionLabel ?? '',
        short: x.sectionShort ?? '',
        first: x.index,
        pos: x.arrangementPos,
      });
    }
  }
  return out;
}
