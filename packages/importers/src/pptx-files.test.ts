import type { Slide, SlideObject } from '@ordo/domain';
import { DEFAULT_LYRIC_STYLE } from '@ordo/domain';
import { heavyForm } from '@ordo/domain/heavyform.ts';
import { TEXT_DRAWN_MAX } from '@ordo/domain/slidefile.ts';
import { describe, expect, it } from 'vitest';
import { IMPORT_LIMITS, sanitizeObject } from './sanitize.ts';

/*
 * The slide-file route's tests (import-files). PHASE A holds the pins of what the stand-in may keep: a text box of a
 * stand-in is at most what the import's sanitizer keeps of one (IMPORT_LIMITS.text), so a stand-in stored and
 * parsed again loses no word. PHASE B adds IF1-IF15 (the tier-2 routing of ImportCore) to this file.
 */
describe("the stand-in and the import's sanitizer (HF13, step 1)", () => {
  it('IF0 TEXT_DRAWN_MAX is what the import keeps of one text object', () => {
    expect(IMPORT_LIMITS.text).toBe(10_000);
    expect(TEXT_DRAWN_MAX).toBe(IMPORT_LIMITS.text);
  });

  it('IF0 a stand-in made by heavyForm passes the sanitizer with every box unchanged', () => {
    const box = { x: 0, y: 0, w: 400, h: 100, rotation: 0 };
    const objects: SlideObject[] = [
      {
        id: 'bg',
        type: 'shape',
        box: { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 },
        shape: 'rect',
        fill: { r: 1, g: 2, b: 3, a: 1 },
        opacity: 1,
        radius: 0,
        origin: { src: 'pptx', role: 'bg' },
      } as SlideObject,
      ...Array.from(
        { length: 250 },
        (_, i) =>
          ({
            id: `t${i}`,
            type: 'text',
            box,
            text: `${i}${'w'.repeat(267)}`,
            style: { ...DEFAULT_LYRIC_STYLE },
            opacity: 1,
          }) as SlideObject,
      ),
    ];
    const r = heavyForm({ id: 'big', objects } as Slide, { why: ['count'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const o of r.standIn.objects) {
      const kept = sanitizeObject(o);
      if (o.type === 'text') expect((kept as { text: string }).text).toBe(o.text);
    }
  });
});
