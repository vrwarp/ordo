import {
  type Box,
  DEFAULT_THEME,
  type ImageObject,
  newId,
  type Presentation,
  type Section,
  type ShapeObject,
  type Slide,
  type SlideObject,
  type TextObject,
  type TextStyle,
  type Theme,
} from '@ordo/domain';
import { moveItem } from '../../lib/arrangement.ts';

/** Pure presentation editing operations used by the editor. Each returns a new presentation. */

export type SlidePos = { si: number; i: number };

export function findSlide(p: Presentation, slideId: string): SlidePos | null {
  for (let si = 0; si < p.sections.length; si++) {
    const i = p.sections[si]!.slides.findIndex((s) => s.id === slideId);
    if (i >= 0) return { si, i };
  }
  return null;
}

export function getSlide(p: Presentation, slideId: string | undefined): Slide | undefined {
  if (!slideId) return undefined;
  const pos = findSlide(p, slideId);
  return pos ? p.sections[pos.si]!.slides[pos.i] : undefined;
}

function mapSection(p: Presentation, si: number, fn: (s: Section) => Section): Presentation {
  return { ...p, sections: p.sections.map((s, k) => (k === si ? fn(s) : s)) };
}

export function updateSlide(p: Presentation, slideId: string, fn: (s: Slide) => Slide): Presentation {
  const pos = findSlide(p, slideId);
  if (!pos) return p;
  return mapSection(p, pos.si, (sec) => ({
    ...sec,
    slides: sec.slides.map((s, k) => (k === pos.i ? fn(s) : s)),
  }));
}

export function updateObject(
  p: Presentation,
  slideId: string,
  objectId: string,
  fn: (o: SlideObject) => SlideObject,
): Presentation {
  return updateSlide(p, slideId, (s) => ({
    ...s,
    objects: s.objects.map((o) => (o.id === objectId ? fn(o) : o)),
  }));
}

export function themeOf(p: Presentation, themes: Theme[]): Theme {
  return themes.find((t) => t.id === p.themeId) ?? themes[0] ?? DEFAULT_THEME;
}

export function newSlideFor(p: Presentation, theme: Theme, text = ''): Slide {
  if (p.kind === 'song') {
    const objId = newId();
    return {
      id: newId(),
      objects: [
        { id: objId, type: 'text', box: { ...theme.lyricBox }, text, style: { ...theme.text }, opacity: 1 },
      ],
      lyricObjectId: objId,
    };
  }
  return { id: newId(), objects: text ? [newText(theme, text)] : [] };
}

export function addSlide(
  p: Presentation,
  sectionId: string,
  theme: Theme,
  afterSlideId?: string,
): Presentation {
  const si = p.sections.findIndex((s) => s.id === sectionId);
  if (si < 0) return p;
  const slide = newSlideFor(p, theme);
  return mapSection(p, si, (sec) => {
    const at = afterSlideId ? sec.slides.findIndex((s) => s.id === afterSlideId) + 1 : sec.slides.length;
    const slides = [...sec.slides];
    slides.splice(at <= 0 ? slides.length : at, 0, slide);
    return { ...sec, slides };
  });
}

/** Deep-copy a slide with fresh ids. */
export function cloneSlide(s: Slide): Slide {
  const idMap = new Map<string, string>();
  const objects = s.objects.map((o) => {
    const id = newId();
    idMap.set(o.id, id);
    return { ...structuredClone(o), id };
  });
  return {
    ...structuredClone(s),
    id: newId(),
    objects,
    lyricObjectId: s.lyricObjectId ? idMap.get(s.lyricObjectId) : undefined,
  };
}

export function duplicateSlide(p: Presentation, slideId: string): Presentation {
  const pos = findSlide(p, slideId);
  if (!pos) return p;
  return mapSection(p, pos.si, (sec) => {
    const slides = [...sec.slides];
    slides.splice(pos.i + 1, 0, cloneSlide(sec.slides[pos.i]!));
    return { ...sec, slides };
  });
}

export function deleteSlide(p: Presentation, slideId: string): Presentation {
  const pos = findSlide(p, slideId);
  if (!pos) return p;
  return mapSection(p, pos.si, (sec) => ({ ...sec, slides: sec.slides.filter((s) => s.id !== slideId) }));
}

export function moveSlide(
  p: Presentation,
  slideId: string,
  toSectionId: string,
  toIndex: number,
): Presentation {
  const pos = findSlide(p, slideId);
  const ti = p.sections.findIndex((s) => s.id === toSectionId);
  if (!pos || ti < 0) return p;
  const slide = p.sections[pos.si]!.slides[pos.i]!;
  if (pos.si === ti)
    return mapSection(p, ti, (sec) => ({ ...sec, slides: moveItem(sec.slides, pos.i, toIndex) }));
  let out = deleteSlide(p, slideId);
  out = mapSection(out, ti, (sec) => {
    const slides = [...sec.slides];
    slides.splice(Math.max(0, Math.min(toIndex, slides.length)), 0, slide);
    return { ...sec, slides };
  });
  return out;
}

