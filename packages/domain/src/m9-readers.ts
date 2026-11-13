import { slideContent } from './content.ts';
import { readableText } from './readable.ts';
import {
  type ChartData,
  type ChartTitle,
  type Slide,
  type SlideObject,
  TABLE_LIMITS,
  type TableData,
  type TextPara,
} from './schemas.ts';

/*
 * Readers of the M9 fields (design/27 M9): what a table, a chart and a vector picture give the text readers
 * (search, cue labels, the font scan) and which shape files a slide draws. Pure and defensive: they read
 * stored slides, which the schema bounds, and never throw on a malformed one.
 */

/** The longest text a reader returns for one table or chart (the stored table text bound). */
export const READER_TEXT_MAX = 60_000;

/** Appends to a bounded text: once `max` characters are kept, the rest is dropped. */
class Bounded {
  readonly parts: string[] = [];
  length = 0;
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  add(s: string): boolean {
    if (this.length >= this.max) return false;
    const t = s.length > this.max - this.length ? s.slice(0, this.max - this.length) : s;
    this.parts.push(t);
    this.length += t.length;
    return this.length < this.max;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const paras = (x: unknown) => (Array.isArray(x) ? (x as (TextPara | null)[]) : undefined);

/**
 * The grid row of each cell of a table, in cell order (-1 for a cell past the grid): cells sit row-major,
 * each at the next grid slot no earlier cell covers, and a span is cut where it would reach a covered slot or
 * the grid's edge (design/27 M9 tables; the editor's placement follows the same rule). O(grid).
 */
export function tableCellRows(t: Pick<TableData, 'rows' | 'cols' | 'cells'>): number[] {
  const R = Math.min(arr(t.rows).length, TABLE_LIMITS.rows);
  const C = Math.min(arr(t.cols).length, TABLE_LIMITS.cols);
  const cells = arr(t.cells);
  const out: number[] = new Array(cells.length).fill(-1);
  if (!R || !C) return out;
  const covered = new Uint8Array(R * C);
  let at = 0;
  for (let i = 0; i < cells.length; i++) {
    while (at < covered.length && covered[at]) at++;
    if (at >= covered.length) break;
    const row = Math.floor(at / C);
    const col = at % C;
    out[i] = row;
    const c = cells[i];
    const span = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 1 ? v : 1);
    let cs = Math.min(span(isObj(c) ? c.colSpan : 1), C - col);
    for (let k = 1; k < cs; k++)
      if (covered[at + k]) {
        cs = k;
        break;
      }
    let rs = Math.min(span(isObj(c) ? c.rowSpan : 1), R - row);
    for (let r = 1; r < rs; r++) {
      let free = true;
      for (let k = 0; k < cs && free; k++) if (covered[(row + r) * C + col + k]) free = false;
      if (!free) {
        rs = r;
        break;
      }
    }
    for (let r = 0; r < rs; r++) covered.fill(1, (row + r) * C + col, (row + r) * C + col + cs);
  }
  return out;
}

/**
 * A table's text as people read it: rows by '\n', the cells of a row by '\t', each cell's text with its
 * automatic numbers and bullets (`readableText`) and its paragraphs joined by spaces; empty cells and rows
 * are left out. For search, and the cue
 * label of a slide whose only text is a table. At most `READER_TEXT_MAX` characters.
 */
export function tableText(t: TableData | undefined): string {
  if (!isObj(t)) return '';
  const cells = arr(t.cells);
  const rows = tableCellRows(t);
  const byRow = new Map<number, string[]>();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const row = rows[i] ?? -1;
    if (row < 0 || !isObj(c)) continue;
    const text = str(c.text);
    if (!text) continue;
    // A cell's paragraphs are one line here, so that rows stay rows.
    const readable = readableText({ text, paras: paras(c.paras) }).replace(/\n/g, ' ');
    const list = byRow.get(row);
    if (list) list.push(readable);
    else byRow.set(row, [readable]);
  }
  const out = new Bounded(READER_TEXT_MAX);
  let first = true;
  for (const row of [...byRow.keys()].sort((a, b) => a - b)) {
    if (!out.add(`${first ? '' : '\n'}${byRow.get(row)!.join('\t')}`)) break;
    first = false;
  }
  return out.parts.join('');
}

function titleText(t: ChartTitle | undefined): string {
  if (!isObj(t)) return '';
  const text = str(t.text);
  return text ? readableText({ text, paras: paras(t.paras) }) : '';
}

/**
 * A chart's text as people read it, one line each: its title, its axes' titles, its series' names and its
 * categories. For search and labels. At most `READER_TEXT_MAX` characters.
 */
