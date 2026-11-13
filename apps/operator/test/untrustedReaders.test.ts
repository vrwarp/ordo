/**
 * #24's readers of slide objects that never wait for a panel to open (design/21: a pasted object is untrusted
 * input): the floating bar reads `o.style` and `o.text` as soon as an object is selected, the hidden backing
 * text field reads `o.text`, the deck swatches read every text and shape colour whenever a paint picker
 * opens, and the Tune drawer's Object panel reads every field. Every object the paste keeps (`pastedObject`:
 * the slide object schema, the importers' sanitizer and the render clamp) out of thousands of mutated
 * objects (8,000 mutations of text with runs and lists, shapes with gradients and geometry, pictures, video, M9 tables, charts
 * and decorations) renders through all four without throwing.
 */
import { DEFAULT_THEME, type Presentation, type SlideObject } from '@ordo/domain';
import { m9Slide } from '@ordo/domain/m9.test-util.ts';
import { sanitizeObject } from '@ordo/importers/sanitize.ts';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { deckColors } from '../src/components/deckSwatches.ts';
import { useEditor } from '../src/views/editor/editorStore.ts';
import { FloatingContextBar } from '../src/views/editor/FloatingContextBar.tsx';
import { ObjectPanel } from '../src/views/editor/ObjectPanel.tsx';
import { pastedObject } from '../src/views/editor/ops/clipboard.ts';
import { CanvasBackingTextEditor } from '../src/views/editor/SlideCanvas.tsx';

const box = { x: 100, y: 100, w: 800, h: 300, rotation: 0 };
const red = { r: 200, g: 0, b: 0, a: 1 };
const SEEDS: SlideObject[] = [
  {
    id: 't',
    type: 'text',
    box,
    text: 'Amazing grace\nhow sweet the sound',
    style: {
      ...DEFAULT_THEME.textBoxDefaults,
      outline: { width: 4, color: red },
      shadow: { dx: 0, dy: 4, blur: 12, color: red },
      autofit: 'shrink',
    },
    runs: [{ start: 8, end: 13, fontWeight: 700, color: red, highlight: red }],
    paras: [{ bullet: { auto: 'arabicPeriod' } }, { align: 'center', level: 1 }],
    opacity: 1,
  } as SlideObject,
  {
    id: 'sh',
    type: 'shape',
    box,
    shape: 'rect',
    fill: red,
    stroke: { width: 3, color: red },
    dash: 'dash',
    gradient: {
      kind: 'linear',
      angle: 45,
      stops: [
        { at: 0, color: red },
        { at: 1, color: { r: 0, g: 0, b: 200, a: 1 } },
      ],
    },
    opacity: 1,
    radius: 8,
    origin: { src: 'pptx', shapeId: 3, group: 1 },
  } as SlideObject,
  {
    id: 'img',
    type: 'image',
    box,
    mediaId: 'm1',
    fit: 'cover',
    crop: { l: 0.1, t: 0.1, r: 0.1, b: 0.1 },
    opacity: 1,
    radius: 0,
  } as SlideObject,
  {
    id: 'vid',
    type: 'image',
    box,
    mediaId: 'm2',
    fit: 'contain',
    play: { mediaId: 'v1', loop: true },
    opacity: 1,
    radius: 0,
  } as SlideObject,
  ...m9Slide().objects,
];

// mulberry32: deterministic, so a failure reproduces.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ODD: unknown[] = [null, undefined, Number.NaN, -1e300, 1e12, -1, 0, '', 'x'.repeat(300), [], {}, true];
function mutate(v: unknown, r: () => number, depth = 0): unknown {
  if ((depth > 0 && r() < 0.1) || depth > 6) return ODD[Math.floor(r() * ODD.length)];
  if (Array.isArray(v)) {
    if (!v.length) return r() < 0.5 ? [ODD[Math.floor(r() * ODD.length)]] : v;
    const out = v.slice();
    const i = Math.floor(r() * out.length);
    out[i] = mutate(out[i], r, depth + 1);
    return out;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return v;
    const out = { ...(v as Record<string, unknown>) };
    for (let n = 1 + Math.floor(r() * 2); n > 0; n--) {
      const k = keys[Math.floor(r() * keys.length)]!;
      if (r() < 0.15) delete out[k];
      else out[k] = mutate(out[k], r, depth + 1);
    }
    return out;
  }
  return ODD[Math.floor(r() * ODD.length)];
}

function deck(o: SlideObject, kind: Presentation['kind'] = 'slides'): Presentation {
  return {
    id: 'p',
    rev: 1,
    title: 'Fuzz',
    kind,
    meta: { tags: [] },
    sections: [{ id: 'sec', label: 'S', short: 'S', slides: [{ id: 's1', objects: [o] }] }],
    arrangements: [],
    archived: false,
    ...(kind === 'song' ? { themeId: DEFAULT_THEME.id } : {}),
  } as Presentation;
}

/** A server render with the store's server snapshot (its initial state) holding `p` with `o` selected. */
function render(p: Presentation, o: SlideObject, el: ReactElement, range = { start: 0, end: 0 }): string {
  Object.assign(useEditor.getInitialState(), {
    id: p.id,
    draft: p,
    slideId: 's1',
    objectId: o.id,
    objectIds: [o.id],
    textRange: range,
  });
  return renderToStaticMarkup(el);
}
const initial = { ...useEditor.getInitialState() };
afterEach(() => {
  Object.assign(useEditor.getInitialState(), initial);
});

describe('every object the paste keeps renders through the readers that need no panel', () => {
  it('the seeds themselves pass and render', () => {
    for (const seed of SEEDS) expect(pastedObject(seed, sanitizeObject), seed.id).toBeDefined();
  });

  it('thousands of mutated objects: none throws in the floating bar, backing field, swatches or panel', () => {
    const r = rng(24);
    let kept = 0;
    const kinds = new Set<string>();
    for (let i = 0; i < 8000; i++) {
      const seed = SEEDS[i % SEEDS.length]!;
      const raw = mutate(structuredClone(seed), r);
      const o = pastedObject(raw, sanitizeObject);
      if (!o) continue;
      kept++;
      kinds.add(`${o.type}:${'table' in o && o.table ? 'table' : 'chart' in o && o.chart ? 'chart' : ''}`);
      const p = deck(o, i % 3 === 0 ? 'song' : 'slides');
      const where = JSON.stringify(raw).slice(0, 400);
      expect(() => deckColors(p, DEFAULT_THEME), where).not.toThrow();
      expect(
        () =>
          render(
            p,
            o,
            createElement(FloatingContextBar, {
              readOnly: false,
              drawerOpen: false,
              onToggleDrawer: () => {},
            }),
          ),
        where,
      ).not.toThrow();
      if (o.type === 'text') {
        expect(
          () => render(p, o, createElement(CanvasBackingTextEditor, { obj: o, readOnly: false })),
          where,
        ).not.toThrow();
        // A selection inside the text switches the bar and the panel to Selection scope.
        const range = { start: 0, end: Math.min(3, o.text.length) };
        expect(
          () =>
            render(
              p,
              o,
              createElement(FloatingContextBar, {
                readOnly: false,
                drawerOpen: false,
                onToggleDrawer: () => {},
              }),
              range,
            ),
          where,
        ).not.toThrow();
      }
      expect(() => render(p, o, createElement(ObjectPanel, { o, readOnly: false })), where).not.toThrow();
    }
    // The mutations keep enough objects of every kind for the check to mean something.
    expect(kept).toBeGreaterThan(1000);
    expect(kinds.size).toBeGreaterThanOrEqual(4);
  }, 120_000);
});