export function lyricObject(s: Slide): TextObject | undefined {
  const o = s.lyricObjectId ? s.objects.find((x) => x.id === s.lyricObjectId) : undefined;
  if (o?.type === 'text') return o;
  return s.objects.find((x): x is TextObject => x.type === 'text');
}

/**
 * Split a slide's lyric text into two slides at line `atLine` (default: the middle). The new slide copies
 * the original's objects with fresh ids and takes the remaining lines.
 */
export function splitSlide(p: Presentation, slideId: string, atLine?: number): Presentation {
  const pos = findSlide(p, slideId);
  if (!pos) return p;
  const slide = p.sections[pos.si]!.slides[pos.i]!;
  const lyric = lyricObject(slide);
  if (!lyric) return p;
  const lines = lyric.text.split('\n');
  if (lines.length < 2) return p;
  const cut = Math.max(1, Math.min(lines.length - 1, atLine ?? Math.ceil(lines.length / 2)));
  const first = lines.slice(0, cut).join('\n');
  const second = lines.slice(cut).join('\n');
  const a: Slide = {
    ...slide,
    objects: slide.objects.map((o) => (o.id === lyric.id ? { ...lyric, text: first } : o)),
  };
  const bBase = cloneSlide(slide);
  const bLyric = lyricObject(bBase)!;
  const b: Slide = {
    ...bBase,
    objects: bBase.objects.map((o) => (o.id === bLyric.id ? { ...bLyric, text: second } : o)),
  };
  return mapSection(p, pos.si, (sec) => {
    const slides = [...sec.slides];
    slides.splice(pos.i, 1, a, b);
    return { ...sec, slides };
  });
}

/** Merge a slide with the next slide of its section: lyric texts joined, the next slide removed. */
export function mergeWithNext(p: Presentation, slideId: string): Presentation {
  const pos = findSlide(p, slideId);
  if (!pos) return p;
  const sec = p.sections[pos.si]!;
  const a = sec.slides[pos.i]!;
  const b = sec.slides[pos.i + 1];
  if (!b) return p;
  const la = lyricObject(a);
  const lb = lyricObject(b);
  if (!la) return p;
  const text = [la.text, lb?.text ?? ''].filter((t) => t.trim()).join('\n');
  const merged: Slide = { ...a, objects: a.objects.map((o) => (o.id === la.id ? { ...la, text } : o)) };
  return mapSection(p, pos.si, (s) => {
    const slides = [...s.slides];
    slides.splice(pos.i, 2, merged);
    return { ...s, slides };
  });
}

export function addSection(p: Presentation, label: string, short: string, theme: Theme): Presentation {
  const section: Section = { id: newId(), label, short, slides: [newSlideFor(p, theme)] };
  const authoring = p.sections.map((s) => s.id).join(',');
  const arrangements = p.arrangements.map((a, i) =>
    i === 0 && a.sectionIds.join(',') === authoring ? { ...a, sectionIds: [...a.sectionIds, section.id] } : a,
  );
  return { ...p, sections: [...p.sections, section], arrangements };
}

export function renameSection(
  p: Presentation,
  sectionId: string,
  label: string,
  short: string,
): Presentation {
  return { ...p, sections: p.sections.map((s) => (s.id === sectionId ? { ...s, label, short } : s)) };
}

export function deleteSection(p: Presentation, sectionId: string): Presentation {
  return {
    ...p,
    sections: p.sections.filter((s) => s.id !== sectionId),
    arrangements: p.arrangements.map((a) => ({
      ...a,
      sectionIds: a.sectionIds.filter((id) => id !== sectionId),
    })),
  };
}

export function moveSection(p: Presentation, from: number, to: number): Presentation {
  return { ...p, sections: moveItem(p.sections, from, to) };
}

// ---- objects ----

export function newText(theme: Theme, text = 'Text'): TextObject {
  return {
    id: newId(),
    type: 'text',
    box: { x: 360, y: 390, w: 1200, h: 300, rotation: 0 },
    text,
    style: { ...theme.textBoxDefaults },
    opacity: 1,
  };
}

