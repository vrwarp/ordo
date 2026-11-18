import { describe, expect, it } from 'vitest';
import { canonicalJson } from './palette.ts';
import type { Slide, SlideObject } from './schemas.ts';
import { sha256Text } from './sha256.ts';
import { utf8Bytes } from './size.ts';
import {
  SLIDE_FILE_LIMITS,
  SlideFileHead,
  SlideFilePage,
  SlideFileRefusal,
  slideFileName,
  slideFileOf,
  slideFromFile,
} from './slidefile.ts';

/*
 * design/29 §1.2 "The slide file": a head and pages of at most 256 KiB or 500 objects, each named by the
 * SHA-256 of its canonical JSON, so no reader parses a large slide at once and a save uploads only what
 * changed.
 */

function rect(i: number, extra: Record<string, unknown> = {}): SlideObject {
  return {
    id: `o${i}`,
    type: 'shape',
    box: { x: i % 1900, y: (i * 7) % 1000, w: 10, h: 10, rotation: 0 },
    shape: 'rect',
    fill: { r: i % 256, g: 0, b: 0, a: 1 },
    opacity: 1,
    radius: 0,
    ...extra,
  } as SlideObject;
}

function bigSlide(n: number): Slide {
  return {
    id: 'big',
    objects: Array.from({ length: n }, (_, i) => rect(i)),
    lyricObjectId: 'o3',
    notes: 'not in the file',
  };
}

