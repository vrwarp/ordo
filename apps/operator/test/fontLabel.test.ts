/**
 * The font select's accessible name (r24 b10; design/15 "Floating bar", "Typography"): "Font" wherever a
 * FontPicker is shown (the floating bar, the Typography card, the text style editor, the Themes tab), and
 * "Font (mixed)" while the selected text has several fonts, when the select shows "Mixed" instead of one of
 * them. Server-rendered markup; the floating bar is checked in the browser (e2e/editor-fit.spec.ts).
 */
import { DEFAULT_THEME, type TextObject } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FontPicker, fontLabel } from '../src/components/FontPicker.tsx';
import { TextStyleEditor } from '../src/components/TextStyleEditor.tsx';
import { UnifiedTypography } from '../src/views/editor/UnifiedTypography.tsx';

const noop = () => undefined;
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
/** The names of the font selects (those with the Google Fonts option) in the markup. */
const fontSelects = (h: string) =>
  [...h.matchAll(/<select[^>]*aria-label="([^"]*)"[^>]*>((?:(?!<\/select>).)*)<\/select>/g)]
    .filter((m) => m[2]!.includes('value="__google"'))
    .map((m) => m[1]);

describe('FontPicker: the select is named', () => {
  it('Font by default, its label when given, with (mixed) for a mixed selection', () => {
    expect(fontLabel('Font', false)).toBe('Font');
    expect(fontLabel('Font', true)).toBe('Font (mixed)');
    expect(fontSelects(html(createElement(FontPicker, { value: 'Inter', onChange: noop })))).toEqual([
      'Font',
    ]);
    expect(
      fontSelects(html(createElement(FontPicker, { value: 'Inter', onChange: noop, label: 'Heading font' }))),
    ).toEqual(['Heading font']);
  });

  it('shows Mixed (not one of the fonts) for a mixed selection, and no missing-font warning', () => {
    const h = html(
      createElement(FontPicker, { value: 'Not On Hub', onChange: noop, compact: true, mixed: true }),
    );
    expect(fontSelects(h)).toEqual(['Font (mixed)']);
    expect(h).toMatch(/<option value="" disabled="" selected="">Mixed<\/option>/);
    expect(h).not.toContain('Not on the hub');
    const one = html(createElement(FontPicker, { value: 'Not On Hub', onChange: noop, compact: true }));
    expect(one).not.toContain('>Mixed<');
    expect(one).toMatch(/<option value="Not On Hub"[^>]*selected=""/);
    expect(one).toContain('Not on the hub');
  });
});

describe('the text surfaces name their font select', () => {
  const o: TextObject = {
    id: 't1',
    type: 'text',
    box: { x: 0, y: 0, w: 800, h: 200, rotation: 0 },
    text: 'Potluck lunch',
    style: { ...DEFAULT_THEME.textBoxDefaults, fontFamily: 'Inter' },
    runs: [{ start: 0, end: 7, fontFamily: 'Georgia' }],
    opacity: 1,
  };

  it('the Typography card: Font for the box or one font, Font (mixed) over two', () => {
    const card = (start: number, end: number) =>
      fontSelects(
        html(
          createElement(UnifiedTypography, {
            o,
            range: { start, end },
            readOnly: false,
            onChangeStyle: noop,
          }),
        ),
      );
    expect(card(0, 0)).toEqual(['Font']);
    expect(card(0, 7)).toEqual(['Font']);
    expect(card(0, 13)).toEqual(['Font (mixed)']);
  });

  it('the text style editor (themes, a box style)', () => {
    expect(fontSelects(html(createElement(TextStyleEditor, { value: o.style, onChange: noop })))).toEqual([
      'Font',
    ]);
  });
});
