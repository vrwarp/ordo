import { createHash } from 'node:crypto';
// The renderer's own compiler, imported by path: the generator and the converter's custGeom compile through
// the same code, and the tool needs no workspace link.
import {
  compileGeom,
  type GeomSource,
  type HandleSource,
  newGeomNotes,
  type PathCmdSource,
  type PathSource,
  type SiteSource,
} from '../../../packages/renderer/src/geom/compile.ts';
import type { CompiledGeom, CompiledPath } from '../../../packages/renderer/src/geom/ops.ts';
import { parseXml, type XmlElement } from './xml.ts';

/*
 * tools/geom-gen: Apache POI 5.2.5's presetShapeDefinitions.xml (third_party/poi-presets) →
 * packages/renderer/src/geom/presets.gen.ts (design/27 §1, §15 M6).
 *
 * 1. read every preset into a GeomSource (strings, as written), refusing any element or attribute the
 *    compiler would not read, so a changed upstream file cannot lose geometry silently;
 * 2. apply the two fixes verified against LibreOffice (FIXES; each checks the exact text it replaces);
 * 3. compile each with the renderer's `compileGeom`, requiring no note (every name resolves to an earlier
 *    definition or a built-in, every operator is known, nothing is over a bound);
 * 4. print one line per preset, sorted by name, numbers in JavaScript's shortest form: the same input always
 *    gives the same bytes, and gen.test.ts checks the committed file is that output.
 */

/** A preset as read, mutable so FIXES can patch it. */
interface Def {
  av: [string, string][];
  gd: [string, string][];
  rect?: { l?: string; t?: string; r?: string; b?: string };
  paths: { attrs: Map<string, string>; cmds: PathCmdSource[] }[];
  handles: HandleSource[];
  sites: SiteSource[];
}

const PATH_ATTRS = new Set(['w', 'h', 'fill', 'stroke', 'extrusionOk']);
const XY_ATTRS = ['gdRefX', 'minX', 'maxX', 'gdRefY', 'minY', 'maxY'] as const;
const POLAR_ATTRS = ['gdRefR', 'minR', 'maxR', 'gdRefAng', 'minAng', 'maxAng'] as const;
const NS_ATTR = 'xmlns';

function only(el: XmlElement, allowed: readonly string[], where: string): void {
  for (const k of el.attrs.keys()) {
    if (k !== NS_ATTR && !allowed.includes(k))
      throw new Error(`${where}: unexpected attribute ${k} on <${el.name}>`);
  }
}

function attr(el: XmlElement, name: string, where: string): string {
  const v = el.attrs.get(name);
  if (v === undefined) throw new Error(`${where}: <${el.name}> without ${name}`);
  return v;
}

function child(el: XmlElement, name: string, where: string): XmlElement {
  if (el.children.length !== 1 || el.children[0]!.name !== name) {
    throw new Error(`${where}: <${el.name}> must hold one <${name}>`);
  }
  return el.children[0]!;
}

function guides(el: XmlElement, where: string): [string, string][] {
  return el.children.map((gd) => {
    if (gd.name !== 'gd') throw new Error(`${where}: unexpected <${gd.name}> in <${el.name}>`);
    only(gd, ['name', 'fmla'], where);
    return [attr(gd, 'name', where), attr(gd, 'fmla', where)];
  });
}

function point(el: XmlElement, where: string): [string, string] {
  only(el, ['x', 'y'], where);
  return [attr(el, 'x', where), attr(el, 'y', where)];
}

function readPath(el: XmlElement, where: string): Def['paths'][number] {
  for (const k of el.attrs.keys())
    if (!PATH_ATTRS.has(k)) throw new Error(`${where}: unexpected path attribute ${k}`);
  const cmds: PathCmdSource[] = [];
  for (const c of el.children) {
    switch (c.name) {
      case 'moveTo':
      case 'lnTo':
        cmds.push({ op: c.name, args: point(child(c, 'pt', where), where) });
        break;
      case 'arcTo':
        only(c, ['wR', 'hR', 'stAng', 'swAng'], where);
        if (c.children.length > 0) throw new Error(`${where}: <arcTo> with children`);
        cmds.push({ op: c.name, args: ['wR', 'hR', 'stAng', 'swAng'].map((a) => attr(c, a, where)) });
        break;
      case 'quadBezTo':
      case 'cubicBezTo': {
        const n = c.name === 'quadBezTo' ? 2 : 3;
        if (c.children.length !== n || c.children.some((p) => p.name !== 'pt')) {
          throw new Error(`${where}: <${c.name}> must hold ${n} <pt>`);
        }
        cmds.push({ op: c.name, args: c.children.flatMap((p) => point(p, where)) });
        break;
      }
      case 'close':
        if (c.children.length > 0 || c.attrs.size > 0) throw new Error(`${where}: <close> with content`);
        cmds.push({ op: 'close', args: [] });
        break;
      default:
        throw new Error(`${where}: unexpected path command <${c.name}>`);
    }
  }
  return { attrs: new Map(el.attrs), cmds };
}

