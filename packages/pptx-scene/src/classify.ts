/**
 * Classification (design/27 §5): the census tier of a slide with its reasons, and its class.
 *
 * The tiers are the census of design/27 "Why this design" (4,897 shown worship slides): T1 30.9 %,
 * T1+T2 73.3 %, T1-T3 87.6 %, T1-T4 92.5 %, T1-T5 95.8 %, fallback 4.2 %. A slide's features are those
 * of its own shape tree plus, as `deco:<feature>`, those of the layout and master decorations it shows
 * (non-placeholder shapes, honouring `showMasterSp`); the tier is decided by the union.
 *
 * Owned by work item F (classify). The scaffold has the tier rules and the element-name features; still to
 * do: the attribute features (vert, warp, rtl, superSub, crop, the `preset:other` and `pic:<ext>` checks),
 * mixedRuns, shadow and outline, per-element support, the art z-range, size budgets (§3.4), and a test that
 * reproduces the census on synthetic slides.
 */
import type { SlideCtx } from './context.ts';
import type { Background, Classification, Element, Tier } from './ir.ts';
import { placeholderOf } from './inherit.ts';
import { path, type XNode } from './xml.ts';

/** Features that send a slide to LibreOffice (picture or residual art) whatever the milestone. */
export const FALLBACK_FEATURES: ReadonlySet<string> = new Set([
  'table',
  'chart',
  'smartart',
  'ole',
  '3d',
  'warp',
  'math',
  'ink',
  'pic:emf',
  'pic:wmf',
  'pic:tif',
  'pic:tiff',
  'pic:wdp',
  'pic:hdp',
]);

/** For each tier, the features a slide of that tier may not have (census `tiers.py`). */
export const TIER_BLOCKERS: ReadonlyArray<[Exclude<Tier, 'fallback'>, ReadonlySet<string>]> = [
  [
    'T1',
    new Set([
      'group',
      'altcontent',
      'connector',
      'custGeom',
      'gradFill',
      'pattFill',
      'video',
      'vert',
      'glow',
      'reflection',
      'softEdge',
      'innerShdw',
      'recolor',
      'lum',
      'bullet',
      'rtl',
      'superSub',
      'tile',
      'mixedRuns',
      'preset:other',
      'crop',
      'pic:bmp',
    ]),
  ],
  [
    'T2',
    new Set([
      'group',
      'altcontent',
      'connector',
      'custGeom',
      'gradFill',
      'pattFill',
      'video',
      'vert',
      'glow',
      'reflection',
      'softEdge',
      'innerShdw',
      'recolor',
      'lum',
      'tile',
      'preset:other',
    ]),
  ],
  ['T3', new Set(['video', 'vert', 'glow', 'reflection', 'softEdge', 'innerShdw', 'recolor', 'lum', 'tile'])],
  ['T4', new Set(['vert', 'reflection', 'softEdge', 'innerShdw', 'tile', 'recolor'])],
];

/**
 * The tier of a feature set, and the reasons: the features (as given, `deco:` kept) that keep it out of
 * the tier below. Unknown features block nothing.
 */
export function tierOf(features: ReadonlySet<string>): { tier: Tier; reasons: string[] } {
  const bare = (f: string) => (f.startsWith('deco:') ? f.slice(5) : f);
  const hit = (set: ReadonlySet<string>) => [...features].filter((f) => set.has(bare(f))).sort();
  const fallback = hit(FALLBACK_FEATURES);
  if (fallback.length) return { tier: 'fallback', reasons: fallback };
  let reasons: string[] = [];
  for (const [tier, blockers] of TIER_BLOCKERS) {
    const blocked = hit(blockers);
    if (!blocked.length) return { tier, reasons };
    reasons = blocked;
  }
  return { tier: 'T5', reasons };
}

/** Element names that are a feature wherever they appear (scaffold subset of the census rules). */
const ELEMENT_FEATURES: ReadonlyMap<string, string> = new Map([
  ['p:grpSp', 'group'],
  ['a:tbl', 'table'],
  ['p:oleObj', 'ole'],
  ['mc:AlternateContent', 'altcontent'],
  ['p:cxnSp', 'connector'],
  ['a:custGeom', 'custGeom'],
  ['a:gradFill', 'gradFill'],
  ['a:pattFill', 'pattFill'],
  ['a:videoFile', 'video'],
  ['a:audioFile', 'video'],
  ['p14:media', 'video'],
  ['a:sp3d', '3d'],
  ['a:scene3d', '3d'],
  ['a:glow', 'glow'],
  ['a:reflection', 'reflection'],
  ['a:softEdge', 'softEdge'],
  ['a:innerShdw', 'innerShdw'],
  ['a:duotone', 'recolor'],
  ['a:clrChange', 'recolor'],
  ['a:grayscl', 'recolor'],
  ['a:biLevel', 'recolor'],
  ['a:lum', 'lum'],
  ['a14:imgEffect', 'artistic'],
  ['a14:imgLayer', 'artistic'],
  ['a:buChar', 'bullet'],
  ['a:buAutoNum', 'bullet'],
  ['a:tile', 'tile'],
  ['m:oMath', 'math'],
  ['a14:m', 'math'],
  ['p:contentPart', 'ink'],
]);

/** Features of one subtree (iterative: the tree is bounded by the parser, not by the stack). */
export function featuresOf(root: XNode | undefined, prefix = '', out = new Set<string>()): Set<string> {
  const stack = root ? [root] : [];
  while (stack.length) {
    const n = stack.pop()!;
    const f = ELEMENT_FEATURES.get(n.name);
    if (f) out.add(prefix + f);
    if (n.name === 'a:graphicData') {
      const uri = n.attrs.uri ?? '';
      if (uri.endsWith('drawingml/2006/chart')) out.add(`${prefix}chart`);
      if (uri.endsWith('drawingml/2006/diagram')) out.add(`${prefix}smartart`);
    }
    for (const c of n.children) if (c.name !== '#text') stack.push(c);
  }
  return out;
}

/** The census features of a slide: its own shape tree, plus `deco:` features of the decorations it shows. */
export function slideFeatures(ctx: SlideCtx): Set<string> {
  const out = featuresOf(path(ctx.slide, 'p:cSld', 'p:spTree'));
  const shows = (n: XNode | undefined) => n?.attrs.showMasterSp !== '0' && n?.attrs.showMasterSp !== 'false';
  if (!shows(ctx.slide)) return out;
  const deco = (root: XNode | undefined) => {
    for (const el of path(root, 'p:cSld', 'p:spTree')?.children ?? [])
      if (el.name !== '#text' && !placeholderOf(el)) featuresOf(el, 'deco:', out);
  };
  deco(ctx.layout);
  if (shows(ctx.layout)) deco(ctx.master);
  return out;
}

/** Tier, class and reasons of a slide that was read. */
export function classifySlide(ctx: SlideCtx, elements: Element[], _background: Background): Classification {
  const { tier, reasons } = tierOf(slideFeatures(ctx));
  const residual = elements.some((e) => e.kind === 'residual');
  return { tier, class: residual ? 'hybrid' : 'native', reasons };
}
