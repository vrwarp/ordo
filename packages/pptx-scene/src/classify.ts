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
 * **Support** (`native` / `approx` / `residual`) is per element: the reader's own verdict (`walk.ts`: since M6
 * every preset of the table, custom geometry, gradients and line styles are native; a preset the table does
 * not know, a pattern fill and sheared group children are approx; custom geometry past the bounds is
 * residual) combined with the rules of §5 (charts, the tables and SmartArt the walk leaves residual, OLE, maths,
 * real 3D, WordArt warps, vertical and multi-column text, HD Photo pictures are residual;
 * reflections, inner shadows, soft edges on pictures and metafiles waiting for conversion are approx).
 *
 * **Class**: native without residual elements; hybrid with them, the residuals and what they overlap baked
 * into one art picture over the range [Rmin, Rmax]; picture when the objects or pictures left after the
 * split exceed the slide budgets (or the slide could not be read, `index.ts`). A table read natively
 * (`tables.ts`, M6) counts the objects it emits: its cells, its background, and one grid object per fill and
 * per line look (`gridObjects`), not one per run. A slide past the object budget counts its z-adjacent shapes
 * of one look as one object each run (`shapeRuns`, drawn so by `emit.ts`); while it still passes the budget,
 * tables go to the art first (`budget:table`), then whole SmartArt drawings (`budget:smartart`,
 * `wholeDiagrams`), then decorations and runs of shapes and pictures without text (`budget:shapes`,
 * `fitShapes`), so the slide becomes hybrid rather than picture.
 *
 * Every walk here is iterative and linear in the size of the parsed tree; deck strings are only compared,
 * never used as plain-object keys.
 */
import { GEOM_LIMITS } from '@ordo/renderer/geom/ops.ts';
import { rootOf, type SlideCtx } from './context.ts';
import { endsOf, MAX_PATH_CHARS, mergedChars, type ShapePiece, shapePiece } from './geom.ts';
import { bodyPrChain, chainOf, firstAttr, firstChildOf, nvOf } from './inherit.ts';
import type {
  ArtRange,
  Background,
  Classification,
  Element,
  Fill,
  Frame,
  RectEmu,
  ShapeElement,
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
 *   HD Photo picture (`pic:wdp`, `pic:hdp`); custom geometry past the bounds is the reader's verdict
 *   (`walk.ts`), as a sheared group child's approx is;
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
      if (c) nodes = e.kind === 'residual' || e.kind === 'table' ? c.any : c[e.kind];
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
 * a fill or line and text is two) and its distinct pictures (the background's and the art included). With
 * the slide's `frame`, a slide that would pass `MAX_SLIDE_OBJECTS` counts each of its runs of shapes of one
 * look (`shapeRuns`) as the one object `emit.ts` draws it as.
 */
export function slideCost(
  elements: readonly Element[],
  background: Background,
  art: ArtRange | undefined,
  frame?: Frame,
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
    else if (e.kind === 'table') objects += e.objects;
    else objects += (e.fill.kind !== 'none' || e.line ? 1 : 0) + (e.text ? 1 : 0);
  });
  if (frame && objects > MAX_SLIDE_OBJECTS)
    for (const run of shapeRuns(elements, frame, inArt)) objects -= run.length - 1;
  return { objects, pictures: pictures.size + (art ? 1 : 0) };
}

// ── Shapes of one look drawn as one object ──────────────────────────────────────────────────────────────

/** Straight lines and connector routes: drawn as lines (`emit.ts`), never merged. */
const LINE_GEOMS = /^(line|straightConnector1|(bent|curved)Connector[2-5])$/;
/** The render clamp keeps box edges within ±2× the logical canvas (`@ordo/renderer` `CLAMP.boxFactor`). */
const CLAMP_W = 2 * 1_920;
const CLAMP_H = 2 * 1_080;

/** What a mergeable shape brings to a run: its look and scope (`key`), geometry and box. */
interface Mergeable {
  key: string;
  piece: ShapePiece;
  box: RectEmu;
}

/** Each shape's `Mergeable` (null: never merged), memoised: none of what it reads changes after the walk. */
const mergeables = new WeakMap<Element, Mergeable | null>();

