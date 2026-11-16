/**
 * Tables as emitted (design/27 §15 M6 tables; split out of `emit.ts` in M9, `conv-seams`; M9 `tables-conv`).
 *
 * - **The table object** (`emitTableObject`, M9, tables-object.md §4): one `ShapeObject` with `table`
 *   (`@ordo/domain` `TableData`), origin role 'table', not locked, written when `EmitOptions.m9Writes` has
 *   'table' (the hub's `M9_WRITES`, default all). Its legacy fields are what an older build draws: a rect
 *   in the table's frame filled with the table's background (M9 decision 4: no legacy group is written).
 *   - **The stored form: LibreOffice's, on every hub** (design/27 §15 "The stored form"; owner question T2's
 *     default). `cols` and `rows` are the columns and grown rows of the converter's model of how LibreOffice
 *     24.2 lays the table out (`TableElement.lo`; else the converter's own, which then agree with it), in
 *     logical px, with `rowRule: 'fixed'`: the drawer keeps them as stored (rows grown by its own lines grew
 *     past LibreOffice's wherever they disagree with the converter's model of LibreOffice's: 7 of 63 table
 *     slides fell by 0.01-0.49). `box` is the table's frame at their width and height (`lo.xf`). The cells'
 *     text is at LibreOffice's sizes (`loSizePt`: 14 pt is stored 14.04 pt), and where LibreOffice's row is
 *     shorter than the text, or draws its lines higher, the spill into the margins and the baseline lift are
 *     folded into each cell's insets (`tables.ts` `asLibreOffice`). Nothing in the layout reads the harness's
 *     policies (`EmitOptions.loCompat`): with and without them the grid, rows, sizes and insets are the same.
 *   - **Cells** in the order the stored table places them (row-major, `@ordo/domain` `placeCells`), each
 *     with its rich text (`richText`, as text boxes are written: runs, paragraph styles, fallback fonts;
 *     plain once the slide passes its text budget) without autofit, its spans, fill and diagonals.
 *   - **Palettes** by canonical JSON (`@ordo/domain` `Palette`, never deck-keyed objects): `base` is the
 *     cells' most common text box style; each cell's style entry holds only what differs from it in the
 *     fields a cell style has (`CellStyle`: family, weight, slant, size, colour, insets, language, fallback
 *     fonts, alignment, anchor, direction, vertical text), as the domain maps them (`@ordo/domain/cellstyle.ts`
 *     `cellStyleOf`, the inverse of the `cellTextStyle` the table model reads a cell with), within the
 *     schema's bounds (`boundEntry`). What a cell's box style differs in otherwise is
 *     written where it means the same: letter spacing, underline, outline, shadow and capitals on its runs,
 *     line spacing on its paragraphs (a box's `lineHeight` is its paragraphs' default proportion). Run
 *     formatting goes to `runStyles` as `[start, end, style]`; fills (a gradient with its first stop as the
 *     colour, a pattern as its blended colour) to `fills`; lines (width, colour, dash) to `lineStyles`, the
 *     resolved edges to `h` and `v`.
 *   - **Bounds**: the schema's (`TABLE_LIMITS`): a cell's text within 10,000 characters, 2,000 runs and
 *     1,000 paragraphs, the table's within 60,000 characters (later cells empty), 8,000 runs and 8,000
 *     paragraphs; a palette past its size gives later entries none (the base style, no fill, no line,
 *     noted). The slide's text budget (`TEXT_BUDGET_BYTES`) counts each cell's JSON as it is written.
 *   - **LibreOffice's run-text policies** (`EmitOptions.loCompat`, harness only): the cells' runs as
 *     LibreOffice draws them where PowerPoint differs (no run shadow, no outline on filled text, `baseline="0"`
 *     read as unset: `richtext.ts` `RichOptions.lo`), as a text box's. They are not layout and no hub stores
 *     them (design/27 §17 "LibreOffice is not PowerPoint").
 * - **The M6 group** (`emitTableGroup`, `tables.ts` `emitTable`): locked grid shapes (background, cell fills,
 *   lines) and one rich `TextObject` per cell; what the converter writes without 'table' in `m9Writes` (the
 *   kill switch, `version.ts` `M9_HELD_BACK`), the budgets then counting its objects and keeping M6's cell
 *   cap (`budget.ts` `BudgetOptions.tables`). Diagonals are not drawn by it (noted).
 *
 * Pure: IR in, ordo objects out.
 */
