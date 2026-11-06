/**
 * Classification (design/27 §5): the census tier of a slide with its reasons, the support of each element,
 * and the slide class with the art range of a hybrid slide.
 *
 * **Tiers** are the census of design/27 "Why this design" (4,897 shown worship slides): T1 30.9 %,
 * T1+T2 73.3 %, T1-T3 87.6 %, T1-T4 92.5 %, T1-T5 95.8 %, fallback 4.2 %. They measure coverage by feature
 * use, whatever the converter does today. A slide's features are those of its own shape tree, plus, as
 * `deco:<feature>`, those of the layout and master decorations it shows (non-placeholder shapes, honouring
 * `showMasterSp`); the tier is decided by the union. Backgrounds (`p:bg`) are not part of the census.
 *
 * **Support** (`native` / `approx` / `residual`) is per element: the reader's own verdict (`walk.ts`: presets
 * and fills it cannot draw yet, sheared group children) combined with the rules of §5 (charts, tables,
 * SmartArt, OLE, maths, real 3D, WordArt warps, vertical and multi-column text, HD Photo pictures are residual;
 * reflections, inner shadows, soft edges on pictures and metafiles waiting for conversion are approx).
 *
 * **Class**: native without residual elements; hybrid with them, the residuals and what they overlap baked
 * into one art picture over the range [Rmin, Rmax]; picture when the objects or pictures left after the
 * split exceed the slide budgets (or the slide could not be read, `index.ts`).
 *
 * Every walk here is iterative and linear in the size of the parsed tree; deck strings are only compared,
 * never used as plain-object keys.
 */
import { rootOf, type SlideCtx } from './context.ts';
import { bodyPrChain, chainOf, firstAttr, firstChildOf, nvOf } from './inherit.ts';
import type {
  ArtRange,
  Background,
  Classification,
  Element,
  RectEmu,
  SlideClass,
  Support,
  Tier,
} from './ir.ts';
import { clean } from './log.ts';
import { child, num, path, textOf, type XNode } from './xml.ts';

/** Reasons are short words; one built from a deck string is cleaned and cut to this (design/27 §12 "Logs"). */
const MAX_REASON_CHARS = 60;

// ── Census features and tiers ───────────────────────────────────────────────────────────────────────────

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

/** For each tier, the features a slide of that tier may not have (the census's tier rules). */
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
 * The tier of a feature set, and the reasons: the features (as given, `deco:` kept, sorted) that keep it
 * out of the tier below. Unknown features (and `artistic`, `shadow`, `outline`, which no tier blocks) block
 * nothing.
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

/** Elements that are a feature wherever they appear in a shape tree (the census's element rules). */
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
  ['a14:m', 'math'],
  ['p:contentPart', 'ink'],
]);

/** Presets that are not `preset:other`. */
const BASIC_PRESETS: ReadonlySet<string> = new Set(['rect', 'roundRect', 'ellipse', 'line']);

/** Picture formats that are a feature (`pic:<ext>`), by the extension of the blip's part. */
const PICTURE_FEATURES: ReadonlySet<string> = new Set(['emf', 'wmf', 'tif', 'tiff', 'wdp', 'hdp', 'bmp']);

/** Run-property attributes that do not make runs look different (`mixedRuns`). */
const NEUTRAL_RUN_ATTRS: ReadonlySet<string> = new Set([
  'lang',
  'altLang',
  'dirty',
  'err',
  'noProof',
  'smtClean',
  'kern',
  'bmk',
]);

/** An attribute's local name (`a:vert` → `vert`). */
const local = (k: string) => k.slice(k.indexOf(':') + 1);

/** The extension of a part name, lower case. */
function extOf(part: string): string {
  const dot = part.lastIndexOf('.');
  return dot > part.lastIndexOf('/') ? part.slice(dot + 1).toLowerCase() : '';
}

/** Push a node's element children onto a stack. */
function pushChildren(stack: XNode[], n: XNode): void {
  for (const c of n.children) if (c.name !== '#text') stack.push(c);
}

/**
 * The census features of one subtree that any shape tree can have, decorations included: element features,
 * the attribute features (`vert` other than horz, `rtl="1"`, a non-zero `baseline`, a chart or diagram
 * `graphicData`, a `prstTxWarp` other than `textNoShape`) and `preset:other`. Iterative: the tree is
 * bounded by the parser, not by the stack.
 */
