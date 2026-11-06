import type { Presentation, Slide, SlideObject } from '@ordo/domain';
import { findSlide } from '../ops.ts';

/*
 * Updates that keep identity: an op that changes nothing returns its input itself, so `change()` sees the
 * same draft and records no undo step and no unsaved change (M4.md "Rules").
 */

/** `p` with `fn` applied to one slide; `p` itself when the slide is missing or `fn` returns it unchanged. */
export function withSlide(p: Presentation, slideId: string, fn: (s: Slide) => Slide): Presentation {
  const pos = findSlide(p, slideId);
  if (!pos) return p;
  const sec = p.sections[pos.si]!;
  const s = sec.slides[pos.i]!;
  const next = fn(s);
  if (next === s) return p;
  const slides = [...sec.slides];
  slides[pos.i] = next;
  const sections = [...p.sections];
  sections[pos.si] = { ...sec, slides };
  return { ...p, sections };
}

/** `p` with `fn` applied to one object; `p` itself when it is missing or `fn` returns it unchanged. */
export function withObject(
  p: Presentation,
  slideId: string,
  objectId: string,
  fn: (o: SlideObject) => SlideObject,
): Presentation {
  return withSlide(p, slideId, (s) => {
    const i = s.objects.findIndex((o) => o.id === objectId);
    if (i < 0) return s;
    const o = s.objects[i]!;
    const next = fn(o);
    if (next === o) return s;
    const objects = [...s.objects];
    objects[i] = next;
    return { ...s, objects };
  });
}

/** `p` with `fn` applied to every slide, in authoring order; `p` itself when no slide changes. */
export function withEverySlide(p: Presentation, fn: (s: Slide) => Slide): Presentation {
  let changed = false;
  const sections = p.sections.map((sec) => {
    let secChanged = false;
    const slides = sec.slides.map((s) => {
      const next = fn(s);
      if (next !== s) secChanged = true;
      return next;
    });
    if (!secChanged) return sec;
    changed = true;
    return { ...sec, slides };
  });
  return changed ? { ...p, sections } : p;
}