import type {
  CellStyle,
  Rgba as OrdoRgba,
  ShapeObject,
  SlideObject,
  TableCell as StoredCell,
  TableData,
  TableFill,
  TableLineStyle,
  TableRun,
  TableRunStyle,
  TextPara,
  TextRun,
  TextStyle,
} from '@ordo/domain';
import { cellStyleOf } from '@ordo/domain/cellstyle.ts';
import { canonicalJson, Palette } from '@ordo/domain/palette.ts';
import { chargeText, overText, SLIDE_BUDGET_NOTE } from './emit-budget.ts';
import { clampBox, type EmitCtx, legacyColor, utf8Bytes, writes } from './emit-ctx.ts';
import { boxPx, lenPx } from './frame.ts';
import { dashOf, gradientOf } from './geom.ts';
import type { Fill, Line, TableElement, TextBody } from './ir.ts';
import { type RichText, richText } from './richtext.ts';
import { asLibreOffice, atLoSizes, emitTable } from './tables.ts';

/** The stored table's bounds (`@ordo/domain` `TABLE_LIMITS`; `emit-table.test.ts` checks them against it). */
export const TABLE_OBJECT_LIMITS = {
  cellText: 10_000,
  tableText: 60_000,
  cellRuns: 2_000,
  tableRuns: 8_000,
  cellParas: 1_000,
  tableParas: 8_000,
  cellStyles: 64,
  runStyles: 256,
  fills: 64,
  lineStyles: 32,
  edges: 8_192,
} as const;

/** Logical coordinates are bounded by the schema (`coord`). */
const MAX_COORD = 100_000;
/** Line widths as the render clamp keeps them (`CLAMP.maxEffectPx`'s order, as the M6 group's strokes). */
const MAX_LINE_PX = 500;
/** Single line spacing of the office line model: 1.2 × the font size. */
const SINGLE_LINE = 1.2;

const bound = (v: number, lo: number, hi: number) =>
  Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : Math.min(hi, Math.max(lo, 0));

/**
 * The M9 table object of a table (`ShapeObject.table`; see the module header): pushes it on `out` and
 * returns true, or returns false, leaving `out` as it was, when it writes none: the field is off
 * (`m9Writes` without 'table'), or the table is residual (LibreOffice's art draws it).
 */
