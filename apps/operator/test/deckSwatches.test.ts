/**
 * The paint pickers' deck swatches (design/15 "Paint picker"; components/deckSwatches.ts): the colours an
 * imported deck paints with come first, including gradient stops and M9's palettes (table fills and run
 * styles, decoration paints, chart fills); the scan of an untrusted deck never throws and is bounded; and the
 * shared components read the deck from a context the editor provides, never from the editor's store (the
 * editor route can then be loaded on its own).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_THEME,
  type Gradient,
  type Presentation,
  type Rgba,
  type SlideObject,
  type TextObject,
  type Theme,
} from '@ordo/domain';
import fc from 'fast-check';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PaintPopover } from '../src/components/ColorPicker.tsx';
import { DEFAULT_SWATCHES } from '../src/components/colorMath.ts';
import {
  DECK_COLOR_READS,
  DECK_SWATCHES,
  DeckSwatchesSource,
  deckColors,
  pickerSwatches,
  STANDARD_COLORS,
  useDeckSwatches,
} from '../src/components/deckSwatches.ts';

const rgb = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });
const box = { x: 0, y: 0, w: 400, h: 200 };
const grad = (...colors: Rgba[]): Gradient => ({
  kind: 'linear',
  angle: 90,
  stops: colors.map((color, i) => ({ at: i / Math.max(1, colors.length - 1), color })),
});
const deck = (objects: SlideObject[]): Presentation => ({
  id: 'p',
  rev: 1,
  title: 'Deck',
  kind: 'slides',
  meta: { tags: [] },
  sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 's', objects }] }],
  arrangements: [],
  archived: false,
});
const text = (o: Partial<TextObject> = {}): TextObject => ({
  id: 't',
  type: 'text',
  box,
  text: 'Welcome',
  style: { ...DEFAULT_THEME.textBoxDefaults, color: rgb(250, 250, 250) },
  opacity: 1,
  ...o,
});
const shape = (o: Record<string, unknown>): SlideObject =>
  ({ id: 'sh', type: 'shape', box, shape: 'rect', opacity: 1, radius: 0, ...o }) as SlideObject;
const deckOnly = (p: Presentation, theme?: Theme) =>
  deckColors(p, theme)
    .filter((s) => !STANDARD_COLORS.includes(s))
    .map((s) => s.color);

describe('deckColors: the colours an imported deck paints with', () => {
  it('reads gradient stops of shapes and gradient text', () => {
    const teal = rgb(0, 128, 128);
    const plum = rgb(120, 40, 120);
    const gold = rgb(230, 180, 30);
    const p = deck([
      shape({ id: 'g', fill: teal, gradient: grad(teal, plum) }),
      text({ id: 'x', style: { ...DEFAULT_THEME.textBoxDefaults, color: gold, paint: grad(gold, plum) } }),
    ]);
    // plum: 2 stops; teal: fill + stop; gold: colour + stop.
    expect(deckOnly(p)).toEqual([teal, plum, gold]);
  });

  it("reads a table's text, run and fill colours, a decoration's paints and a chart's fills", () => {
    const tableText = rgb(10, 20, 30);
    const header = rgb(68, 114, 196);
    const band = rgb(217, 226, 243);
    const runRed = rgb(192, 0, 0);
    const decoFill = rgb(255, 192, 0);
    const decoLine = rgb(89, 89, 89);
    const decoStop = rgb(112, 48, 160);
    const bar = rgb(237, 125, 49);
    const p = deck([
      shape({
        id: 'tbl',
        table: {
          cols: [100, 100],
          rows: [40, 40],
          cells: [
            { text: 'a', fill: 0 },
            { text: 'b', fill: 1, runs: [[0, 1, 0]] },
          ],
          base: { ...DEFAULT_THEME.textBoxDefaults, color: tableText },
          styles: [{ color: header }],
          runStyles: [{ color: runRed }],
          fills: [{ color: header }, { color: band, gradient: grad(band, header) }],
        },
      }),
      shape({
        id: 'dec',
        decor: {
          w: 100,
          h: 100,
          paints: [
            { fill: decoFill, stroke: { width: 2, color: decoLine } },
            { gradient: grad(decoStop, decoFill) },
          ],
          parts: [],
        },
      }),
      shape({ id: 'ch', chart: { unit: 2, groups: [], fills: [{ color: bar }], lines: [], texts: [] } }),
    ]);
    const got = deckOnly(p);
    // header: style + fill + stop (3); band: fill + stop (2); decoFill: fill + stop (2); then one each.
    expect(got.slice(0, 3)).toEqual([header, band, decoFill]);
    expect(got).toHaveLength(DECK_SWATCHES);
    for (const c of [tableText, runRed, decoLine, decoStop, bar]) expect(got).toContainEqual(c);
  });

  it('puts the theme colour first and keeps at most DECK_SWATCHES of the deck', () => {
    const theme: Theme = { ...DEFAULT_THEME, text: { ...DEFAULT_THEME.text, color: rgb(1, 2, 3) } };
    const many = deck(
      Array.from({ length: 30 }, (_, i) =>
        shape({ id: `s${i}`, gradient: grad(rgb(i, 0, 0), rgb(0, i, 0)) }),
      ),
    );
    const sw = deckColors(many, theme);
    expect(sw[0]).toEqual({ color: rgb(1, 2, 3), name: 'Theme colour #010203' });
    expect(sw.filter((s) => s.name.startsWith('Deck colour'))).toHaveLength(DECK_SWATCHES - 1);
  });
});

describe('deckColors: an untrusted deck', () => {
  it('skips what is not a colour and never throws on half-built objects', () => {
    const hostile = {
      sections: [
        null,
        { slides: 'x' },
        {
          slides: [
            { objects: [null, 7, { type: 'text' }, { type: 'text', style: null, runs: 'r' }] },
            {
              objects: [
                { type: 'shape', fill: { r: Number.NaN, g: 0, b: 0, a: 1 }, gradient: { stops: [null, {}] } },
                {
                  type: 'shape',
                  table: { fills: [null, { color: 'red' }], runStyles: 3 },
                  decor: { paints: {} },
                },
                { type: 'shape', chart: { fills: [{ color: { r: 1, g: 2, b: 3, a: 1 } }] } },
              ],
            },
          ],
        },
      ],
    } as unknown as Presentation;
    expect(deckOnly(hostile)).toEqual([rgb(1, 2, 3)]);
    expect(deckColors({} as Presentation)).toEqual([...STANDARD_COLORS]);
  });

  it('stops after DECK_COLOR_READS colours, however large the deck', () => {
    const stops = Array.from({ length: 16 }, (_, i) => ({ at: i / 15, color: rgb(i, i, i) }));
    const objects = Array.from({ length: 20_000 }, (_, i) =>
      shape({ id: `s${i}`, gradient: { kind: 'linear', stops } }),
    );
    const t0 = performance.now();
    const sw = deckColors(deck(objects));
    const ms = performance.now() - t0;
    expect(sw.filter((s) => s.name.startsWith('Deck colour'))).toHaveLength(DECK_SWATCHES);
    expect(DECK_COLOR_READS).toBeLessThan(20_000 * 16);
    expect(ms).toBeLessThan(1_000 * (process.env.CI ? 3 : 1));
  });

  it('never throws on arbitrary JSON objects', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { maxLength: 30 }), (objects) => {
        const p = deck(objects as unknown as SlideObject[]);
        const sw = deckColors(p);
        expect(sw.length).toBeGreaterThanOrEqual(STANDARD_COLORS.length - DECK_SWATCHES);
      }),
      { numRuns: 300 },
    );
  });
});

/** A component showing the swatches `useDeckSwatches` gives it, by name. */
function Probe(props: { explicit?: typeof DEFAULT_SWATCHES }) {
  return createElement(
    'i',
    null,
    useDeckSwatches(props.explicit)
      .map((s) => s.name)
      .join('|'),
  );
}

