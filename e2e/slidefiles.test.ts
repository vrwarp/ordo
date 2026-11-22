import { describe, expect, it } from 'vitest';
import { Slide } from '../packages/domain/src/schemas.ts';
import { slideFromFile } from '../packages/domain/src/slidefile.ts';
import { slideFileOf, smallShapes } from './slidefiles.ts';

/** The fixture the specs of the detailed-slide tracks start from builds a file-form slide without a hub. */
describe('slideFileOf (the e2e fixture of a slide kept as a slide file)', () => {
  it('makes a stand-in that names its file, and a file that gives the whole slide back', () => {
    const fx = slideFileOf(1357);
    expect(fx.standIn.prerender?.file?.ref).toBe(fx.name);
    expect(Slide.safeParse(fx.standIn).success).toBe(true);
    expect(fx.standIn.objects.length).toBeLessThanOrEqual(200);
    const back = slideFromFile(
      fx.standIn,
      fx.file.head,
      fx.file.pages.map((p) => p.page),
    );
    expect(back.objects).toEqual(fx.full.objects);
    expect(fx.full.objects.filter((o) => o.id.startsWith('s'))).toHaveLength(1357);
    expect(fx.file.pages.length).toBeGreaterThan(2);
    expect(smallShapes(3).map((o) => o.id)).toEqual(['s0', 's1', 's2']);
  });

  it('puts the stand-in into a presentation body with one section and one slide', () => {
    const fx = slideFileOf(1200, { slideId: 'one', title: 'T' });
    const sections = fx.presentation.sections as { slides: Slide[] }[];
    expect(sections).toHaveLength(1);
    expect(sections[0]!.slides.map((s) => s.id)).toEqual(['one']);
    expect(fx.presentation.title).toBe('T');
  });
});
