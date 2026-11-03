import type { Cue, ResolvedPlaylist } from './live.ts';
import type { Arrangement, Presentation, Section } from './schemas.ts';

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
      sections.forEach((section, arrangementPos) => {
        section.slides.forEach((slide, slideIndexInSection) => {
          const text = firstText(slide);
          cues.push({
            index: cues.length,
            itemId: item.id,
            itemIndex,
            kind: 'slide',
            label: text
              ? truncate(text.replace(/\n/g, ' / '), 60)
              : `${section.label} ${slideIndexInSection + 1}`,
            presentationId: p.id,
            sectionId: section.id,
            sectionLabel: section.label,
            sectionShort: section.short,
            arrangementPos,
            slideId: slide.id,
            slideIndexInSection,
            backgroundMediaId: slide.backgroundMediaId ?? item.backgroundMediaId ?? p.backgroundMediaId,
            transition: item.transition ?? p.transition,
            autoAdvanceMs:
              p.kind === 'loop' ? (slide.durationMs ?? p.loop?.defaultSlideMs ?? 8000) : undefined,
          });
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
        label: m.name,
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
        label:
          item.timer.label ??
          (item.timer.kind === 'elapsed' ? 'Elapsed timer' : `Countdown to ${item.timer.timeOfDay}`),
        timerId: item.id,
        timer: item.timer,
      });
    } else {
      cues.push({
        index: cues.length,
        itemId: item.id,
        itemIndex,
        kind: 'action',
        label: item.action,
        action: item.action,
      });
    }
  });
  return cues;
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

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
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
