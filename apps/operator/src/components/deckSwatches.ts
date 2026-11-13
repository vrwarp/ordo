import { hexToRgba, type Presentation, type Rgba, rgbaHex, type Theme } from '@ordo/domain';
import { useMemo } from 'react';
import { useLibrary } from '../state/library.ts';
import { useEditor } from '../views/editor/editorStore.ts';
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

const sameColor = (a: Rgba | undefined, b: Rgba | undefined) =>
  !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
const colorKey = (c: Rgba) => `${c.r},${c.g},${c.b},${c.a}`;

/**
 * Live presentation & theme swatches: the applied theme's text colour first, then the most-used text,
 * run, and shape fill colours in the deck (at most `DECK_SWATCHES`), followed by standard colours.
 */
export function deckColors(p: Presentation | undefined, theme?: Theme): ColorSwatch[] {
  const counts = new Map<string, { color: Rgba; n: number; first: number }>();
  let order = 0;
  const add = (c: Rgba | undefined, weight = 1) => {
    if (!c) return;
    const k = colorKey(c);
    const hit = counts.get(k);
    if (hit) hit.n += weight;
    else counts.set(k, { color: c, n: weight, first: order++ });
  };
  for (const sec of p?.sections ?? [])
    for (const s of sec.slides)
      for (const o of s.objects) {
        if (o.type === 'text') {
          add(o.style.color);
          for (const r of o.runs ?? []) add(r.color);
        } else if (o.type === 'shape') add(o.fill);
      }
  const used = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first).map((x) => x.color);
  const deck: Rgba[] = [];
  if (theme) deck.push(theme.text.color);
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

/**
 * Hook returning up to 8 live `Deck & Theme Swatches` when editing a presentation (falling back to
 * curated `DEFAULT_SWATCHES` outside the editor).
 */
export function useDeckSwatches(explicit?: readonly ColorSwatch[]): readonly ColorSwatch[] {
  const draft = useEditor((s) => s.draft);
  const themes = useLibrary((s) => s.data.themes);
  return useMemo(() => {
    if (explicit) return explicit;
    if (!draft) return DEFAULT_SWATCHES;
    const theme = draft.themeId ? themes.find((t) => t.id === draft.themeId) : undefined;
    const live = deckColors(draft, theme);
    const merged: ColorSwatch[] = [];
    for (const item of [...live.slice(0, DECK_SWATCHES), ...DEFAULT_SWATCHES]) {
      if (merged.length >= 8) break;
      if (!merged.some((m) => sameColor(m.color, item.color))) merged.push(item);
    }
    return merged.length > 0 ? merged : DEFAULT_SWATCHES;
  }, [explicit, draft, themes]);
}