/**
 * Whether a shape can be drawn as part of one object with its z-neighbours, and its look (M6). Drawn as
 * paths of one geometry in their z-order (`drawGeom` fills and strokes each path in turn, as separate shapes
 * are drawn), shapes look exactly as they do apart when nothing is drawn between them, each path keeps its
 * own fill mode, and their paint does not depend on their box or on what lies under the object:
 * - a shape without text, of the slide's support verdict native, not in a SmartArt drawing, neither a line
 *   nor a connector route (drawn as lines), with a known preset or custom geometry within the bounds;
 * - an opaque solid fill or none, and an opaque solid line or none (not both none), without arrowheads; a
 *   fill with a line only when every stroked outline is closed (an open one is stroked after every other
 *   path of a geometry, `geomPathOpen`, so it would move above the shapes over it);
 * - no shadow, glow or soft edge (each is drawn around the whole object);
 * - inside the render clamp's bounds (a box past them is squeezed);
 * - in a top-level group, or a layout or master decoration: the slide's own shapes stay separate objects.
 * The key is the source and group with the fill and line: shapes merge only with the same key.
 */
function mergeable(e: Element, frame: Frame): Mergeable | undefined {
  if (e.kind !== 'shape') return undefined;
  let m = mergeables.get(e);
  if (m === undefined) {
    m = mergeLook(e, frame) ?? null;
    mergeables.set(e, m);
  }
  return m && !e.hidden && e.support === 'native' ? m : undefined;
}

function mergeLook(e: ShapeElement, frame: Frame): Mergeable | undefined {
  if (e.text || e.diagram !== undefined || e.shadow || e.glow || e.softEdge || LINE_GEOMS.test(e.geom))
    return undefined;
  if (e.group === undefined && e.from === 'slide') return undefined;
  const opaque = (f: Fill) => f.kind === 'solid' && f.color.a === 1;
  if (e.fill.kind !== 'none' && !opaque(e.fill)) return undefined;
  const line = e.line && e.line.fill.kind !== 'none' ? e.line : undefined;
  if (line && (!opaque(line.fill) || endsOf(line))) return undefined;
  const fill = e.fill.kind === 'solid' ? e.fill.color : undefined;
  if (!fill && !line) return undefined;
  const piece = shapePiece(e, frame.s);
  if (!piece || (fill && line && piece.open)) return undefined;
  const box = boundsOf(e);
  const x0 = frame.x0 + box.x * frame.s;
  const y0 = frame.y0 + box.y * frame.s;
  const x1 = x0 + box.cx * frame.s;
  const y1 = y0 + box.cy * frame.s;
  if (!(x0 >= -CLAMP_W && x1 <= CLAMP_W && y0 >= -CLAMP_H && y1 <= CLAMP_H)) return undefined;
  return { key: JSON.stringify([e.from, e.group ?? null, fill ?? null, line ?? null]), piece, box };
}

/** The bounding box of two boxes. */
export function unionBox(p: RectEmu, q: RectEmu): RectEmu {
  const x = Math.min(p.x, q.x);
  const y = Math.min(p.y, q.y);
  return { x, y, cx: Math.max(p.x + p.cx, q.x + q.cx) - x, cy: Math.max(p.y + p.cy, q.y + q.cy) - y };
}

/**
 * Runs of z-adjacent shapes of one look drawn as one object (M6; design/27 §5 "picture"): consecutive shown
 * elements that are `mergeable` with the same key, none of them in the art (`inArt`), their paths together at
 * most `GEOM_LIMITS.paths` and every path string within the schema's 40,000 characters once written in the
 * run's box (`mergedChars`). Hidden elements draw nothing and do not end a run. Greedy, bottom first, linear;
 * each run has at least two elements (indexes, bottom first). The object (`emit.ts`) draws the run's paths
 * in z-order in their union box, so it looks as the shapes do.
 */
export function shapeRuns(
  elements: readonly Element[],
  frame: Frame,
  inArt: ReadonlySet<number> = new Set(),
): number[][] {
  const runs: number[][] = [];
  type Run = {
    key: string;
    list: number[];
    paths: number;
    cmds: number;
    coords: number;
    box: RectEmu;
    extent: RectEmu;
  };
  let run: Run | undefined;
  const end = () => {
    if (run && run.list.length > 1) runs.push(run.list);
    run = undefined;
  };
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i]!;
    if (e.hidden) continue;
    const m = inArt.has(i) ? undefined : mergeable(e, frame);
    if (!m) {
      end();
      continue;
    }
    const p = m.piece;
    if (run && run.key === m.key && run.paths + p.paths.length <= GEOM_LIMITS.paths) {
      const box = unionBox(run.box, m.box);
      const extent = unionBox(run.extent, p.extent);
      const cmds = Math.max(run.cmds, p.cmds);
      const coords = Math.max(run.coords, p.coords);
      if (mergedChars(box, extent, cmds, coords, frame.s) <= MAX_PATH_CHARS) {
        run.list.push(i);
        run.paths += p.paths.length;
        Object.assign(run, { box, extent, cmds, coords });
        continue;
      }
    }
    end();
    run = {
      key: m.key,
      list: [i],
      paths: p.paths.length,
      cmds: p.cmds,
      coords: p.coords,
      box: m.box,
      extent: p.extent,
    };
  }
  end();
  return runs;
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
    if (slideCost(elements, background, art, ctx.frame).objects <= MAX_SLIDE_OBJECTS) return;
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
 * Tables over the object budget go to the art (M6, design/27 §15: no slide passes `MAX_SLIDE_OBJECTS`
 * without becoming hybrid): while the slide would pass it, its native table with the most objects (cells,
 * background and grid objects, `TableElement.objects`) is made
 * residual ('budget:table'), LibreOffice drawing it. `residual` (per element, `refineSupport`) gets the
 * reason.
 */
