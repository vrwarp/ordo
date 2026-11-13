/**
 * The text rescue (design/27 §3.4, M9 `ladder`; lo-dependencies §4.5): a slide the converter could not
 * convert keeps its words, never becoming a picture. Only the slide's own text bodies are read, as text
 * objects in their boxes: shapes with text (placeholders placed by their layout or master), the text of
 * table cells (one object per table), groups to `RESCUE_DEPTH`; no geometry is evaluated, no picture,
 * effect, SmartArt or chart read, nothing of the layout or master drawn. Each slide is class hybrid with
 * `missing: ['slide']`: what it shows is only its text.
 *
 * The hub's pool task `pptx-scene` runs it (`SceneTaskInput.rescue`) for the slides whose conversion failed or
 * were past the import's pool time, under a short timeout of its own (`nativeJob.ts`).
 *
 * Bounds: `MAX_SHAPES_PER_SLIDE` elements and `MAX_OBJECTS` text objects per slide, `MAX_TEXT` characters per
 * object, `RESCUE_DEPTH` levels of groups. Never throws for one slide (an unreadable one is empty); throws only
 * when the deck has no readable presentation part, as `convertDeck` does. Deck strings reach a note only
 * through `clean`.
 */
import type { Box, Slide, TextObject, TextStyle } from '@ordo/domain';
import { missingEntry } from '@ordo/domain/missing.ts';
import { type SlideCtx, slideContext } from './context.ts';
import { readDeck, type SlideRef } from './deck.ts';
import { digestOf, MAX_OBJECTS } from './emit.ts';
import { clampBox, ordo } from './emit-ctx.ts';
import { dominant, legacyText, MAX_FONT_PX, MAX_TEXT, MIN_FONT_PX } from './emit-text.ts';
import { boxPx, childSpace, decompose, frameOf, IDENTITY, ptPx, slideRect } from './frame.ts';
import type { ConvertResult } from './index.ts';
import { chainOf, inheritedXfrm, isFooter, nvOf, spPrOf } from './inherit.ts';
import type { Affine, Classification, Frame } from './ir.ts';
import { clean, noteList } from './log.ts';
import { chooseAlternate } from './markup.ts';
import { openPackage, type PartSource } from './opc.ts';
import { readTextBody } from './text.ts';
import { boxAffine, MAX_SHAPES_PER_SLIDE, readXfrm } from './walk.ts';
import { child, children, num, path, textOf, type XNode } from './xml.ts';

/** Groups read below the slide's shape tree (lo-dependencies §4.5: "no groups past depth 4"). */
export const RESCUE_DEPTH = 4;

/** The note a rescued slide carries (the hub adds its own reason). */
export const RESCUE_NOTE = 'only its text is kept: the slide could not be converted';

/** The class of a rescued slide: hybrid, the slide itself missing (`Slide.pptx.missing`). */
const RESCUED: Classification = { tier: 'fallback', class: 'hybrid', reasons: ['rescue', 'missing:slide'] };

export interface RescueOptions {
  /** Read only the slides whose `SlideRef.index` is in [from, to). */
  range?: { from: number; to: number };
  /** A new id for each slide and object; default: deterministic `rescue-<n>`. */
  newId?: () => string;
}

const BLACK = { r: 0, g: 0, b: 0, a: 1 };

/** Every slide of `range` as its text alone (see the module comment), with the deck facts of `convertDeck`. */
export function rescueDeck(src: PartSource, opts: RescueOptions = {}): ConvertResult {
  const deckNotes = noteList();
  const pkg = openPackage(src, deckNotes.log);
  const deck = readDeck(pkg);
  const frame = frameOf(deck.size.cx, deck.size.cy);
  let n = 0;
  const newId = opts.newId ?? (() => `rescue-${++n}`);
  const range = opts.range;
  const refs = range ? deck.slides.filter((r) => r.index >= range.from && r.index < range.to) : deck.slides;
  const slides = refs.map((ref) => {
    const t0 = performance.now();
    const { notes, log } = noteList();
    log(RESCUE_NOTE);
    let objects: TextObject[] = [];
    try {
      const ctx = slideContext(pkg, deck, frame, ref, log);
      objects = rescueTexts(ctx, newId);
    } catch (e) {
      log(`its text could not be read either: ${clean(e instanceof Error ? e.message : String(e))}`);
    }
    const slide: Slide = { id: newId(), objects };
    return {
      index: ref.index,
      ...(ref.shown !== undefined ? { shown: ref.shown } : {}),
      hidden: ref.hidden,
      slide,
      classification: { ...RESCUED, reasons: [...RESCUED.reasons] },
      digest: digestOf(objects),
      notes,
      ms: performance.now() - t0,
      missing: [missingEntry('slide')],
    };
  });
  return {
    slides,
    media: [],
    slideRect: slideRect(frame),
    notes: [...deckNotes.notes],
    geoms: [],
    frame,
    sections: deck.sections,
    listed: deck.slides as SlideRef[],
  };
}

type Walk = { ctx: SlideCtx; newId: () => string; out: TextObject[]; count: number };

/** The slide's own text bodies as text objects, bottom first. */
function rescueTexts(ctx: SlideCtx, newId: () => string): TextObject[] {
  const w: Walk = { ctx, newId, out: [], count: 0 };
  walk(w, path(ctx.slide, 'p:cSld', 'p:spTree'), IDENTITY, 0);
  return w.out;
}