export function emitTableObject(ctx: EmitCtx, e: TableElement, out: SlideObject[]): boolean {
  if (!writes(ctx, 'table') || e.support === 'residual') return false;
  const f = ctx.frame;
  // LibreOffice's form on every hub (design/27 §15 "The stored form"): its columns and grown rows
  // (`TableElement.lo`, else the converter's, which then agree with them), fixed (`rowRule: 'fixed'`), and the
  // table's affine at their size. Nothing here reads the harness's policies (`ctx.lo`).
  const colsEmu = e.lo?.cols ?? e.cols;
  const rowsEmu = e.lo?.rows ?? e.rows;
  const W = colsEmu.reduce((s, w) => s + w, 0);
  if (!(W > 0) || !colsEmu.length || !rowsEmu.length) return false;
  const box = clampBox(boxPx(f, e.lo?.xf ?? e.xf));
  const px = (v: number) => bound(lenPx(f, v), 0, MAX_COORD);

  // Palettes.
  const styles = new Palette<CellStyle>(TABLE_OBJECT_LIMITS.cellStyles);
  const runStyles = new Palette<TableRunStyle>(TABLE_OBJECT_LIMITS.runStyles);
  const fills = new Palette<TableFill>(TABLE_OBJECT_LIMITS.fills);
  const lineStyles = new Palette<TableLineStyle>(TABLE_OBJECT_LIMITS.lineStyles);
  const full = new Set<string>();
  const noteFull = (what: string) => {
    if (full.has(what)) return;
    full.add(what);
    ctx.log(`a table has more ${what} than the table object keeps: the rest are drawn plain`);
  };
  const fillIx = (fill: Fill | undefined): number | undefined => {
    const v = fill ? tableFill(fill, ctx.log) : undefined;
    if (!v) return undefined;
    const i = fills.add(v);
    if (i === undefined) noteFull('fills');
    return i;
  };
  const lineIx = (line: Line | undefined): number | undefined => {
    const v = line ? lineStyle(f, line, ctx.log) : undefined;
    if (!v) return undefined;
    const i = lineStyles.add(v);
    if (i === undefined) noteFull('line styles');
    return i;
  };

  // Cell text: each body as a text box writes it, without autofit (cells never shrink: text past its fixed row
  // overflows it, as a text box's overflows its box).
  type Cell = { rich: RichText | undefined; style: TextStyle | undefined };
  const texts: Cell[] = [];
  let tableChars = 0;
  for (const [i, c] of e.cells.entries()) {
    // At LibreOffice's sizes (`loSizePt`: 14 pt is stored 14.04 pt), as its rows were measured.
    const body: TextBody = atLoSizes({ ...c.text, autofit: { kind: 'none' } });
    const plain = overText(ctx) || tableChars >= TABLE_OBJECT_LIMITS.tableText;
    let rich = tableChars >= TABLE_OBJECT_LIMITS.tableText ? undefined : cellRich(ctx, body, plain);
    if (rich) {
      rich = boundCell(rich, TABLE_OBJECT_LIMITS.tableText - tableChars);
      tableChars += rich.text.length;
    }
    let style = rich?.style ?? emptyStyle(ctx, body);
    // The spill into the margins and the baseline lift, folded into the insets.
    if (style && e.lo)
      style = asLibreOffice(style, lenPx(f, e.lo.spill[i] ?? 0), lenPx(f, e.lo.lift[i] ?? 0));
    if (style) style = withoutFit(style);
    texts.push({ rich, style });
  }
  if (tableChars >= TABLE_OBJECT_LIMITS.tableText)
    ctx.log(`a table has more than ${TABLE_OBJECT_LIMITS.tableText} characters: its later cells are empty`);

  // The base: the cells' most common box style (the first to lead keeps a tie).
  const counts = new Map<string, { n: number; style: TextStyle }>();
  let base: TextStyle | undefined;
  let most = 0;
  for (const t of texts) {
    if (!t.style) continue;
    const k = canonicalJson(t.style);
    let c = counts.get(k);
    if (!c) counts.set(k, (c = { n: 0, style: t.style }));
    c.n++;
    if (c.n > most) {
      most = c.n;
      base = c.style;
    }
  }
  base ??= DEFAULT_CELL_STYLE;

  // Cells.
  let tableRuns = 0;
  let tableParas = 0;
  const cells: StoredCell[] = [];
  for (const [i, c] of e.cells.entries()) {
    const t = texts[i]!;
    const cell: StoredCell = {};
    if (c.cols > 1) cell.colSpan = Math.min(c.cols, 64);
    if (c.rows > 1) cell.rowSpan = Math.min(c.rows, 256);
    const style = t.style ?? base;
    const entry = boundEntry(cellStyleOf(base, style, vertOf(c.vert)));
    if (Object.keys(entry).length) {
      const k = styles.add(entry);
      if (k === undefined) noteFull('cell styles');
      else cell.style = k;
    }
    const fill = fillIx(c.fill);
    if (fill !== undefined) cell.fill = fill;
    if (c.diag) {
      const down = lineIx(c.diag.down);
      const up = lineIx(c.diag.up);
      if (down !== undefined || up !== undefined)
        cell.diag = { ...(down !== undefined ? { down } : {}), ...(up !== undefined ? { up } : {}) };
    }
    const rich = t.rich;
    if (rich?.text) {
      cell.text = rich.text;
      const folded = foldBox(rich, style, base);
      let runs = folded.runs ?? [];
      if (tableRuns + runs.length > TABLE_OBJECT_LIMITS.tableRuns) {
        runs = runs.slice(0, Math.max(0, TABLE_OBJECT_LIMITS.tableRuns - tableRuns));
        noteFull('runs');
      }
      const stored: TableRun[] = [];
      for (const r of runs) {
        const { start, end, ...look } = r;
        const k = runStyles.add(look);
        if (k === undefined) noteFull('run styles');
        else stored.push([start, end, k]);
      }
      tableRuns += stored.length;
      if (stored.length) cell.runs = stored;
      let paras = folded.paras;
      if (paras && tableParas + paras.length > TABLE_OBJECT_LIMITS.tableParas) {
        paras = paras.slice(0, Math.max(0, TABLE_OBJECT_LIMITS.tableParas - tableParas));
        noteFull('paragraph styles');
      }
      if (paras?.length) {
        cell.paras = paras;
        tableParas += paras.length;
      }
    }
    cells.push(cell);
  }

  // Lines along the grid: [edge, from, to, line style], as resolved (none inside a merge).
  const h: [number, number, number, number][] = [];
  const v: [number, number, number, number][] = [];
  for (const l of e.lines) {
    const k = lineIx(l.line);
    if (k === undefined) continue;
    const list = l.dir === 'h' ? h : v;
    if (list.length >= TABLE_OBJECT_LIMITS.edges) {
      noteFull('lines');
      continue;
    }
    list.push([l.at, l.from, l.to, k]);
  }
  const background = fillIx(e.background);

  const table: TableData = {
    cols: colsEmu.map(px),
    rows: rowsEmu.map(px),
    cells,
    base,
    ...(styles.size ? { styles: styles.entries } : {}),
    ...(runStyles.size ? { runStyles: runStyles.entries } : {}),
    ...(fills.size ? { fills: fills.entries } : {}),
    ...(lineStyles.size ? { lineStyles: lineStyles.entries } : {}),
    ...(h.length ? { h } : {}),
    ...(v.length ? { v } : {}),
    ...(background !== undefined ? { background } : {}),
    ...(e.rtl ? { rtl: true } : {}),
    rowRule: 'fixed',
  };
  const legacy = e.background ? legacyColor(e.background) : undefined;
  const o: ShapeObject = {
    id: ctx.newId(),
    type: 'shape',
    box,
    shape: 'rect',
    ...(legacy ? { fill: legacy } : {}),
    opacity: 1,
    radius: 0,
    origin: {
      src: 'pptx',
      ...(Number.isInteger(e.shapeId) && e.shapeId > 0
        ? { shapeId: Math.min(2_147_483_647, e.shapeId) }
        : {}),
      role: 'table',
      ...(e.group !== undefined ? { group: Math.min(100_000, Math.max(0, e.group)) } : {}),
    },
    table,
  };
  out.push(o);
  return true;
}

