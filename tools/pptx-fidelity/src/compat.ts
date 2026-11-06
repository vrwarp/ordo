/**
 * `--lo-compat` (design/27 §14.1, harness only): draw like LibreOffice where ordo's policy, which follows
 * PowerPoint, differs from it (design/20 "Fidelity", design/27 §17 "LibreOffice is not PowerPoint"). Each
 * rule is reported on its own (`policy` in the report), so a gain from drawing like LibreOffice is never
 * mistaken for progress of the converter or the engine.
 *
 * - `runShadow`: LibreOffice draws no run's own text shadow (PowerPoint's "Text Shadow"). A shadow an
 *   unfilled shape casts on its text stays: it is the shape's (`ShapeElement.shadow`), not the run's.
 * - `textOutline`: an outline on filled text is not drawn. LibreOffice would hollow the letters; the
 *   harness's pictures are made from `pptxForRendering`'s copy, which removes such outlines first (as the
 *   hub's render copy does, design/27 §5), so the picture shows the fill alone. Hollow text (no fill) keeps
 *   its outline, in both.
 * - `refit`: LibreOffice ignores PowerPoint's stored `normAutofit` scale and fits the text again from full
 *   size; ordo keeps the stored scale while the text fits at it. A shrinking text object loses its
 *   `fitScale`, so the engine runs LibreOffice's search from full size. Objects that do not shrink (a
 *   converter that bakes the scale into the font size) are left alone.
 *
 * The first two apply to the scene IR before emission (only there are a run's shadow and its shape's told
 * apart); `refit` applies to the emitted slide. Nothing is mutated: changed parts are copied.
 */
import type { Slide } from '@ordo/domain';
import type { DeckScene, Element, Para, RunStyle, SlideScene, TextBody } from '@ordo/pptx-scene';

export const COMPAT_RULES = ['runShadow', 'textOutline', 'refit'] as const;
export type CompatRule = (typeof COMPAT_RULES)[number];

/** What each rule changes, for the report. */
export const COMPAT_RULE_TEXT: Readonly<Record<CompatRule, string>> = {
  runShadow: "no run's own text shadow (a shadow an unfilled shape casts stays)",
  textOutline: 'no outline on filled text (removed before LibreOffice draws; it would hollow the letters)',
  refit: 'the stored autofit scale ignored: text fitted again from full size',
};

type IrRule = Exclude<CompatRule, 'refit'>;

/** A run style as LibreOffice draws it, and the rules that changed it. */
function compatStyle(s: RunStyle, hit: Set<IrRule>): RunStyle {
  const dropShadow = s.shadow !== undefined;
  const dropOutline = s.outline !== undefined && s.fill.kind !== 'none';
  if (!dropShadow && !dropOutline) return s;
  const out = { ...s };
  if (dropShadow) {
    delete out.shadow;
    hit.add('runShadow');
  }
  if (dropOutline) {
    delete out.outline;
    hit.add('textOutline');
  }
  return out;
}

function compatPara(p: Para, hit: Set<IrRule>): Para {
  let changed = false;
  const runs = p.runs.map((r) => {
    const local = new Set<IrRule>();
    const style = compatStyle(r.style, local);
    if (style === r.style) return r;
    changed = true;
    // Only runs that draw something count as hits; the end mark only sizes an empty paragraph.
    if (r.kind !== 'break' && r.text.trim()) for (const h of local) hit.add(h);
    return { ...r, style };
  });
  const end = compatStyle(p.end, new Set());
  if (end !== p.end) changed = true;
  return changed ? { ...p, runs, end } : p;
}

function compatBody(t: TextBody, hit: Set<IrRule>): TextBody {
  let changed = false;
  const paras = t.paras.map((p) => {
    const q = compatPara(p, hit);
    if (q !== p) changed = true;
    return q;
  });
  return changed ? { ...t, paras } : t;
}

function compatElement(e: Element, hit: Set<IrRule>): Element {
  if (e.kind !== 'shape' || !e.text) return e;
  const text = compatBody(e.text, hit);
  return text === e.text ? e : { ...e, text };
}

/**
 * The scene with LibreOffice's text policies (`runShadow`, `textOutline`), and per slide index the rules
 * that changed a run with text on it. Slides nothing changed are the same objects.
 */
export function loCompatScene(scene: DeckScene): {
  scene: DeckScene;
  hits: Map<number, Set<CompatRule>>;
} {
  const hits = new Map<number, Set<CompatRule>>();
  const slides = scene.slides.map((s): SlideScene => {
    const hit = new Set<IrRule>();
    let changed = false;
    const elements = s.elements.map((e) => {
      const c = compatElement(e, hit);
      if (c !== e) changed = true;
      return c;
    });
    if (hit.size) hits.set(s.index, new Set(hit));
    return changed ? { ...s, elements } : s;
  });
  return { scene: hits.size ? { ...scene, slides } : scene, hits };
}

/** The slide with every shrinking text object fitted from full size (`refit`), or undefined when none is. */
export function refitSlide(slide: Slide): Slide | undefined {
  let changed = false;
  const objects = slide.objects.map((o) => {
    if (o.type !== 'text' || o.style.autofit !== 'shrink' || !o.style.fitScale) return o;
    changed = true;
    const { fitScale: _, ...style } = o.style;
    return { ...o, style };
  });
  return changed ? { ...slide, objects } : undefined;
}

/** Slide JSON without object ids (two emissions number objects alike only while their counts agree). */
export function drawingKey(slide: Slide): string {
  return JSON.stringify(slide, (k, v) => (k === 'id' || k.endsWith('ObjectId') ? undefined : v));
}