function walk(w: Walk, tree: XNode | undefined, map: Affine, depth: number): void {
  for (const el of tree?.children ?? []) {
    if (w.out.length >= MAX_OBJECTS) return;
    if (el.name === 'mc:AlternateContent') {
      if (depth < RESCUE_DEPTH) walk(w, chooseAlternate(el), map, depth + 1);
      continue;
    }
    if (el.name === '#text' || !nvOf(el)) continue;
    if (++w.count > MAX_SHAPES_PER_SLIDE) return;
    if (on(child(nvOf(el), 'p:cNvPr')?.attrs.hidden)) continue;
    const chain = chainOf(w.ctx, el, 'slide');
    const xfrm = el.name === 'p:graphicFrame' ? child(el, 'p:xfrm') : inheritedXfrm(chain);
    let place = xfrm ? readXfrm(xfrm) : undefined;
    if (!place && chain.ph && !isFooter(chain.ph))
      place = { x: 0, y: 0, cx: w.ctx.frame.cx, cy: w.ctx.frame.cy, rot: 0, flipH: false, flipV: false };
    if (el.name === 'p:grpSp') {
      if (depth >= RESCUE_DEPTH) continue;
      const own = place ?? readXfrm(undefined);
      const x = child(spPrOf(el), 'a:xfrm');
      const chOff = child(x, 'a:chOff');
      const chExt = child(x, 'a:chExt');
      const ext = { cx: finite(num(chExt?.attrs.cx), own.cx), cy: finite(num(chExt?.attrs.cy), own.cy) };
      const inner = childSpace(
        boxAffine(map, own),
        { x: finite(num(chOff?.attrs.x), 0), y: finite(num(chOff?.attrs.y), 0) },
        ext,
      );
      walk(w, el, inner, depth + 1);
      continue;
    }
    if (!place) continue;
    const xf = boxAffine(map, place);
    if (el.name === 'p:sp') {
      const body = readTextBody(w.ctx, chain);
      if (body) push(w, xf, legacyText(body), styleOf(w.ctx.frame, body));
    } else if (el.name === 'p:graphicFrame') {
      const tbl = path(el, 'a:graphic', 'a:graphicData', 'a:tbl');
      if (tbl) push(w, xf, tableText(tbl), plainStyle(18, w.ctx.frame));
    }
  }
}

/** A text object of `text` in the box `xf` places (cut to `MAX_TEXT`, never inside a surrogate pair). */
function push(w: Walk, xf: Affine, text: string, style: TextStyle): void {
  if (!text.trim()) return;
  let t = text;
  if (t.length > MAX_TEXT) {
    const c = t.charCodeAt(MAX_TEXT - 1);
    t = t.slice(0, c >= 0xd800 && c <= 0xdbff ? MAX_TEXT - 1 : MAX_TEXT);
  }
  const p = boxPx(w.ctx.frame, xf);
  const box: Box = clampBox({ x: p.x, y: p.y, w: p.w, h: p.h, rotation: p.rotation });
  if (!Number.isFinite(decompose(xf).w)) return;
  w.out.push({
    id: w.newId(),
    type: 'text',
    box,
    text: t,
    style,
    opacity: 1,
    origin: { src: 'pptx', role: 'text' },
  });
}

/** The legacy style of a body (as M1 wrote it): its dominant run's face, size and colour, its alignment. */
function styleOf(f: Frame, body: NonNullable<ReturnType<typeof readTextBody>>): TextStyle {
  const d = dominant(body);
  const st = d?.style;
  const out = plainStyle(st?.sizePt ?? 18, f);
  if (st?.latin) out.fontFamily = st.latin.slice(0, 300);
  if (st?.bold) out.fontWeight = 700;
  if (st?.italic) out.fontStyle = 'italic';
  if (st?.fill.kind === 'solid') out.color = ordo(st.fill.color);
  const a = d?.para.align;
  out.align = a === 'center' || a === 'right' ? a : 'left';
  out.valign = body.anchor;
  return out;
}

function plainStyle(sizePt: number, f: Frame): TextStyle {
  const px = ptPx(f, Number.isFinite(sizePt) ? sizePt : 18);
  return {
    fontFamily: 'Calibri',
    fontWeight: 400,
    fontStyle: 'normal',
    fontSizePx: Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, px)),
    color: { ...BLACK },
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
    letterSpacing: 0,
    padding: 0,
    transform: 'none',
  };
}

/** A table's text: each row a line, its cells' text (paragraphs joined by spaces) apart by two spaces. */
function tableText(tbl: XNode): string {
  const rows: string[] = [];
  let chars = 0;
  for (const tr of children(tbl, 'a:tr')) {
    const cells: string[] = [];
    for (const tc of children(tr, 'a:tc')) {
      const paras = children(child(tc, 'a:txBody'), 'a:p').map((p) =>
        (p.children ?? [])
          .map((r) =>
            r.name === 'a:r' || r.name === 'a:fld' ? textOf(child(r, 'a:t')) : r.name === 'a:br' ? ' ' : '',
          )
          .join(''),
      );
      const t = paras.join(' ').trim();
      if (t) cells.push(t);
    }
    const line = cells.join('  ');
    rows.push(line);
    chars += line.length + 1;
    if (chars > MAX_TEXT) break;
  }
  return rows.join('\n').replace(/\n+$/, '');
}

function on(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

function finite(v: number | undefined, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