/** A table's objects: the M9 table object when `emitTableObject` writes one, else the M6 group. */
export function emitTableOf(ctx: EmitCtx, e: TableElement, out: SlideObject[]): void {
  if (emitTableObject(ctx, e, out)) return;
  emitTableGroup(ctx, e, out);
}

/**
 * A table as its M6 group (`tables.ts`): its cells' text is rich text in the slide's budget like any other
 * (written plain past it), drawn with the harness's LibreOffice policies when asked; the legacy text
 * emission has no table of its own and writes the same cells. It draws no diagonals (noted).
 */
function emitTableGroup(ctx: EmitCtx, e: TableElement, out: SlideObject[]): void {
  const texts = emitTable(
    {
      frame: ctx.frame,
      newId: ctx.newId,
      log: ctx.log,
      color: legacyColor,
      ...(ctx.lo ? { lo: true } : {}),
      cellText: (body) =>
        richText(body, {
          frame: ctx.frame,
          log: ctx.log,
          ...(ctx.lo ? { lo: true } : {}),
          ...(overText(ctx) ? { plain: true } : {}),
        }),
    },
    e,
    out,
  );
  for (const o of texts) chargeText(ctx, o);
  if (e.support !== 'residual' && e.cells.some((c) => c.diag))
    ctx.log('diagonal lines of table cells are not drawn (M6 group)');
}