function fitTables(ctx: SlideCtx, elements: Element[], background: Background, residual: string[][]): void {
  for (;;) {
    if (slideCost(elements, background, artRange(elements), ctx.frame).objects <= MAX_SLIDE_OBJECTS) return;
    let worst = -1;
    elements.forEach((e, i) => {
      if (e.kind !== 'table' || e.hidden || e.support === 'residual') return;
      const w = elements[worst];
      if (worst < 0 || (w?.kind === 'table' && e.objects > w.objects)) worst = i;
    });
    const e = elements[worst];
    if (e?.kind !== 'table') return;
    ctx.log(`a table of ${e.objects} objects passes the slide's budget: LibreOffice draws it`);
    e.support = 'residual';
    e.reasons = [...(e.reasons ?? []), 'budget:table'];
    residual[worst] = ['budget:table'];
  }
}

/** An element the shape budget can send to the art: shown, native or approx, a picture or a shape without text. */
function textless(e: Element): boolean {
  return (
    !e.hidden &&
    e.support !== 'residual' &&
    e.diagram === undefined &&
    !isVideo(e) &&
    (e.kind === 'picture' || (e.kind === 'shape' && !e.text))
  );
}

/**
 * Plain shapes and pictures over the object budget go to the art (design/27 §5 "picture", §15 M6: no slide
 * passes `MAX_SLIDE_OBJECTS` without becoming hybrid). While the slide passes it, its shapes of one look
 * merged (`shapeRuns`), elements without text are made residual ('budget:shapes'), LibreOffice drawing them:
 * 1. the fewest of the layout's and master's decorations without text, bottom first: they lie under the
 *    slide's own shapes, so the art stays at the bottom and the slide's text native above it;
 * 2. then the costliest z-contiguous run of elements without text in one top-level group, and once no
 *    group has one, the costliest such run of ungrouped elements (a run ends at any other shown element, one
 *    already in the art, and where the group or source changes), until the slide fits.
 * A slide that stays over the budget with every such element in the art keeps none of these marks: it is a
 * picture. `residual` (per element, `refineSupport`) gets the reason.
 */
function fitShapes(ctx: SlideCtx, elements: Element[], background: Background, residual: string[][]): void {
  const frame = ctx.frame;
  const objects = () => slideCost(elements, background, artRange(elements), frame).objects;
  if (objects() <= MAX_SLIDE_OBJECTS) return;
  const before = elements.map((e) => ({ support: e.support, reasons: e.reasons }));
  const mark = (list: readonly number[]) => {
    for (const i of list) {
      const e = elements[i]!;
      e.support = 'residual';
      e.reasons = [...(before[i]!.reasons ?? []), 'budget:shapes'];
    }
  };
  const unmark = (list: readonly number[]) => {
    for (const i of list) {
      const e = elements[i]!;
      e.support = before[i]!.support;
      if (before[i]!.reasons) e.reasons = before[i]!.reasons;
      else delete e.reasons;
    }
  };
  const all: number[] = [];
  elements.forEach((e, i) => {
    if (textless(e)) all.push(i);
  });
  // With all of them in the art the slide is as small as these steps make it: still over, it is a picture.
  mark(all);
  const least = objects();
  unmark(all);
  if (least > MAX_SLIDE_OBJECTS) return;
  const marked: number[] = [];
  const decos = all.filter((i) => elements[i]!.from !== 'slide');
  if (decos.length) {
    mark(decos);
    if (objects() <= MAX_SLIDE_OBJECTS) {
      unmark(decos);
      // The fewest from the bottom (the art only grows as more go): within the budget at `hi`.
      let lo = 1;
      let hi = decos.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const some = decos.slice(0, mid);
        mark(some);
        const fits = objects() <= MAX_SLIDE_OBJECTS;
        unmark(some);
        if (fits) hi = mid;
        else lo = mid + 1;
      }
      mark(decos.slice(0, hi));
      marked.push(...decos.slice(0, hi));
    } else marked.push(...decos);
  }
  // Runs in order of preference, each taken while what is left would pass the budget; the slide is costed
  // again only once that estimate fits (the art takes what it overlaps too, so it can only cost less, unless
  // that cuts a run of merged shapes), and the runs are listed again from there.
  for (let left = objects(); left > MAX_SLIDE_OBJECTS; ) {
    const runs = textlessRuns(elements, artRange(elements), frame);
    if (!runs.length) break;
    let estimate = left;
    for (const run of runs) {
      if (estimate <= MAX_SLIDE_OBJECTS) break;
      mark(run.list);
      marked.push(...run.list);
      estimate -= run.cost;
    }
    left = objects();
  }
  if (objects() > MAX_SLIDE_OBJECTS) {
    unmark(marked);
    return;
  }
  for (const i of marked) residual[i] = [...residual[i]!, 'budget:shapes'];
  ctx.log(`${marked.length} shapes and pictures pass the slide's object budget: LibreOffice draws them`);
}