export function featuresOf(root: XNode | undefined, prefix = '', out = new Set<string>()): Set<string> {
  const stack = root ? [root] : [];
  while (stack.length) {
    const n = stack.pop()!;
    const f = ELEMENT_FEATURES.get(n.name);
    if (f) out.add(prefix + f);
    if (n.name.startsWith('m:oMath')) out.add(`${prefix}math`);
    if (n.name === 'a:prstTxWarp' && n.attrs.prst !== 'textNoShape') out.add(`${prefix}warp`);
    if (n.name === 'a:prstGeom' && n.attrs.prst && !BASIC_PRESETS.has(n.attrs.prst))
      out.add(`${prefix}preset:other`);
    for (const k in n.attrs) {
      const v = n.attrs[k]!;
      if (v.endsWith('drawingml/2006/chart')) out.add(`${prefix}chart`);
      else if (v.endsWith('drawingml/2006/diagram')) out.add(`${prefix}smartart`);
      switch (k.includes(':') ? local(k) : k) {
        case 'vert':
          if (!v.startsWith('horz')) out.add(`${prefix}vert`);
          break;
        case 'rtl':
          if (v === '1') out.add(`${prefix}rtl`);
          break;
        case 'baseline':
          if (/^-?[1-9]/.test(v)) out.add(`${prefix}superSub`);
          break;
      }
    }
    pushChildren(stack, n);
  }
  return out;
}

/**
 * A canonical key of a run's properties for `mixedRuns`: the attributes that change how it looks (sorted)
 * and the child elements. A run without `a:rPr` and one whose `a:rPr` holds only neutral attributes share
 * the empty key.
 */
function runKey(rPr: XNode | undefined): string {
  if (!rPr) return '';
  const attrs = (n: XNode, skip: ReadonlySet<string>) =>
    Object.keys(n.attrs)
      .filter((k) => !skip.has(k))
      .sort()
      .map((k) => `${k}=${JSON.stringify(n.attrs[k])}`)
      .join(' ');
  let key = attrs(rPr, NEUTRAL_RUN_ATTRS);
  // Children in document order, serialised iteratively ('(' and ')' bracket each element).
  const stack: (XNode | string)[] = [...rPr.children].reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (typeof n === 'string') {
      key += n;
      continue;
    }
    if (n.name === '#text') continue;
    key += `(${n.name} ${attrs(n, new Set())}`;
    stack.push(')');
    for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
  }
  return key;
}

/**
 * Whether runs of one text body differ in their explicit properties (beyond the neutral attributes). Runs
 * without text draw nothing and are not compared.
 */
function hasMixedRuns(txBody: XNode): boolean {
  let first: string | undefined;
  const stack = [txBody];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.name === 'a:r') {
      if (!textOf(child(n, 'a:t'))) continue;
      const key = runKey(child(n, 'a:rPr'));
      if (first === undefined) first = key;
      else if (key !== first) return true;
      continue;
    }
    pushChildren(stack, n);
  }
  return false;
}

/**
 * The census features only the slide's own shapes are checked for: `mixedRuns`, `pic:<ext>` (through the
 * slide's relationships), `crop` (an `a:srcRect` with a side set), `shadow` (an `a:outerShdw` in an
 * `a:effectLst`) and `outline` (an `a:ln` in an `a:rPr`).
 */
function ownFeatures(ctx: SlideCtx, tree: XNode | undefined, out: Set<string>): void {
  const stack: [XNode, boolean][] = tree ? [[tree, false]] : [];
  while (stack.length) {
    const [n, inEffects] = stack.pop()!;
    switch (n.name) {
      case 'p:txBody':
        if (!out.has('mixedRuns') && hasMixedRuns(n)) out.add('mixedRuns');
        break;
      case 'a:blip':
        for (const k in n.attrs) {
          if (local(k) !== 'embed') continue;
          const rel = ctx.pkg.rel(ctx.part, n.attrs[k]!);
          const ext = rel && !rel.external ? extOf(rel.target) : '';
          if (PICTURE_FEATURES.has(ext)) out.add(`pic:${ext}`);
        }
        break;
      case 'a:srcRect':
        if (['l', 't', 'r', 'b'].some((k) => num(n.attrs[k]))) out.add('crop');
        break;
      case 'a:outerShdw':
        if (inEffects) out.add('shadow');
        break;
      case 'a:rPr':
        if (child(n, 'a:ln')) out.add('outline');
        break;
    }
    const effects = inEffects || n.name === 'a:effectLst';
    for (const c of n.children) if (c.name !== '#text') stack.push([c, effects]);
  }
}