// ── Cells ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A cell's rich text, counted against the slide's text budget (`MAX_SLIDE_BYTES`) as it is written. `ctx.lo`
 * reaches only the run-text policies (see the module header), never the layout.
 */
function cellRich(ctx: EmitCtx, body: TextBody, plain: boolean): RichText | undefined {
  const rich = richText(body, {
    frame: ctx.frame,
    log: ctx.log,
    ...(ctx.lo ? { lo: true } : {}),
    ...(plain ? { plain: true } : {}),
  });
  if (rich && !overText(ctx)) {
    ctx.textBytes += utf8Bytes(JSON.stringify(rich));
    if (overText(ctx)) ctx.log(SLIDE_BUDGET_NOTE);
  }
  return rich;
}

/**
 * The box style of an empty cell, to type into: its end mark's (the fields a cell with a character in that
 * style gets), as the M6 group's empty cells have it.
 */
function emptyStyle(ctx: EmitCtx, body: TextBody): TextStyle | undefined {
  const p = body.paras[0];
  if (!p) return undefined;
  const probe = richText(
    { ...body, paras: [{ ...p, runs: [{ kind: 'text', text: 'x', style: p.end }] }] },
    { frame: ctx.frame, log: () => {}, ...(ctx.lo ? { lo: true } : {}), plain: true },
  );
  return probe?.style;
}

/** A cell's rich text within the stored cell's bounds: its text, runs and paragraphs cut, within `room`. */
function boundCell(rich: RichText, room: number): RichText {
  const n = Math.max(0, Math.min(TABLE_OBJECT_LIMITS.cellText, room));
  let { text, runs, paras } = rich;
  if (text.length > n) {
    text = text.slice(0, n);
    // Never end on half of a surrogate pair.
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  }
  if (runs)
    runs = runs
      .filter((r) => r.start < text.length)
      .map((r) => (r.end > text.length ? { ...r, end: text.length } : r))
      .slice(0, TABLE_OBJECT_LIMITS.cellRuns);
  const count = text.split('\n').length;
  if (paras) paras = paras.slice(0, Math.min(count, TABLE_OBJECT_LIMITS.cellParas));
  return {
    ...rich,
    text,
    ...(runs?.length ? { runs } : { runs: undefined }),
    ...(paras?.length ? { paras } : { paras: undefined }),
  };
}

/** A box style without its fit: a cell grows its row and never shrinks its text. */
function withoutFit(s: TextStyle): TextStyle {
  if (s.autofit === undefined && s.fitScale === undefined) return s;
  const { autofit: _a, fitScale: _f, ...rest } = s;
  return rest;
}

/**
 * A cell's style entry within the schema's bounds (`CellStyle`: a whole weight of 1-1,000, a size of 1-1,000
 * px; a text box allows more): what `cellStyleOf` (the domain's inverse of `cellTextStyle`) gives, bounded.
 */
function boundEntry(entry: CellStyle): CellStyle {
  if (typeof entry.fontWeight === 'number') entry.fontWeight = bound(Math.round(entry.fontWeight), 1, 1000);
  if (typeof entry.fontSizePx === 'number') entry.fontSizePx = bound(entry.fontSizePx, 1, 1000);
  return entry;
}

/** `a:tcPr vert` as the stored cell's: rotated (vert, vert270) or stacked upright (eaVert, WordArt's). */
function vertOf(v: string | undefined): CellStyle['vert'] | undefined {
  switch (v) {
    case undefined:
    case 'horz':
      return undefined;
    case 'vert':
    case 'mongolianVert':
      return 'vert';
    case 'vert270':
      return 'vert270';
    default:
      return 'eaVert'; // eaVert, wordArtVert, wordArtVertRtl
  }
}

/**
 * A cell's runs and paragraph styles with what its box style differs from `base` in, outside the cell style
 * fields, written where it means the same: on every run (the gaps between runs get one) letter spacing,
 * underline, outline, shadow and capitals it does not set itself; on every paragraph a line spacing it does
 * not set itself (`lineHeight` / 1.2 is the office model's default proportion).
 */