/**
 * The runs of elements without text (`textless`) the shape budget sends to the art, in its order: z-contiguous
 * shown elements of one source and top-level group, none in the art, each with the objects it costs the slide
 * (its shapes of one look merged); those in a group first, each part costliest first. Runs that cost nothing
 * are left out.
 */
function textlessRuns(
  elements: readonly Element[],
  art: ArtRange | undefined,
  frame: Frame,
): { list: number[]; cost: number; grouped: boolean }[] {
  const inArt = new Set(art?.elements);
  const out: { list: number[]; cost: number; grouped: boolean }[] = [];
  let list: number[] = [];
  let scope = '';
  const end = () => {
    if (!list.length) return;
    const members = list.map((i) => elements[i]!);
    let cost = slideCost(members, NO_BACKGROUND, undefined).objects;
    for (const r of shapeRuns(members, frame)) cost -= r.length - 1;
    if (cost > 0) out.push({ list, cost, grouped: members[0]!.group !== undefined });
    list = [];
  };
  elements.forEach((e, i) => {
    if (e.hidden) return;
    if (!textless(e) || inArt.has(i)) {
      end();
      return;
    }
    const s = `${e.from}:${e.group ?? ''}`;
    if (s !== scope) end();
    scope = s;
    list.push(i);
  });
  end();
  // Stable: equal runs keep their z-order, bottom first.
  return out.sort((p, q) => Number(q.grouped) - Number(p.grouped) || q.cost - p.cost);
}

/**
 * Tier, class and reasons of a slide that was read. Sets each element's `support` and `reasons` first
 * (`refineSupport`), and on a slide over the object budget marks its runs of shapes of one look
 * (`ShapeElement.merge`, `shapeRuns`). Reasons: the tier's (features that keep the slide out of the tier
 * below), then `art:<reason>` for what made it hybrid and `budget:objects` / `budget:pictures` for what made
 * it a picture.
 */
export function classifySlide(ctx: SlideCtx, elements: Element[], background: Background): Classification {
  const { tier, reasons } = tierOf(slideFeatures(ctx));
  const residual = refineSupport(ctx, elements);
  fitTables(ctx, elements, background, residual);
  wholeDiagrams(ctx, elements, background, residual);
  fitShapes(ctx, elements, background, residual);
  // The art may now overlap part of a SmartArt drawing, which goes with it whole.
  wholeDiagrams(ctx, elements, background, residual);
  const art = artRange(elements);
  const why: string[] = [];
  for (const i of art?.elements ?? []) for (const r of residual[i]!) why.push(`art:${r}`);
  if (art && videoUnderArt(elements, art)) ctx.log('a residual element above a video is drawn under it');
  if (slideCost(elements, background, art).objects > MAX_SLIDE_OBJECTS) {
    const runs = shapeRuns(elements, ctx.frame, new Set(art?.elements));
    for (const run of runs) for (const i of run) (elements[i] as ShapeElement).merge = run[0]!;
    if (runs.length) {
      const n = runs.reduce((sum, r) => sum + r.length, 0);
      ctx.log(`${n} shapes of one look are drawn as ${runs.length} objects (the slide's object budget)`);
    }
  }
  const cost = slideCost(elements, background, art, ctx.frame);
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