/** Whether a subtree holds a placeholder (`p:ph`) anywhere. */
function hasPlaceholder(el: XNode): boolean {
  const stack = [el];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.name === 'p:ph') return true;
    pushChildren(stack, n);
  }
  return false;
}

/** Shape-tree elements a decoration can be. */
const DECO_ELEMENTS: ReadonlySet<string> = new Set(['p:sp', 'p:pic', 'p:grpSp', 'p:graphicFrame', 'p:cxnSp']);

/** The `deco:` features of a layout's or master's decorations, by root (each part is read once per deck). */
const decoCache = new WeakMap<XNode, readonly string[]>();

/**
 * The `deco:` features of the decorations of a layout or master: its non-placeholder shapes (a placeholder
 * anywhere in a shape makes it a template), shapes inside alternate content included (the one branch
 * `Package.xml` keeps, `markup.ts`; the census script read both). Only the features of `featuresOf` are
 * checked.
 */
function decoFeatures(root: XNode | undefined): readonly string[] {
  if (!root) return [];
  let out = decoCache.get(root);
  if (out) return out;
  const found = new Set<string>();
  const stack = [...(path(root, 'p:cSld', 'p:spTree')?.children ?? [])].reverse();
  while (stack.length) {
    const el = stack.pop()!;
    if (el.name === 'mc:AlternateContent' || el.name === 'mc:Choice' || el.name === 'mc:Fallback') {
      for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]!);
      continue;
    }
    if (DECO_ELEMENTS.has(el.name) && !hasPlaceholder(el)) featuresOf(el, 'deco:', found);
  }
  out = [...found];
  decoCache.set(root, out);
  return out;
}

/**
 * The census features of a slide: its own shape tree (the branch of `mc:AlternateContent` `Package.xml`
 * keeps), plus the
 * `deco:` features of the decorations it shows: the layout's unless the slide has `showMasterSp="0"`, and
 * the master's unless the layout has it too.
 */
export function slideFeatures(ctx: SlideCtx): Set<string> {
  const own = path(ctx.slide, 'p:cSld', 'p:spTree');
  const out = featuresOf(own);
  ownFeatures(ctx, own, out);
  const shows = (n: XNode | undefined) => n?.attrs.showMasterSp !== '0' && n?.attrs.showMasterSp !== 'false';
  if (!shows(ctx.slide)) return out;
  for (const f of decoFeatures(ctx.layout)) out.add(f);
  if (shows(ctx.layout)) for (const f of decoFeatures(ctx.master)) out.add(f);
  return out;
}

// ── Element support ─────────────────────────────────────────────────────────────────────────────────────

/** Whether an `a:sp3d` really draws in 3D: a bevel with a size, or an extrusion (else it is ignored). */
function isReal3d(sp3d: XNode): boolean {
  if ((num(sp3d.attrs.extrusionH) ?? 0) > 0) return true;
  for (const name of ['a:bevelT', 'a:bevelB']) {
    const b = child(sp3d, name);
    // A bevel's width and height default to 76,200 EMU (6 pt).
    if (b && (num(b.attrs.w) ?? 76_200) > 0 && (num(b.attrs.h) ?? 76_200) > 0) return true;
  }
  return false;
}

/** The picture part an element draws: a `p:pic`'s, or a shape's picture fill. */
function picturePart(e: Element): string | undefined {
  if (e.kind === 'picture') return e.picture.part;
  if (e.kind === 'shape' && e.fill.kind === 'picture') return e.fill.picture.part;
  return undefined;
}