export function newImage(mediaId: string, box?: Box): ImageObject {
  return {
    id: newId(),
    type: 'image',
    box: box ?? { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
    mediaId,
    fit: 'contain',
    opacity: 1,
    radius: 0,
  };
}

export function newShape(shape: ShapeObject['shape']): ShapeObject {
  return {
    id: newId(),
    type: 'shape',
    box:
      shape === 'line'
        ? { x: 460, y: 530, w: 1000, h: 20, rotation: 0 }
        : { x: 660, y: 340, w: 600, h: 400, rotation: 0 },
    shape,
    fill: shape === 'line' ? undefined : { r: 40, g: 90, b: 200, a: 1 },
    stroke: shape === 'line' ? { width: 6, color: { r: 255, g: 255, b: 255, a: 1 } } : undefined,
    opacity: 1,
    radius: 0,
  };
}

export function addObject(p: Presentation, slideId: string, o: SlideObject): Presentation {
  return updateSlide(p, slideId, (s) => ({ ...s, objects: [...s.objects, o] }));
}

export function deleteObject(p: Presentation, slideId: string, objectId: string): Presentation {
  return updateSlide(p, slideId, (s) => ({
    ...s,
    objects: s.objects.filter((o) => o.id !== objectId),
    lyricObjectId: s.lyricObjectId === objectId ? undefined : s.lyricObjectId,
  }));
}

export function duplicateObject(
  p: Presentation,
  slideId: string,
  objectId: string,
): { p: Presentation; id?: string } {
  const s = getSlide(p, slideId);
  const o = s?.objects.find((x) => x.id === objectId);
  if (!s || !o) return { p };
  const copy = { ...structuredClone(o), id: newId() } as SlideObject;
  copy.box = { ...copy.box, x: copy.box.x + 20, y: copy.box.y + 20 };
  const i = s.objects.indexOf(o);
  return {
    p: updateSlide(p, slideId, (sl) => {
      const objects = [...sl.objects];
      objects.splice(i + 1, 0, copy);
      return { ...sl, objects };
    }),
    id: copy.id,
  };
}

export type ZOrder = 'front' | 'back' | 'forward' | 'backward';

export function reorderObject(p: Presentation, slideId: string, objectId: string, z: ZOrder): Presentation {
  return updateSlide(p, slideId, (s) => {
    const i = s.objects.findIndex((o) => o.id === objectId);
    if (i < 0) return s;
    const last = s.objects.length - 1;
    const to =
      z === 'front' ? last : z === 'back' ? 0 : z === 'forward' ? Math.min(last, i + 1) : Math.max(0, i - 1);
    return { ...s, objects: moveItem(s.objects, i, to) };
  });
}

// ---- themes and overrides ----

/** Record that a lyric-object property differs from the theme (path like `style.fontSizePx` or `box`). */
export function markOverride(s: Slide, path: string): Slide {
  const cur = s.overrides ?? [];
  return cur.includes(path) ? s : { ...s, overrides: [...cur, path] };
}

function themedLyric(o: TextObject, theme: Theme, overrides: string[]): TextObject {
  const style: TextStyle = { ...o.style };
  for (const k of Object.keys(theme.text) as (keyof TextStyle)[]) {
    if (!overrides.includes(`style.${k}`)) (style as Record<string, unknown>)[k] = theme.text[k];
  }
  for (const k of ['outline', 'shadow', 'fill'] as const) {
    if (!(k in theme.text) && !overrides.includes(`style.${k}`)) delete style[k];
  }
  return { ...o, box: overrides.includes('box') ? o.box : { ...theme.lyricBox }, style };
}

/** Apply a theme: every slide's lyric box takes the theme's geometry and style except overridden properties. */
export function applyTheme(p: Presentation, theme: Theme): Presentation {
  return {
    ...p,
    themeId: theme.id,
    sections: p.sections.map((sec) => ({
      ...sec,
      slides: sec.slides.map((s) => applyThemeToSlide(s, theme)),
    })),
  };
}

export function applyThemeToSlide(s: Slide, theme: Theme): Slide {
  const lyric = lyricObject(s);
  if (!lyric) return s;
  const themed = themedLyric(lyric, theme, s.overrides ?? []);
  return { ...s, objects: s.objects.map((o) => (o.id === lyric.id ? themed : o)) };
}

/** Remove a slide's overrides and re-apply the theme. */
export function resetSlideToTheme(s: Slide, theme: Theme): Slide {
  return applyThemeToSlide({ ...s, overrides: undefined }, theme);
}

/** How many lyric slides would change if the theme were applied (for the confirm dialog). */
export function themeChangeCount(p: Presentation, theme: Theme): number {
  let n = 0;
  for (const sec of p.sections)
    for (const s of sec.slides) {
      const after = applyThemeToSlide(s, theme);
      if (JSON.stringify(after) !== JSON.stringify(s)) n++;
    }
  return n;
}

export function allSlides(p: Presentation): { slide: Slide; section: Section; index: number }[] {
  const out: { slide: Slide; section: Section; index: number }[] = [];
  for (const section of p.sections)
    section.slides.forEach((slide, index) => {
      out.push({ slide, section, index });
    });
  return out;
}
