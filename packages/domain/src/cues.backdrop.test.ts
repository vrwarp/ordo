import { describe, expect, it } from 'vitest';
import { isBackdrop, withoutBackdropObjects, withoutBackdrops } from './content.ts';
import { expandCues } from './cues.ts';
import type { Playlist, Presentation, Slide, SlideObject } from './schemas.ts';

/**
 * A playlist item's Background override over slides imported on a colour (`Cue.backgroundOverride`,
 * `withoutBackdrops`): a ProPresenter song's presentation background or a slide's own colour, a PowerPoint
 * slide's solid fill, all drawn as the slide's bottom `role: 'bg'` shape, never hide the override.
 */

const box = { x: 0, y: 0, w: 1920, h: 1080, rotation: 0 };
const backdrop = (id: string, src = 'pro7', extra: Record<string, unknown> = {}): SlideObject =>
  ({
    id,
    type: 'shape',
    box,
    shape: 'rect',
    fill: { r: 20, g: 40, b: 120, a: 1 },
    opacity: 1,
    radius: 0,
    origin: { src, role: 'bg' },
    ...extra,
  }) as SlideObject;
const text = (id: string): SlideObject =>
  ({ id, type: 'text', box, text: 'Holy', style: { fontFamily: 'Inter', fontSizePx: 40 } }) as SlideObject;
const slide = (id: string, objects: SlideObject[], over: Partial<Slide> = {}): Slide => ({
  id,
  objects,
  ...over,
});
const song = (slides: Slide[], over: Partial<Presentation> = {}): Presentation => ({
  id: 'p',
  rev: 1,
  title: 'Holy',
  kind: 'song',
  meta: { tags: [] },
  sections: [{ id: 'v', label: 'Verse', short: 'V', slides }],
  arrangements: [],
  archived: false,
  ...over,
});
const playlist = (bg?: string): Playlist => ({
  id: 'pl',
  rev: 1,
  name: 'Sunday',
  items: [{ id: 'i1', kind: 'presentation', presentationId: 'p', ...(bg ? { backgroundMediaId: bg } : {}) }],
});
const cuesOf = (p: Presentation, bg?: string) =>
  expandCues({ playlist: playlist(bg), presentations: { p }, media: {} });

describe('backdrops under a Background override', () => {
  it('marks the cues whose background is the item override', () => {
    const p = song([
      slide('s1', [backdrop('b1'), text('t1')]),
      slide('s2', [backdrop('b2'), text('t2')], { backgroundMediaId: 'own' }),
    ]);
    const [c1, c2] = cuesOf(p, 'sunday');
    expect(c1).toMatchObject({ backgroundMediaId: 'sunday', backgroundOverride: true });
    // A slide's own background picture wins over the override, as before: no override on its cue.
    expect(c2!.backgroundMediaId).toBe('own');
    expect(c2!.backgroundOverride).toBeUndefined();
    // Without an override nothing changes.
    for (const c of cuesOf(p)) expect(c.backgroundOverride).toBeUndefined();
    // Nor with the presentation's own background and no override.
    expect(cuesOf({ ...p, backgroundMediaId: 'deck' })[0]!.backgroundOverride).toBeUndefined();
  });

  it('leaves out only the unlocked role bg shapes at the bottom, once per slide object', () => {
    const s = slide('s', [backdrop('b1'), backdrop('b2', 'pptx'), text('t'), backdrop('top')]);
    const out = withoutBackdrops(s);
    expect(out.objects.map((o) => o.id)).toEqual(['t', 'top']);
    expect(withoutBackdrops(s)).toBe(out);
    const plain = slide('p', [text('t')]);
    expect(withoutBackdrops(plain)).toBe(plain);
    // A locked shape, a picture and an operator's own shape are not backdrops.
    expect(isBackdrop(backdrop('l', 'pro7', { locked: true }))).toBe(false);
    expect(isBackdrop({ ...backdrop('i'), type: 'image' })).toBe(false);
    expect(isBackdrop({ ...backdrop('o'), origin: undefined })).toBe(false);
    const objects = [text('t')];
    expect(withoutBackdropObjects(objects)).toBe(objects);
    // Defensive on what an older or hostile document holds.
    expect(withoutBackdrops({ objects: undefined } as unknown as Slide).objects).toBeUndefined();
    expect(isBackdrop(null)).toBe(false);
  });
});