/**
 * The support of one element by design/27 §5, from the IR element and, when known, its XML (`p:sp`,
 * `p:pic`, `p:graphicFrame`, `p:cxnSp`). Reasons are short words.
 *
 * - residual: chart, table, SmartArt, OLE, other graphic frames, maths, a real 3D bevel or extrusion,
 *   a WordArt warp (not `textNoShape`), text that is vertical, in columns or `anchorCtr` (until M8), an
 *   HD Photo picture (`pic:wdp`, `pic:hdp`); a sheared group child is the reader's verdict (`walk.ts`);
 * - approx: reflection, inner shadow, a soft edge on a picture, a metafile (converted by LibreOffice in the
 *   follow-up job);
 * - everything else native. The element's own `support` (the reader's verdict) is not part of this.
 */
export function elementSupport(
  ctx: SlideCtx,
  e: Element,
  node: XNode | undefined,
): { support: Support; reasons: string[] } {
  const { residual, approx } = supportReasons(ctx, e, node);
  const support: Support = residual.length ? 'residual' : approx.length ? 'approx' : 'native';
  return { support, reasons: [...residual, ...approx] };
}

/** What a subtree holds that §5 rates, whatever element it is read for (one walk per node per deck). */
interface NodeMarks {
  residual: string[];
  approx: string[];
  /** An `a:softEdge` somewhere: approx only on a picture. */
  softEdge: boolean;
}

/**
 * The marks of each XML node rated so far. Layout and master decorations are rated on every slide that
 * shows them, and up to `MAX_CANDIDATES` nodes per element: without the cache, a huge shared node would be
 * walked once per element of every slide.
 */
const marksCache = new WeakMap<XNode, NodeMarks>();

function marksOf(node: XNode): NodeMarks {
  let m = marksCache.get(node);
  if (m) return m;
  const residual = new Set<string>();
  const approx = new Set<string>();
  let softEdge = false;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.name === 'a14:m' || n.name.startsWith('m:oMath')) residual.add('math');
    else if (n.name === 'a:sp3d' && isReal3d(n)) residual.add('3d');
    else if (n.name === 'a:reflection') approx.add('reflection');
    else if (n.name === 'a:innerShdw') approx.add('innerShdw');
    else if (n.name === 'a:softEdge') softEdge = true;
    pushChildren(stack, n);
  }
  m = { residual: [...residual], approx: [...approx], softEdge };
  marksCache.set(node, m);
  return m;
}

/** The §5 reasons that make an element residual, and those that make it approx (each de-duplicated). */
function supportReasons(
  ctx: SlideCtx,
  e: Element,
  node: XNode | undefined,
): { residual: string[]; approx: string[] } {
  const residual: string[] = [];
  const approx: string[] = [];
  // A metafile waits for conversion (approx); every other residual element is residual.
  if (e.kind === 'residual') (e.what === 'metafile' ? approx : residual).push(e.what);
  const part = picturePart(e);
  const ext = part === undefined ? '' : extOf(part);
  if (ext === 'wdp' || ext === 'hdp') residual.push(`pic:${ext}`);
  if (ext === 'emf' || ext === 'wmf') approx.push('metafile');
  if (node) {
    const marks = marksOf(node);
    residual.push(...marks.residual);
    approx.push(...marks.approx);
    if (marks.softEdge && part !== undefined) approx.push('softEdge');
    if (e.kind === 'shape' && e.text) {
      const body = bodyPrChain(chainOf(ctx, node, e.from));
      const vert = e.text.vert ?? firstAttr(body, 'vert');
      if (vert !== undefined && vert !== 'horz') residual.push('vert');
      if ((e.text.numCol ?? num(firstAttr(body, 'numCol')) ?? 1) > 1) residual.push('numCol');
      const ctr = firstAttr(body, 'anchorCtr');
      if (e.text.anchorCtr ?? (ctr === '1' || ctr === 'true')) residual.push('anchorCtr');
      const warp = e.text.warp ?? firstChildOf(body, 'a:prstTxWarp')?.attrs.prst;
      if (warp !== undefined && warp !== 'textNoShape') residual.push('warp');
    }
  }
  return { residual: [...new Set(residual)], approx: [...new Set(approx)] };
}

/** Elements of a shape tree that the walk can turn into IR elements. */
const LEAF_ELEMENTS: ReadonlySet<string> = new Set(['p:sp', 'p:cxnSp', 'p:pic', 'p:graphicFrame']);
/** What each IR element kind can have been read from (a residual element: any leaf). */
const KIND_OF_LEAF: Readonly<Record<string, 'shape' | 'picture' | undefined>> = Object.assign(
  Object.create(null),
  { 'p:sp': 'shape', 'p:cxnSp': 'shape', 'p:pic': 'picture' },
);

