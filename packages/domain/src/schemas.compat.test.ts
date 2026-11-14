import { describe, expect, it } from 'vitest';
import { m9Slide } from './m9.test-util.ts';
import { richSlide, richText } from './rich.test-util.ts';
import { PlaylistItem, Slide, TextObject } from './schemas.ts';
import * as prev from './schemas.prev.test-util.ts';

/**
 * Schema growth is additive (design/27 Decision 9, §3.2, §14.7): the previous release's schema parses
 * slides with the new fields, stripping them, and enums inside new fields degrade instead of failing. The
 * previous release is main's 0.5.0 (`schemas.prev.test-util.ts`), which already has M2's rich text: it keeps
 * every rich field, so a venue on 0.5.0 saves a rich slide back unchanged. M9's own fields are checked in
 * schemas.m9.test.ts.
 */

describe('schema compatibility (design/27 §14.7)', () => {
  it('the current schema keeps every new field', () => {
    const s = richSlide();
    expect(Slide.parse(s)).toEqual(s);
  });

  it('the previous release (0.5.0) parses a rich slide and keeps every rich field', () => {
    const s = richSlide();
    const r = prev.Slide.safeParse(s);
    expect(r.success).toBe(true);
    const old = r.data!;
    expect(old).toEqual(Slide.parse(s));
    expect(old.objects.map((o) => o.type)).toEqual(['shape', 'image', 'text']);
    const t = old.objects[2] as prev.TextObject;
    // The legacy values beside the rich ones are still written (an earlier build would draw them).
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

describe('the previous release (main 0.5.0) and an M9 slide', () => {
  /** An M9 slide carrying the fields 0.5.0 added: strap text, MIDI cues, a line mask, picture effects. */
  function withReleaseFields(): Slide {
    const s = Slide.parse(m9Slide());
    s.bottomThirdText = 'Amazing grace';
    s.midiCues = [{ id: 'cue', channel: 2, type: 'programChange', number: 5, value: 127 }];
    const title = s.objects.find((o) => o.id === 'title') as TextObject;
    title.style.lineMask = { style: 'lineWidth', fill: { r: 0, g: 0, b: 0, a: 0.6 } };
    const emf = s.objects.find((o) => o.id === 'emf')!;
    if (emf.type !== 'image') throw new Error('emf is a picture');
    emf.shadow = { dx: 4, dy: 6, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.5 } };
    emf.softEdge = 8;
    return Slide.parse(s);
  }

  it('keeps midiCues, bottomThirdText, a line mask and picture shadow and soft edge, and strips M9', () => {
    const s = withReleaseFields();
    const old = prev.Slide.parse(s) as unknown as Slide;
    expect(old.bottomThirdText).toBe('Amazing grace');
    expect(old.midiCues).toEqual(s.midiCues);
    const title = old.objects.find((o) => o.id === 'title') as TextObject;
    expect(title.style.lineMask).toEqual({ style: 'lineWidth', fill: { r: 0, g: 0, b: 0, a: 0.6 } });
    expect(title).not.toHaveProperty('warp');
    const emf = old.objects.find((o) => o.id === 'emf')!;
    expect(emf).toMatchObject({ shadow: { blur: 12 }, softEdge: 8 });
    expect(emf).not.toHaveProperty('vectorFonts');
    expect(old.objects.some((o) => 'table' in o || 'chart' in o || 'decor' in o || 'look3d' in o)).toBe(
      false,
    );
    // What 0.5.0 saves back parses here, and keeps those fields.
    expect(Slide.parse(old)).toMatchObject({ bottomThirdText: 'Amazing grace', midiCues: s.midiCues });
  });

  it("keeps a playlist item's keepBackground, audioMediaId and countdownTimer", () => {
    const item = PlaylistItem.parse({
      id: 'i',
      kind: 'presentation',
      presentationId: 'p',
      keepBackground: true,
      audioMediaId: 'music',
      countdownTimer: { kind: 'countdownTo', timeOfDay: '10:30', label: 'Service starts' },
    });
    expect(prev.PlaylistItem.parse(item)).toEqual(item);
  });
});
