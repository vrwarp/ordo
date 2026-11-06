import { describe, expect, it } from 'vitest';
import { richSlide, richText } from './rich.test-util.ts';
import { Slide, TextObject } from './schemas.ts';
import * as prev from './schemas.prev.test-util.ts';

/**
 * Schema growth is additive (design/27 Decision 9, §3.2, §14.7): the previous release's schema parses
 * slides with the new fields, stripping them, and enums inside new fields degrade instead of failing.
 */

const NEW_TEXT_KEYS = ['runs', 'paras', 'origin', 'locked'];
const NEW_STYLE_KEYS = [
  'lineModel',
  'insets',
  'wrap',
  'autofit',
  'fitScale',
  'justify',
  'direction',
  'lang',
  'fallbackFonts',
  'underline',
  'glow',
];

describe('schema compatibility (design/27 §14.7)', () => {
  it('the current schema keeps every new field', () => {
    const s = richSlide();
    expect(Slide.parse(s)).toEqual(s);
  });

  it('the previous release parses a new slide, stripped to the legacy values', () => {
    const s = richSlide();
    const r = prev.Slide.safeParse(s);
    expect(r.success).toBe(true);
    const old = r.data!;
    expect(old.objects.map((o) => o.type)).toEqual(['shape', 'image', 'text']);
    for (const o of old.objects) {
      for (const k of NEW_TEXT_KEYS) expect(o).not.toHaveProperty(k);
    }
    const t = old.objects[2] as prev.TextObject;
    for (const k of NEW_STYLE_KEYS) expect(t.style).not.toHaveProperty(k);
    const rich = richText();
    expect(t.text).toBe(rich.text);
    expect(t.style.fontFamily).toBe(rich.style.fontFamily);
    expect(t.style.fontSizePx).toBe(rich.style.fontSizePx);
    expect(old.lyricObjectId).toBe('body');
    // What an older build saves back is valid for the current schema too.
    expect(Slide.safeParse(old).success).toBe(true);
  });

  it('enums inside new fields degrade to their defaults', () => {
    const t = richText();
    const odd = {
      ...t,
      style: { ...t.style, lineModel: 'vertical', autofit: 'grow', direction: 'ttb' },
      runs: [{ start: 0, end: 2, fontStyle: 'oblique', caps: 'title' }],
      paras: [{ align: 'thaiDist' }, null],
    };
    const r = TextObject.safeParse(odd);
    expect(r.success).toBe(true);
    expect(r.data!.style).toMatchObject({ lineModel: 'ordo', autofit: 'none', direction: 'auto' });
    expect(r.data!.runs![0]).toMatchObject({ fontStyle: 'normal', caps: 'none' });
    expect(r.data!.paras).toEqual([{ align: 'left' }, null]);
  });

  it('refuses unbounded rich data at the boundary', () => {
    const t = richText();
    const run = { start: 0, end: 1 };
    expect(TextObject.safeParse({ ...t, runs: Array(2001).fill(run) }).success).toBe(false);
    expect(TextObject.safeParse({ ...t, paras: Array(5001).fill(null) }).success).toBe(false);
    expect(TextObject.safeParse({ ...t, runs: [{ start: 0, end: 30_000 }] }).success).toBe(false);
    expect(
      TextObject.safeParse({ ...t, style: { ...t.style, fallbackFonts: Array(9).fill('A') } }).success,
    ).toBe(false);
  });
});