/**
 * XML elements an IR element is rated by at most: alternate content kept one branch, but a damaged deck can
 * give thousands of shapes one id, and the rating must not become quadratic.
 */
const MAX_CANDIDATES = 4;

/** Candidate nodes of one `cNvPr id` in one part, per IR element kind, each list capped when it is built. */
interface Candidates {
  shape: XNode[];
  picture: XNode[];
  any: XNode[];
}

/** A shape's `cNvPr id` as `walk.ts` stores it in `ElementBase.shapeId`. */
function shapeIdOf(el: XNode): number {
  const v = num(child(nvOf(el), 'p:cNvPr')?.attrs.id);
  return v !== undefined && Number.isFinite(v) ? Math.max(0, Math.min(2_147_483_647, Math.floor(v))) : 0;
}

/** The candidates of a part's shape tree by `cNvPr id`, document order; built once per part per deck. */
const candidateCache = new WeakMap<XNode, Map<number, Candidates>>();

function candidatesOf(root: XNode | undefined): Map<number, Candidates> | undefined {
  if (!root) return undefined;
  let out = candidateCache.get(root);
  if (out) return out;
  out = new Map();
  const stack = [...(path(root, 'p:cSld', 'p:spTree')?.children ?? [])].reverse();
  while (stack.length) {
    const el = stack.pop()!;
    if (LEAF_ELEMENTS.has(el.name)) {
      const id = shapeIdOf(el);
      let c = out.get(id);
      if (!c) out.set(id, (c = { shape: [], picture: [], any: [] }));
      const kind = KIND_OF_LEAF[el.name];
      if (kind && c[kind].length < MAX_CANDIDATES) c[kind].push(el);
      if (c.any.length < MAX_CANDIDATES) c.any.push(el);
    } else if (
      el.name === 'p:grpSp' ||
      el.name === 'mc:AlternateContent' || // `Package.xml` left it one branch
      el.name === 'mc:Choice' ||
      el.name === 'mc:Fallback'
    )
      for (let i = el.children.length - 1; i >= 0; i--) stack.push(el.children[i]!);
  }
  candidateCache.set(root, out);
  return out;
}

/**
 * Set each element's support and reasons: the worse of the reader's verdict and `elementSupport`, reasons
 * merged. The XML is the shape's `node` when the reader kept it, else the elements of the same source and
 * `cNvPr id` that the kind can be read from (the first `MAX_CANDIDATES`; `Package.xml` keeps one branch of
 * alternate content, so these are shapes that really share an id). Their verdicts are merged, so an element
 * is never rated better than any of them. Each node's subtree is walked once per deck (`marksOf`).
 * Returns, per element, the reasons that make it residual (empty for the others).
 */
export function refineSupport(ctx: SlideCtx, elements: Element[]): string[][] {
  return elements.map((e) => {
    let nodes: XNode[] = [];
    if (e.kind === 'shape' && e.node) nodes = [e.node];
    else {
      const c = candidatesOf(rootOf(ctx, e.from))?.get(e.shapeId);
      if (c) nodes = e.kind === 'residual' ? c.any : c[e.kind];
    }
    const residual: string[] = [];
    const approx: string[] = [];
    for (const node of nodes.length ? nodes : [undefined]) {
      const r = supportReasons(ctx, e, node);
      residual.push(...r.residual);
      approx.push(...r.approx);
    }
    // The reader's verdict stays when it is worse (with its reasons).
    const own = e.reasons ?? [];
    if (e.support === 'residual' && !residual.length) residual.push(...own);
    const support: Support =
      e.support === 'residual' || residual.length
        ? 'residual'
        : e.support === 'approx' || approx.length
          ? 'approx'
          : 'native';
    const reasons = [...new Set([...own, ...residual, ...approx].map((r) => clean(r, MAX_REASON_CHARS)))];
    e.support = support;
    if (reasons.length) e.reasons = reasons;
    return support === 'residual' ? [...new Set(residual)] : [];
  });
}

// ── Slide class and art range ───────────────────────────────────────────────────────────────────────────