describe('slide files (design/29 §1.2)', () => {
  it('stores a 2,000-object slide as 4 pages and a head that names them in order', () => {
    const file = slideFileOf(bigSlide(2000));
    expect(file.pages).toHaveLength(4);
    expect(file.pages.map((p) => p.page.objects.length)).toEqual([500, 500, 500, 500]);
    expect(file.head).toEqual({
      v: 1,
      pages: file.pages.map((p) => p.name),
      count: 2000,
      lyricObjectId: 'o3',
    });
    // Each part is named by the SHA-256 of its canonical JSON, and parses as stored.
    for (const p of file.pages) {
      expect(p.name).toBe(sha256Text(canonicalJson(p.page)));
      expect(p.bytes).toBe(utf8Bytes(canonicalJson(p.page)));
      expect(SlideFilePage.safeParse(p.page).success).toBe(true);
    }
    expect(file.name).toBe(slideFileName(file.head));
    expect(SlideFileHead.safeParse(file.head).success).toBe(true);
    expect(file.bytes).toBe(file.pages.reduce((a, p) => a + p.bytes, utf8Bytes(canonicalJson(file.head))));
    // Nothing the slide does not draw is in the file.
    expect(JSON.stringify(file)).not.toContain('not in the file');
  });

  it('gives back the full slide from its stand-in, head and pages', () => {
    const full = bigSlide(1234);
    const file = slideFileOf(full);
    const standIn: Slide = { ...full, objects: full.objects.slice(0, 3) };
    const back = slideFromFile(
      standIn,
      file.head,
      file.pages.map((p) => p.page),
    );
    expect(back.objects).toEqual(full.objects);
    expect(back.notes).toBe('not in the file');
    expect(back.lyricObjectId).toBe('o3');
    // Pages out of order or missing are refused, never stitched.
    const pages = file.pages.map((p) => p.page);
    expect(() => slideFromFile(standIn, file.head, pages.slice(1))).toThrow(SlideFileRefusal);
    expect(() => slideFromFile(standIn, { ...file.head, count: 1235 }, pages)).toThrow(SlideFileRefusal);
  });

  it('changes one page and the head when one object changes', () => {
    const a = slideFileOf(bigSlide(2000));
    const changed = bigSlide(2000);
    changed.objects[1234] = rect(1234, { fill: { r: 1, g: 2, b: 3, a: 1 } });
    const b = slideFileOf(changed);
    const differs = a.pages.map((p, i) => p.name !== b.pages[i]!.name);
    expect(differs).toEqual([false, false, true, false]);
    expect(b.name).not.toBe(a.name);
    // Key order does not change a name: the JSON is canonical.
    const reordered = bigSlide(2000);
    reordered.objects = reordered.objects.map(
      (o) => Object.fromEntries(Object.entries(o).reverse()) as SlideObject,
    );
    expect(slideFileOf(reordered).name).toBe(a.name);
  });

  it('closes a page at 256 KiB before 500 objects', () => {
    // About 20 KB an object: a page takes 12 of them.
    const fat = (i: number) =>
      ({
        id: `t${i}`,
        type: 'text',
        box: { x: 0, y: 0, w: 100, h: 100, rotation: 0 },
        text: 'x'.repeat(20_000),
        style: {
          fontFamily: 'Inter',
          fontWeight: 400,
          fontStyle: 'normal',
          fontSizePx: 20,
          color: { r: 0, g: 0, b: 0, a: 1 },
          align: 'left',
          valign: 'top',
          lineHeight: 1.2,
          letterSpacing: 0,
        },
        opacity: 1,
      }) as SlideObject;
    const file = slideFileOf({ id: 's', objects: Array.from({ length: 40 }, (_, i) => fat(i)) });
    for (const p of file.pages) expect(p.bytes).toBeLessThanOrEqual(SLIDE_FILE_LIMITS.pageBytes);
    expect(file.pages.length).toBeGreaterThan(1);
    expect(file.pages.reduce((a, p) => a + p.page.objects.length, 0)).toBe(40);
  });

  it('refuses a page over 256 KiB or 500 objects, and a head past its bounds', () => {
    expect(
      SlideFilePage.safeParse({ v: 1, objects: Array.from({ length: 500 }, (_, i) => rect(i)) }).success,
    ).toBe(true);
    expect(
      SlideFilePage.safeParse({ v: 1, objects: Array.from({ length: 501 }, (_, i) => rect(i)) }).success,
    ).toBe(false);
    const wide = (i: number) => rect(i, { origin: { src: 'pptx', ph: 'x'.repeat(40) } });
    const heavy = { v: 1, objects: Array.from({ length: 500 }, (_, i) => wide(i)) };
    // 500 objects of about 600 bytes pass; the same page with notes-sized text in each object does not.
    expect(SlideFilePage.safeParse(heavy).success).toBe(true);
    const tooHeavy = {
      v: 1,
      objects: Array.from({ length: 30 }, (_, i) => ({
        ...rect(i),
        type: 'text',
        text: 'y'.repeat(10_000),
        style: {
          fontFamily: 'Inter',
          fontWeight: 400,
          fontStyle: 'normal',
          fontSizePx: 20,
          color: { r: 0, g: 0, b: 0, a: 1 },
          align: 'left',
          valign: 'top',
          lineHeight: 1.2,
          letterSpacing: 0,
        },
      })),
    };
    expect(utf8Bytes(JSON.stringify(tooHeavy))).toBeGreaterThan(SLIDE_FILE_LIMITS.pageBytes);
    expect(SlideFilePage.safeParse(tooHeavy).success).toBe(false);
    expect(SlideFilePage.safeParse({ v: 2, objects: [] }).success).toBe(false);
    expect(SlideFileHead.safeParse({ v: 1, pages: ['a'.repeat(64)], count: 20_001 }).success).toBe(false);
    expect(SlideFileHead.safeParse({ v: 1, pages: ['not-a-hash'], count: 1 }).success).toBe(false);
    expect(
      SlideFileHead.safeParse({
        v: 1,
        pages: Array(SLIDE_FILE_LIMITS.pages + 1).fill('a'.repeat(64)),
        count: 1,
      }).success,
    ).toBe(false);
  });

  it('refuses a slide past 20,000 objects or 16 MiB, or with an object no page can hold', () => {
    expect(() => slideFileOf(bigSlide(20_001))).toThrow(SlideFileRefusal);
    expect(slideFileOf(bigSlide(20_000)).head.count).toBe(20_000);
    const huge = rect(0, { origin: { src: 'pptx', ph: 'z'.repeat(40) } }) as Record<string, unknown>;
    huge.decorBlob = 'w'.repeat(300 * 1024);
    expect(() => slideFileOf({ id: 's', objects: [huge as unknown as SlideObject] })).toThrow(
      SlideFileRefusal,
    );
    // 70 objects of 250 KB each: every page fits, the slide (17.5 MB) does not.
    const blob = 'v'.repeat(250_000);
    const many = Array.from(
      { length: 70 },
      (_, i) => ({ ...rect(i), decorBlob: blob }) as unknown as SlideObject,
    );
    expect(() => slideFileOf({ id: 's', objects: many })).toThrow(/16 MiB/);
    expect(slideFileOf({ id: 's', objects: many.slice(0, 60) }).pages).toHaveLength(60);
  });
});