function readHandle(el: XmlElement, where: string): HandleSource {
  const names = el.name === 'ahXY' ? XY_ATTRS : el.name === 'ahPolar' ? POLAR_ATTRS : undefined;
  if (names === undefined) throw new Error(`${where}: unexpected <${el.name}> in <ahLst>`);
  only(el, names, where);
  const [x, y] = point(child(el, 'pos', where), where);
  const a = (n: string): string | undefined => el.attrs.get(n);
  if (el.name === 'ahXY') {
    return {
      kind: 'xy',
      gdRefX: a('gdRefX'),
      minX: a('minX'),
      maxX: a('maxX'),
      gdRefY: a('gdRefY'),
      minY: a('minY'),
      maxY: a('maxY'),
      x,
      y,
    };
  }
  return {
    kind: 'polar',
    gdRefR: a('gdRefR'),
    minR: a('minR'),
    maxR: a('maxR'),
    gdRefAng: a('gdRefAng'),
    minAng: a('minAng'),
    maxAng: a('maxAng'),
    x,
    y,
  };
}

/** Every preset of the file, in document order. */
export function readPresets(xml: string): Map<string, Def> {
  const root = parseXml(xml);
  if (root.name !== 'presetShapeDefinitons') throw new Error(`unexpected root <${root.name}>`);
  const out = new Map<string, Def>();
  for (const p of root.children) {
    const where = p.name;
    if (out.has(p.name)) throw new Error(`duplicate preset ${p.name}`);
    if (p.attrs.size > 0) throw new Error(`${where}: attributes on the preset element`);
    const def: Def = { av: [], gd: [], paths: [], handles: [], sites: [] };
    const seen = new Set<string>();
    for (const part of p.children) {
      if (seen.has(part.name)) throw new Error(`${where}: two <${part.name}>`);
      seen.add(part.name);
      only(part, part.name === 'rect' ? ['l', 't', 'r', 'b'] : [], where);
      switch (part.name) {
        case 'avLst':
          def.av = guides(part, where);
          break;
        case 'gdLst':
          def.gd = guides(part, where);
          break;
        case 'rect': {
          const rect: NonNullable<Def['rect']> = {};
          for (const e of ['l', 't', 'r', 'b'] as const) {
            const v = part.attrs.get(e);
            if (v !== undefined) rect[e] = v;
          }
          def.rect = rect;
          break;
        }
        case 'pathLst':
          def.paths = part.children.map((path) => {
            if (path.name !== 'path') throw new Error(`${where}: unexpected <${path.name}> in <pathLst>`);
            return readPath(path, where);
          });
          break;
        case 'ahLst':
          def.handles = part.children.map((h) => readHandle(h, where));
          break;
        case 'cxnLst':
          def.sites = part.children.map((cxn) => {
            if (cxn.name !== 'cxn') throw new Error(`${where}: unexpected <${cxn.name}> in <cxnLst>`);
            only(cxn, ['ang'], where);
            const [x, y] = point(child(cxn, 'pos', where), where);
            return { ang: attr(cxn, 'ang', where), x, y };
          });
          break;
        default:
          throw new Error(`${where}: unexpected <${part.name}>`);
      }
    }
    out.set(p.name, def);
  }
  return out;
}

/** A fix to POI's file: what it changes and why, and the change, which throws if the original differs. */
export interface Fix {
  readonly preset: string;
  readonly what: string;
  apply(def: Def): void;
}

function starHandleFix(preset: string): Fix {
  return {
    preset,
    what: "ahXY maxY='ssd2' → maxY='50000' (adj is a fraction, bounded at 50000 as in star16)",
    apply(def) {
      const h = def.handles;
      if (h.length !== 1 || h[0]!.kind !== 'xy' || h[0]!.gdRefY !== 'adj' || h[0]!.maxY !== 'ssd2') {
        throw new Error(`${preset}: the handle to fix is not POI 5.2.5's (gdRefY="adj" maxY="ssd2")`);
      }
      h[0] = { ...h[0]!, maxY: '50000' };
    },
  };
}