/** Objects a native or hybrid slide may have (design/27 §5; the render clamp is 200). */
export const MAX_SLIDE_OBJECTS = 150;
/** Distinct pictures a native or hybrid slide may have, the art included (the render clamp is 16). */
export const MAX_SLIDE_PICTURES = 12;

/** The axis-aligned bounding box of an element in slide EMU. */
export function boundsOf(e: Element): RectEmu {
  const [a, b, c, d, x, y] = e.xf;
  const xs = [x, x + a, x + c, x + a + c];
  const ys = [y, y + b, y + d, y + b + d];
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, cx: Math.max(...xs) - x0, cy: Math.max(...ys) - y0 };
}

/** Whether two boxes share area (a line, with no area, overlaps what it crosses or touches). */
export function overlaps(p: RectEmu, q: RectEmu): boolean {
  const span = (a0: number, a1: number, b0: number, b1: number) =>
    a0 === a1 || b0 === b1 ? a0 <= b1 && b0 <= a1 : a0 < b1 && b0 < a1;
  return span(p.x, p.x + p.cx, q.x, q.x + q.cx) && span(p.y, p.y + p.cy, q.y, q.y + q.cy);
}

/** A play video: never baked into an art picture (design/27 §5). */
const isVideo = (e: Element) => e.kind === 'picture' && e.media?.kind === 'video';

/**
 * The art of a slide's residual elements, or undefined when it has none: the range [Rmin, Rmax], the
 * residuals and every other element of the range that overlaps an art element above it (decided from the
 * top down), and their bounding box. Hidden elements and play videos are never in the art.
 */
export function artRange(elements: readonly Element[]): ArtRange | undefined {
  const residual: number[] = [];
  elements.forEach((e, i) => {
    if (!e.hidden && e.support === 'residual' && !isVideo(e)) residual.push(i);
  });
  if (!residual.length) return undefined;
  const from = residual[0]!;
  const to = residual[residual.length - 1]!;
  const inArt = new Set(residual);
  const boxes = new Map<number, RectEmu>();
  const box = (i: number) => {
    let b = boxes.get(i);
    if (!b) boxes.set(i, (b = boundsOf(elements[i]!)));
    return b;
  };
  for (let z = to - 1; z > from; z--) {
    const e = elements[z]!;
    if (inArt.has(z) || e.hidden || isVideo(e)) continue;
    for (const a of inArt)
      if (a > z && overlaps(box(z), box(a))) {
        inArt.add(z);
        break;
      }
  }
  const list = [...inArt].sort((p, q) => p - q);
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const i of list) {
    const b = box(i);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.cx);
    y1 = Math.max(y1, b.y + b.cy);
  }
  return { from, to, elements: list, box: { x: x0, y: y0, cx: x1 - x0, cy: y1 - y0 } };
}

/** Whether a play video inside the art range is overlapped by an art element above it (it ends up on top). */
function videoUnderArt(elements: readonly Element[], art: ArtRange): boolean {
  for (let i = art.from + 1; i < art.to; i++) {
    const e = elements[i]!;
    if (!isVideo(e) || e.hidden) continue;
    const b = boundsOf(e);
    if (art.elements.some((a) => a > i && overlaps(b, boundsOf(elements[a]!)))) return true;
  }
  return false;
}

/**
 * What a slide costs against the budgets once the art is split off: the ordo objects it emits (a shape with
 * a fill or line and text is two) and its distinct pictures (the background's and the art included).
 */
export function slideCost(
  elements: readonly Element[],
  background: Background,
  art: ArtRange | undefined,
): { objects: number; pictures: number } {
  const inArt = new Set(art?.elements);
  const pictures = new Set<string>();
  let objects = art ? 1 : 0;
  if (background.fill.kind !== 'none') objects++;
  if (background.fill.kind === 'picture') pictures.add(background.fill.picture.part);
  elements.forEach((e, i) => {
    if (e.hidden || inArt.has(i) || e.kind === 'residual') return;
    const part = picturePart(e);
    if (part !== undefined) pictures.add(part);
    if (e.kind === 'picture') objects++;
    else objects += (e.fill.kind !== 'none' || e.line ? 1 : 0) + (e.text ? 1 : 0);
  });
  return { objects, pictures: pictures.size + (art ? 1 : 0) };
}

/** No background: `slideCost` of some elements alone. */
const NO_BACKGROUND: Background = { fill: { kind: 'none' }, from: 'none' };