export function chartText(c: ChartData | undefined): string {
  if (!isObj(c)) return '';
  const lines: string[] = [];
  const add = (s: string) => {
    if (s) lines.push(s);
  };
  add(titleText(c.title));
  for (const a of arr(c.axes)) if (isObj(a)) add(titleText(a.title as ChartTitle | undefined));
  for (const g of arr(c.groups)) if (isObj(g)) for (const s of arr(g.series)) if (isObj(s)) add(str(s.name));
  for (const cat of arr(c.categories)) add(str(cat));
  const out = new Bounded(READER_TEXT_MAX);
  for (let i = 0; i < lines.length; i++) if (!out.add(i ? `\n${lines[i]}` : lines[i]!)) break;
  return out.parts.join('');
}

/**
 * The text an object gives search: a text object's readable text, a table's cells, a chart's titles, series
 * names and categories; '' for anything else.
 */
export function objectSearchText(o: SlideObject | undefined): string {
  if (!isObj(o)) return '';
  if (o.type === 'text') return typeof o.text === 'string' ? readableText(o) : '';
  return extraText(o);
}

/**
 * The text an object holds outside a text object (a table's or a chart's, else ''): what the font scan reads
 * for the scripts its fallback faces cover, besides text objects.
 */
export function extraText(o: SlideObject | undefined): string {
  if (!isObj(o) || o.type !== 'shape') return '';
  if (isObj(o.table)) return tableText(o.table);
  if (isObj(o.chart)) return chartText(o.chart);
  return '';
}

/** Adds a family name once (`add` receives each name, unchecked beyond being a non-empty string). */
function addFamilies(add: (f: string) => void, ...names: unknown[]): void {
  for (const f of names) if (typeof f === 'string' && f) add(f);
}

function addParaFamilies(add: (f: string) => void, paras: unknown): void {
  for (const p of arr(paras)) if (isObj(p) && isObj(p.bullet)) addFamilies(add, p.bullet.fontFamily);
}

/**
 * The families a table draws in: its base style's family and fallbacks, its cell styles' and run styles',
 * and its cells' bullets.
 */
export function tableFamilies(t: TableData | undefined): string[] {
  const out = new Set<string>();
  if (!isObj(t)) return [];
  const add = (f: string) => out.add(f);
  if (isObj(t.base)) addFamilies(add, t.base.fontFamily, ...arr(t.base.fallbackFonts));
  for (const s of arr(t.styles)) if (isObj(s)) addFamilies(add, s.fontFamily, ...arr(s.fallbackFonts));
  for (const r of arr(t.runStyles)) if (isObj(r)) addFamilies(add, r.fontFamily);
  for (const c of arr(t.cells)) if (isObj(c)) addParaFamilies(add, c.paras);
  return [...out];
}

/** The families a chart draws in: its text styles' families and fallbacks, and its titles' runs and bullets. */
export function chartFamilies(c: ChartData | undefined): string[] {
  const out = new Set<string>();
  if (!isObj(c)) return [];
  const add = (f: string) => out.add(f);
  for (const t of arr(c.texts)) if (isObj(t)) addFamilies(add, t.fontFamily, ...arr(t.fallbackFonts));
  const titles: unknown[] = [c.title];
  for (const a of arr(c.axes)) if (isObj(a)) titles.push(a.title);
  for (const t of titles) {
    if (!isObj(t)) continue;
    for (const r of arr(t.runs)) if (isObj(r)) addFamilies(add, r.fontFamily);
    addParaFamilies(add, t.paras);
  }
  return [...out];
}

/**
 * The families an object names outside a text object's style, runs and bullets: a table's, a chart's and a
 * vector picture's (`ImageObject.vectorFonts`). goLive ships their faces and drawers wait for them, as for
 * text.
 */
export function extraFontFamilies(o: SlideObject | undefined): string[] {
  if (!isObj(o)) return [];
  if (o.type === 'image') return arr(o.vectorFonts).filter((f): f is string => typeof f === 'string' && !!f);
  if (o.type !== 'shape') return [];
  if (isObj(o.table)) return tableFamilies(o.table);
  if (isObj(o.chart)) return chartFamilies(o.chart);
  return [];
}

/**
 * Every shape file a slide draws, in drawing order and once each: the geometry files of its shapes'
 * geometries and its pictures' masks (`ShapeGeom.ref`, M6 round 2) and its decorations' files
 * (`DecorData.ref`, M9). What a drawer reads before it draws the slide, and what goLive ships with it. Refs as
 * stored: the hub's are SHA-256 names (`isGeomFileRef`), the converter's placeholders until the hub replaces
 * them.
 */
export function drawnShapeFileRefs(slide: Pick<Slide, 'objects' | 'imported' | 'pptx'>): string[] {
  const out = new Set<string>();
  const add = (holder: unknown) => {
    const ref = isObj(holder) ? holder.ref : undefined;
    if (typeof ref === 'string' && ref) out.add(ref);
  };
  for (const o of slideContent(slide).objects) {
    if (!isObj(o)) continue;
    if (o.type === 'shape') {
      add(o.geom);
      add(o.decor);
    } else if (o.type === 'image') add(o.mask);
  }
  return [...out];
}