describe('deck swatches in the paint picker', () => {
  const navy = rgb(31, 78, 121);
  const p = deck([text({ style: { ...DEFAULT_THEME.textBoxDefaults, color: navy } })]);

  it('offers the curated defaults with no deck, else the deck first (8 at most, no repeats)', () => {
    expect(pickerSwatches(undefined)).toBe(DEFAULT_SWATCHES);
    expect(pickerSwatches({})).toBe(DEFAULT_SWATCHES);
    const sw = pickerSwatches({ presentation: p });
    expect(sw[0]).toEqual({ color: navy, name: 'Deck colour #1f4e79' });
    expect(sw).toHaveLength(8);
    expect(new Set(sw.map((s) => `${s.color.r},${s.color.g},${s.color.b},${s.color.a}`)).size).toBe(8);
  });

  it('reads the deck from the context the editor provides (explicit swatches win)', () => {
    expect(renderToStaticMarkup(createElement(Probe))).toContain(DEFAULT_SWATCHES[0]!.name);
    const inEditor = renderToStaticMarkup(
      createElement(DeckSwatchesSource.Provider, { value: { presentation: p } }, createElement(Probe)),
    );
    expect(inEditor).toContain('Deck colour #1f4e79');
    const explicit = [{ color: navy, name: 'Only this' }];
    expect(
      renderToStaticMarkup(
        createElement(
          DeckSwatchesSource.Provider,
          { value: { presentation: p } },
          createElement(Probe, { explicit }),
        ),
      ),
    ).toBe('<i>Only this</i>');
    const popover = renderToStaticMarkup(
      createElement(
        DeckSwatchesSource.Provider,
        { value: { presentation: p } },
        createElement(PaintPopover, {
          inline: true,
          anchor: null,
          value: { kind: 'solid', color: navy },
          onChange: () => undefined,
          onClose: () => undefined,
        }),
      ),
    );
    expect(popover).toContain('aria-label="Deck colour #1f4e79"');
  });

  it('no shared component imports the editor (views/), so the editor route can be split off', () => {
    const dir = join(import.meta.dirname, '../src/components');
    const offenders = readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => /from ['"]\.\.\/views\//.test(readFileSync(join(dir, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