/**
 * SmartArt drawings stay whole (M6, `smartart.ts`): one is drawn natively, or by LibreOffice into the art,
 * never partly both. A drawing with a residual element (3D, vertical text …), or one the art takes an element
 * of (an overlap with a residual above it), goes to the art entirely ('smartart'); then, while the slide's
 * objects pass `MAX_SLIDE_OBJECTS`, the native drawing with the most objects goes too ('budget:smartart'),
 * so the slide is hybrid rather than picture (design/27 §15 M6). `residual` (per element, `refineSupport`)
 * gets the reasons.
 */
export function wholeDiagrams(
  ctx: SlideCtx,
  elements: Element[],
  background: Background,
  residual: string[][],
): void {
  // By source and number: a layout's drawings are numbered in its own walk, shared by every slide.
  const members = new Map<string, number[]>();
  elements.forEach((e, i) => {
    if (e.diagram === undefined) return;
    const key = `${e.from}:${e.diagram}`;
    const list = members.get(key) ?? [];
    list.push(i);
    members.set(key, list);
  });
  if (!members.size) return;
  const toArt = (list: number[], why: string) => {
    for (const i of list) {
      const e = elements[i]!;
      if (e.support === 'residual') continue;
      e.support = 'residual';
      e.reasons = [...new Set([...(e.reasons ?? []), why])];
      residual[i] = [...residual[i]!, why];
    }
  };
  // Each pass sends at least one more drawing to the art, so this ends within the number of drawings.
  for (let pass = 0; pass <= members.size; pass++) {
    const art = artRange(elements);
    const inArt = new Set(art?.elements);
    let moved = false;
    for (const list of members.values()) {
      const shown = list.filter((i) => !elements[i]!.hidden);
      const some = shown.some((i) => elements[i]!.support === 'residual' || inArt.has(i));
      const all = shown.every((i) => elements[i]!.support === 'residual');
      if (some && !all) {
        toArt(shown, 'smartart');
        moved = true;
      }
    }
    if (moved) continue;
    if (slideCost(elements, background, art).objects <= MAX_SLIDE_OBJECTS) return;
    let worst: number[] | undefined;
    let most = 0;
    for (const list of members.values()) {
      if (list.every((i) => elements[i]!.support === 'residual')) continue;
      const n = slideCost(
        list.map((i) => elements[i]!),
        NO_BACKGROUND,
        undefined,
      ).objects;
      if (n > most) {
        most = n;
        worst = list;
      }
    }
    if (!worst) return;
    ctx.log(`a SmartArt graphic of ${most} objects passes the slide's budget: LibreOffice draws it`);
    toArt(worst, 'budget:smartart');
  }
}

/**
 * Tier, class and reasons of a slide that was read. Sets each element's `support` and `reasons` first
 * (`refineSupport`). Reasons: the tier's (features that keep the slide out of the tier below), then
 * `art:<reason>` for what made it hybrid and `budget:objects` / `budget:pictures` for what made it a picture.
 */
export function classifySlide(ctx: SlideCtx, elements: Element[], background: Background): Classification {
  const { tier, reasons } = tierOf(slideFeatures(ctx));
  const residual = refineSupport(ctx, elements);
  wholeDiagrams(ctx, elements, background, residual);
  const art = artRange(elements);
  const why: string[] = [];
  for (const i of art?.elements ?? []) for (const r of residual[i]!) why.push(`art:${r}`);
  if (art && videoUnderArt(elements, art)) ctx.log('a residual element above a video is drawn under it');
  const cost = slideCost(elements, background, art);
  const over: string[] = [];
  if (cost.objects > MAX_SLIDE_OBJECTS) over.push('budget:objects');
  if (cost.pictures > MAX_SLIDE_PICTURES) over.push('budget:pictures');
  const cls: SlideClass = over.length ? 'picture' : art ? 'hybrid' : 'native';
  if (over.length) ctx.log(`over the slide budgets (${cost.objects} objects, ${cost.pictures} pictures)`);
  return {
    tier,
    class: cls,
    reasons: [...reasons, ...[...new Set(why)].sort(), ...over].map((r) => clean(r, MAX_REASON_CHARS)),
    ...(art && cls === 'hybrid' ? { art } : {}),
  };
}