/** The two fixes verified against LibreOffice (third_party/poi-presets/README.md). */
export const FIXES: readonly Fix[] = [
  {
    preset: 'pie',
    what: "text rect t='ir' r='it' → t='it' r='ir' (the original swaps the top and right edges)",
    apply(def) {
      const r = def.rect;
      if (r?.l !== 'il' || r.t !== 'ir' || r.r !== 'it' || r.b !== 'ib') {
        throw new Error('pie: the text rect to fix is not POI 5.2.5\'s (l="il" t="ir" r="it" b="ib")');
      }
      def.rect = { l: 'il', t: 'it', r: 'ir', b: 'ib' };
    },
  },
  starHandleFix('star24'),
  starHandleFix('star32'),
];

/** Applies FIXES in place. */
export function applyFixes(defs: Map<string, Def>): void {
  for (const fix of FIXES) {
    const def = defs.get(fix.preset);
    if (def === undefined) throw new Error(`${fix.preset}: preset to fix is missing`);
    fix.apply(def);
  }
}

function source(def: Def): GeomSource {
  const paths: PathSource[] = def.paths.map((p) => ({
    w: p.attrs.get('w'),
    h: p.attrs.get('h'),
    fill: p.attrs.get('fill'),
    stroke: p.attrs.get('stroke'),
    extrusionOk: p.attrs.get('extrusionOk'),
    cmds: p.cmds,
  }));
  return { av: def.av, gd: def.gd, rect: def.rect, paths, handles: def.handles, sites: def.sites };
}

/** Compiles every preset; throws when any compiles with a note. */
export function compilePresets(defs: Map<string, Def>): Map<string, CompiledGeom> {
  const out = new Map<string, CompiledGeom>();
  for (const [name, def] of defs) {
    const notes = newGeomNotes();
    out.set(name, compileGeom(source(def), notes));
    if (notes.count > 0) throw new Error(`${name}: ${notes.messages.join('; ')}`);
  }
  return out;
}

const num = (v: number): string => String(v);
const nums = (vs: readonly number[]): string => `[${vs.map(num).join(',')}]`;
const strs = (vs: readonly string[]): string => `[${vs.map((s) => JSON.stringify(s)).join(',')}]`;

function printPath(p: CompiledPath): string {
  const parts: string[] = [];
  if (p.w !== undefined) parts.push(`w:${num(p.w)}`);
  if (p.h !== undefined) parts.push(`h:${num(p.h)}`);
  if (p.f !== undefined) parts.push(`f:${num(p.f)}`);
  if (p.s !== undefined) parts.push(`s:${num(p.s)}`);
  if (p.e !== undefined) parts.push(`e:${num(p.e)}`);
  parts.push(`c:${nums(p.c)}`);
  return `{${parts.join(',')}}`;
}

/** One preset's object literal, keys in a fixed order. */
export function printGeom(g: CompiledGeom): string {
  const parts = [`k:${nums(g.k)}`, `a:${strs(g.a)}`, `g:${nums(g.g)}`, `n:${strs(g.n)}`, `r:${nums(g.r)}`];
  parts.push(`p:[${g.p.map(printPath).join(',')}]`);
  if (g.h !== undefined) parts.push(`h:${nums(g.h)}`);
  if (g.c !== undefined) parts.push(`c:${nums(g.c)}`);
  return `{${parts.join(',')}}`;
}

/** The SHA-256 of POI 5.2.5's presetShapeDefinitions.xml, as vendored (byte for byte the jar's entry). */
export const POI_SHA256 = 'a7dad593d27bd70536b41da9b761fa16409536cc0c25ef2b6c7a61c5d9b3e738';

/** presets.gen.ts for the given file. */
export function generate(xml: string): string {
  const sha = createHash('sha256').update(xml, 'utf8').digest('hex');
  const defs = readPresets(xml);
  applyFixes(defs);
  const compiled = compilePresets(defs);
  const names = [...compiled.keys()].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const lines = [
    '// Generated by tools/geom-gen (`pnpm --filter @ordo/geom-gen gen`): do not edit.',
    '// From third_party/poi-presets/presetShapeDefinitions.xml, Apache POI 5.2.5 (Apache-2.0; ECMA-376 Part 1',
    `// preset geometries), sha256 ${sha},`,
    '// with the fixes of third_party/poi-presets/README.md:',
    ...FIXES.map((f) => `// - ${f.preset}: ${f.what}`),
    '// The compiled form is described in ./ops.ts (CompiledGeom).',
    "import type { CompiledGeom } from './ops.ts';",
    '',
    `/** The ${names.length} DrawingML preset geometries, by prstGeom name. */`,
    'export const PRESET_GEOMS: ReadonlyMap<string, CompiledGeom> = new Map<string, CompiledGeom>([',
    ...names.map((n) => `  [${JSON.stringify(n)}, ${printGeom(compiled.get(n)!)}],`),
    ']);',
    '',
  ];
  return lines.join('\n');
}
