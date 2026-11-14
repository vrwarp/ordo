import { hexToRgba, type Presentation, type Rgba, rgbaHex, type Theme } from '@ordo/domain';
import { createContext, useContext, useMemo } from 'react';
import { type ColorSwatch, DEFAULT_SWATCHES } from './colorMath.ts';

/** Colours offered after the deck's own: the Office theme's, which most church decks start from. */
export const STANDARD_COLORS: readonly ColorSwatch[] = [
  { color: hexToRgba('#ffffff'), name: 'White' },
  { color: hexToRgba('#000000'), name: 'Black' },
  { color: hexToRgba('#7f7f7f'), name: 'Grey' },
  { color: hexToRgba('#c00000'), name: 'Dark red' },
  { color: hexToRgba('#ed7d31'), name: 'Orange' },
  { color: hexToRgba('#ffc000'), name: 'Gold' },
  { color: hexToRgba('#70ad47'), name: 'Green' },
  { color: hexToRgba('#4472c4'), name: 'Blue' },
  { color: hexToRgba('#1f3864'), name: 'Navy' },
  { color: hexToRgba('#7030a0'), name: 'Purple' },
];

/** The deck's colours shown first, at most. */
export const DECK_SWATCHES = 8;
/**
 * Colours read from one deck, at most: a deck's objects are untrusted (an import, a paste) and the scan runs
 * whenever a paint picker opens, so it stops after this many (a few milliseconds) and ranks what it has.
 */
export const DECK_COLOR_READS = 50_000;

const sameColor = (a: Rgba | undefined, b: Rgba | undefined) =>
  !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
const colorKey = (c: Rgba) => `${c.r},${c.g},${c.b},${c.a}`;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** A colour as the schema stores one; anything else (a hostile or half-built object) is skipped. */
const isRgba = (c: unknown): c is Rgba =>
  !!c &&
  typeof c === 'object' &&
  finite((c as Rgba).r) &&
  finite((c as Rgba).g) &&
  finite((c as Rgba).b) &&
  finite((c as Rgba).a);
const list = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

/**
 * Live presentation & theme swatches: the applied theme's text colour first, then the deck's most-used
 * colours (at most `DECK_SWATCHES`), followed by standard colours. The deck's colours are what its objects
 * paint with: text and run colours, solid fills and gradient stops of shapes and gradient text, and the
 * palettes of M9's objects (a table's text, run and fill colours, a decoration's fills, gradients and
 * outlines, a chart's fills), so an imported PowerPoint deck offers its own colours.
 */
export function deckColors(p: Presentation | undefined, theme?: Theme): ColorSwatch[] {
  const counts = new Map<string, { color: Rgba; n: number; first: number }>();
  let order = 0;
  let reads = 0;
  const add = (c: unknown) => {
    if (reads >= DECK_COLOR_READS) return;
    reads++;
    if (!isRgba(c)) return;
    const k = colorKey(c);
    const hit = counts.get(k);
    if (hit) hit.n++;
    else counts.set(k, { color: c, n: 1, first: order++ });
  };
  const addGradient = (g: unknown) => {
    for (const s of list(rec(g).stops)) add(rec(s).color);
  };
  const addFills = (fills: unknown) => {
    for (const f of list(fills)) {
      add(rec(f).color);
      addGradient(rec(f).gradient);
    }
  };
  scan: for (const sec of list(p?.sections))
    for (const s of list(rec(sec).slides))
      for (const raw of list(rec(s).objects)) {
        if (reads >= DECK_COLOR_READS) break scan;
        const o = rec(raw);
        if (o.type === 'text') {
          const style = rec(o.style);
          add(style.color);
          addGradient(style.paint);
          for (const r of list(o.runs)) add(rec(r).color);
        } else if (o.type === 'shape') {
          add(o.fill);
          addGradient(o.gradient);
          const table = rec(o.table);
          add(rec(table.base).color);
          for (const st of list(table.styles)) add(rec(st).color);
          for (const rs of list(table.runStyles)) add(rec(rs).color);
          addFills(table.fills);
          for (const paint of list(rec(o.decor).paints)) {
            const d = rec(paint);
            add(d.fill);
            addGradient(d.gradient);
            add(rec(d.stroke).color);
          }
          addFills(rec(o.chart).fills);
        }
      }
  const used = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first).map((x) => x.color);
  const deck: Rgba[] = [];
  if (theme && isRgba(theme.text?.color)) deck.push(theme.text.color);
  for (const c of used) {
    if (deck.length >= DECK_SWATCHES) break;
    if (!deck.some((d) => sameColor(d, c))) deck.push(c);
  }
  const out: ColorSwatch[] = deck.map((color, i) => ({
    color,
    name: `${i === 0 && theme ? 'Theme colour' : 'Deck colour'} ${rgbaHex(color)}`,
  }));
  for (const s of STANDARD_COLORS) if (!deck.some((d) => sameColor(d, s.color))) out.push(s);
  return out;
}

/** The deck a paint picker offers the colours of, and its theme (DeckSwatchesSource). */
export type SwatchSource = { presentation?: Presentation; theme?: Theme };

/**
 * Where a paint picker finds the deck it is editing: the editor provides it (views/editor/EditorView), so
 * this shared component never imports the editor's store (the editor route can be loaded on its own). With
 * no provider, a picker offers the curated defaults.
 */
export const DeckSwatchesSource = createContext<SwatchSource | undefined>(undefined);

/** The swatches a picker shows: up to 8, the deck's own first (`deckColors`), then the curated defaults. */
export function pickerSwatches(src: SwatchSource | undefined): readonly ColorSwatch[] {
  if (!src?.presentation) return DEFAULT_SWATCHES;
  const live = deckColors(src.presentation, src.theme);
  const merged: ColorSwatch[] = [];
  for (const item of [...live.slice(0, DECK_SWATCHES), ...DEFAULT_SWATCHES]) {
    if (merged.length >= 8) break;
    if (!merged.some((m) => sameColor(m.color, item.color))) merged.push(item);
  }
  return merged.length > 0 ? merged : DEFAULT_SWATCHES;
}

/**
 * Hook returning up to 8 live `Deck & Theme Swatches` when editing a presentation (the `DeckSwatchesSource`
 * the editor provides), else the curated `DEFAULT_SWATCHES`; `explicit` swatches win.
 */
export function useDeckSwatches(explicit?: readonly ColorSwatch[]): readonly ColorSwatch[] {
  const src = useContext(DeckSwatchesSource);
  return useMemo(() => explicit ?? pickerSwatches(src), [explicit, src]);
}
