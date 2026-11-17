import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LYRIC_STYLE, type TextObject, type TextStyle } from '@ordo/domain';
import { LEGACY_FONT_ENV } from './fonts.ts';
import { clampTextObject, layoutRich } from './rich.ts';
import { type FaceMetrics, sfntMetrics } from './sfnt/reader.ts';
import type { Measurer, RichLayout } from './types.ts';

/*
 * Office text keeps the kerning across a break only the office rules make (LibreOffice's 'John 3:16-' / '17',
 * breaks.ts): the pieces are cut there, but on one line they are placed as the whole string is shaped. Measured
 * with Inter, ordo's bundled default face (fonts-inter), which LibreOffice also draws a deck's unknown family
 * in (El Calendario de Dios p11, 'Hebreos 9:23-28' at 87 pt): its '-2' pair kerns by -0.0337 em, 5.9 px at
 * 174 px, which the cut lost (the line drawn 3 px left of LibreOffice's when centred).
 *
 * The measurer reads the face's advances and pair kerning (sfnt/reader.ts, as HarfBuzz applies them in
 * Chromium's `measureText`): a string's width is its advances plus the kerning between its neighbours, so it
 * measures 'x-2' kerned and 'x-' and '2' apart unkerned, as Chromium does (the kerned 'Hebreos 9:23-' + '28'
 * drawn apart at the whole string's advance less its own is pixel-identical to the whole string in Chromium
 * with Inter: integrate-1b text-falls notes).
 */

const INTER = '/usr/share/fonts/opentype/inter/Inter-Regular.otf';
const face: FaceMetrics | undefined = existsSync(INTER)
  ? sfntMetrics(new Uint8Array(readFileSync(INTER)))
  : undefined;

/** Widths from the face: advances and pair kerning × the font string's px size, letter spacing between. */
function faceMeasurer(f: FaceMetrics): Measurer {
  return {
    width(font, _dir, _lang, spacingPx, text) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 16);
      let w = 0;
      let n = 0;
      let prev = -1;
      for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        w += (f.advance(cp) ?? 0.5) * size;
        if (prev >= 0) w += (f.kern?.(prev, cp) ?? 0) * size;
        prev = cp;
        n++;
      }
      return n ? w + spacingPx * (n - 1) : 0;
    },
  };
}

function obj(text: string, w: number, style: Partial<TextStyle> = {}): TextObject {
  return clampTextObject({
    id: 't',
    type: 'text',
    box: { x: 0, y: 0, w, h: 400, rotation: 0 },
    text,
    style: {
      ...DEFAULT_LYRIC_STYLE,
      padding: 0,
      fontSizePx: 174,
      lineHeight: 1.2,
      lang: 'es',
      lineModel: 'office',
      align: 'center',
      ...style,
    },
    opacity: 1,
  });
}

const lineTexts = (o: TextObject, l: RichLayout) =>
  l.lines.map((line) => line.segs.map((s) => o.text.slice(s.start, s.end)).join(''));

describe.skipIf(!face)('office breaks keep the kerning across them (Inter, the bundled default face)', () => {
  const m = () => faceMeasurer(face!);
  const font = (o: TextObject) => layoutRich(m(), o, LEGACY_FONT_ENV).lines[0]!.segs[0]!.font;
  const width = (o: TextObject, s: string) => m().width(font(o), 'ltr', 'es', 0, s);

  it("places 'Hebreos 9:23-28' on one line as the whole string is shaped", () => {
    const o = obj('Hebreos 9:23-28', 1900);
    const l = layoutRich(m(), o, LEGACY_FONT_ENV);
    expect(lineTexts(o, l)).toEqual(['Hebreos 9:23-28']);
    const whole = width(o, 'Hebreos 9:23-28');
    // The pair is kerned in this face: apart, '23-' and '28' are 5.9 px wider than the whole string.
    expect(width(o, 'Hebreos 9:23-') + width(o, '28') - whole).toBeCloseTo(0.0337 * 174, 1);
    const line = l.lines[0]!;
    // The line is as wide as the whole string, so it is centred where the whole string is (and LibreOffice's).
    expect(line.w).toBeCloseTo(whole, 6);
    expect(line.x).toBeCloseTo((1900 - whole) / 2, 6);
    // '28' starts where the whole string draws it: its advance less the advance of '28'.
    const last = line.segs[line.segs.length - 1]!;
    expect(o.text.slice(last.start, last.end)).toBe('28');
    expect(last.x - line.x).toBeCloseTo(whole - width(o, '28'), 6);
  });

  it('fits a line as wide as the kerned string, and still breaks after the hyphen where the line ends', () => {
    const fits = obj('Hebreos 9:23-28', 0);
    const whole = width(fits, 'Hebreos 9:23-28');
    // A box 1 px wider than the kerned string holds it on one line (apart, the pieces are 5.9 px wider).
    const one = obj('Hebreos 9:23-28', whole + 1);
    expect(lineTexts(one, layoutRich(m(), one, LEGACY_FONT_ENV))).toEqual(['Hebreos 9:23-28']);
    // Narrower, the line ends after the hyphen (LibreOffice's break), as wide as 'Hebreos 9:23-' alone.
    const two = obj('Hebreos 9:23-28', whole - 20);
    const l = layoutRich(m(), two, LEGACY_FONT_ENV);
    expect(lineTexts(two, l)).toEqual(['Hebreos 9:23-', '28']);
    expect(l.lines[0]!.w).toBeCloseTo(width(two, 'Hebreos 9:23-'), 6);
    expect(l.lines[1]!.w).toBeCloseTo(width(two, '28'), 6);
  });

  it('kerns only inside one run, and leaves ordo text, which has no break there, whole as before', () => {
    // '28' in a run of its own: no kerning across a style change (each run is shaped apart).
    const runs = obj('Hebreos 9:23-28', 1900);
    const cut = clampTextObject({ ...runs, runs: [{ start: 13, end: 15, fontWeight: 700 }] });
    const lc = layoutRich(m(), cut, LEGACY_FONT_ENV).lines[0]!;
    const tail = lc.segs[lc.segs.length - 1]!;
    expect(cut.text.slice(tail.start, tail.end)).toBe('28');
    expect(tail.x - lc.x).toBeCloseTo(width(cut, 'Hebreos 9:23-'), 6);
    // Ordo's own text has no break there (UAX#14): '9:23-28' is one piece, measured whole, as before.
    const ordo = obj('Hebreos 9:23-28', 1900, { lineModel: undefined });
    const l = layoutRich(m(), ordo, LEGACY_FONT_ENV).lines[0]!;
    expect(l.segs.map((s) => ordo.text.slice(s.start, s.end))).toEqual(['Hebreos ', '9:23-28']);
    expect(l.w).toBeCloseTo(width(ordo, 'Hebreos ') + width(ordo, '9:23-28'), 6);
  });
});
