import { DEFAULT_LYRIC_STYLE, type Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { planLadder } from './ladder.ts';

/**
 * The presentation's tail (design/27 §3.4, M9 `ladder`): stored minimal, each slide keeping its page (the
 * background drawn as a shape, origin role 'bg') as its background colour, so the tail's dark text is never
 * drawn on the output's black; a deck that does not fit 4 MiB even so leaves the pages out before any text is
 * cut.
 */

const id = (n: number, k: string) => `${k}${String(n).padStart(25, '0')}`;

/** A traced outline of about `chars` characters of path data. */
function traced(chars: number): string {
  let d = 'M 0 0';
  for (let i = 1; d.length < chars; i++) d += ` L ${(i * 7) % 1000} ${(i * 13) % 1000}`;
  return `${d} Z`;
}

/** An imported slide: a white page, `chars` of dark text and a decoration of about `deco` bytes. */
function slide(n: number, chars: number, deco = 200): Slide {
  return {
    id: id(n, 'S'),
    objects: [
      {
        id: id(n, 'P'),
        type: 'shape',
        box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
        shape: 'rect',
        fill: { r: 255, g: 255, b: 255, a: 1 },
        opacity: 1,
        radius: 0,
        origin: { src: 'pptx', role: 'bg' },
      },
      {
        id: id(n, 'T'),
        type: 'text',
        box: { x: 100, y: 100, w: 1720, h: 880, rotation: 0 },
        text: `${n} ${'Amazing grace, how sweet the sound. '.repeat(Math.ceil(chars / 36))}`.slice(0, chars),
        style: { ...DEFAULT_LYRIC_STYLE, color: { r: 20, g: 20, b: 20, a: 1 } },
        opacity: 1,
        origin: { src: 'pptx', role: 'body' },
      },
      {
        id: id(n, 'D'),
        type: 'shape',
        box: { x: 0, y: 1000, w: 1920, h: 80, rotation: 0 },
        shape: 'rect',
        fill: { r: 30, g: 60, b: 120, a: 1 },
        opacity: 1,
        radius: 0,
        geom: { paths: [{ d: traced(deco), w: 1000, h: 1000 }] },
        origin: { src: 'pptx', role: 'shape' },
      },
    ],
    lyricObjectId: id(n, 'T'),
  };
}

const roles = (s: Slide) => s.objects.map((o) => o.origin?.role);

describe('the presentation tail keeps each slide page', () => {
  it('stores the tail minimal with its page as a plain rect in its colour, the decoration left out', () => {
    // 300 slides of about 13 KB, most of it the decoration's outline: the running total passes 3 MiB near
    // slide 240; minimal, every slide is about 1.4 KB.
    const { slides, plan } = planLadder(
      Array.from({ length: 300 }, (_, i) => ({ slide: slide(i, 800, 12_000) })),
    );
    expect(plan.fits).toBe(true);
    expect(plan.tailFrom).toBeGreaterThan(100);
    const tail = slides.slice(plan.tailFrom);
    expect(tail.every((s) => s.tail)).toBe(true);
    for (const s of tail) {
      expect(roles(s.slide)).toEqual(['bg', 'body']);
      expect(s.slide.objects[0]).toMatchObject({
        type: 'shape',
        shape: 'rect',
        fill: { r: 255, g: 255, b: 255 },
      });
      expect(s.missing).toEqual(['decoration']);
    }
    for (const s of slides.slice(0, plan.tailFrom)) expect(roles(s.slide)).toEqual(['bg', 'body', 'shape']);
  });

  it('leaves the pages out of a deck that does not fit 4 MiB even minimal with them, before cutting text', () => {
    // 2,000 slides of about 1.8 KB minimal: with its 215-byte page each the deck passes 4 MiB less the
    // reserve, without it fits.
    const { slides, plan } = planLadder(Array.from({ length: 2000 }, (_, i) => ({ slide: slide(i, 1_200) })));
    expect(plan.fits).toBe(true);
    const tail = slides.slice(plan.tailFrom);
    expect(tail.length).toBeGreaterThan(0);
    for (const s of tail) expect(roles(s.slide)).toEqual(['body']);
  });
});