function foldBox(
  rich: RichText,
  style: TextStyle,
  base: TextStyle,
): { runs?: TextRun[]; paras?: (TextPara | null)[] } {
  const patch: Partial<TextRun> = {};
  if ((style.letterSpacing ?? 0) !== (base.letterSpacing ?? 0))
    patch.letterSpacing = style.letterSpacing ?? 0;
  if (!!style.underline !== !!base.underline) patch.underline = !!style.underline;
  if (canonicalJson(style.outline ?? null) !== canonicalJson(base.outline ?? null))
    patch.outline = style.outline ?? null;
  if (canonicalJson(style.shadow ?? null) !== canonicalJson(base.shadow ?? null))
    patch.shadow = style.shadow ?? null;
  if ((style.transform ?? 'none') !== (base.transform ?? 'none'))
    patch.caps = style.transform === 'uppercase' ? 'all' : 'none';
  let runs = rich.runs;
  const keys = Object.keys(patch) as (keyof TextRun)[];
  if (keys.length && rich.text.length) {
    const out: TextRun[] = [];
    let at = 0;
    const gap = (end: number) => {
      if (end > at) out.push({ start: at, end, ...patch });
    };
    for (const r of runs ?? []) {
      gap(r.start);
      const merged: TextRun = { ...r };
      for (const k of keys) if (merged[k] === undefined) (merged as Record<string, unknown>)[k] = patch[k];
      out.push(merged);
      at = Math.max(at, r.end);
    }
    gap(rich.text.length);
    runs = out.slice(0, TABLE_OBJECT_LIMITS.cellRuns);
  }
  let paras = rich.paras;
  if (Math.abs((style.lineHeight ?? SINGLE_LINE) - (base.lineHeight ?? SINGLE_LINE)) > 1e-9) {
    const lineSpacing = bound((style.lineHeight ?? SINGLE_LINE) / SINGLE_LINE, 0, 13.2);
    const count = Math.min(rich.text.split('\n').length, TABLE_OBJECT_LIMITS.cellParas);
    paras = Array.from({ length: count }, (_, i) => {
      const p = rich.paras?.[i] ?? null;
      if (p && (p.lineSpacing !== undefined || p.lineSpacingPx !== undefined)) return p;
      return { ...(p ?? {}), lineSpacing };
    });
  }
  return { ...(runs?.length ? { runs } : {}), ...(paras?.length ? { paras } : {}) };
}

/** The box style of a table whose cells give none (no paragraph to take one from). */
const DEFAULT_CELL_STYLE: TextStyle = {
  fontFamily: 'Calibri',
  fontWeight: 400,
  fontStyle: 'normal',
  fontSizePx: 24,
  color: { r: 0, g: 0, b: 0, a: 1 },
  align: 'left',
  valign: 'top',
  lineHeight: SINGLE_LINE,
  letterSpacing: 0,
  padding: 0,
  transform: 'none',
  lineModel: 'office',
};

// ── Fills and lines ─────────────────────────────────────────────────────────────────────────────────────

/** A cell's or the table's fill as stored, or undefined for none (pictures were left out when read). */
function tableFill(fill: Fill, log: (msg: string) => void): TableFill | undefined {
  const color = legacyColor(fill);
  if (!color) return undefined;
  const gradient = fill.kind === 'gradient' ? gradientOf(fill, 0, log) : undefined;
  if (fill.kind === 'pattern') log('a table cell filled with a pattern is drawn as its blended colour');
  return gradient ? { color, gradient } : { color };
}

/** A border line as stored: its width in logical px, its solid colour and its dash. */
function lineStyle(f: EmitCtx['frame'], line: Line, log: (msg: string) => void): TableLineStyle | undefined {
  const color: OrdoRgba | undefined = legacyColor(line.fill);
  if (!color) return undefined;
  const dash = dashOf(line, log);
  return { width: bound(lenPx(f, line.width), 0, MAX_LINE_PX), color, ...(dash ? { dash } : {}) };
}
