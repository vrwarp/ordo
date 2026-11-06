import { describe, expect, it } from 'vitest';
import { firstText, importedText } from './cues.ts';
import type { Slide } from './schemas.ts';

const box = { x: 0, y: 0, w: 100, h: 50, rotation: 0 };
const page = (textAligned: boolean | undefined, ...texts: string[]): Slide => ({
  id: 's',
  objects: [],
  imported: {
    fileId: 'f',
    page: 1,
    imageMediaId: 'm',
    textBoxes: texts.map((text) => ({ text, box })),
    ...(textAligned === undefined ? {} : { textAligned }),
  },
});

describe('the gated text fallback of picture slides (design/27 §11)', () => {
  it('uses imported text boxes only once they are known to be the page’s own', () => {
    // Legacy boxes were matched by list index: after a hidden slide they hold another slide's text.
    expect(importedText(page(undefined, 'Another slide'))).toBe('');
    expect(importedText(page(false, 'Another slide'))).toBe('');
    expect(importedText(page(true, ' Welcome ', '', 'Pastor Sam'))).toBe('Welcome\nPastor Sam');
    expect(firstText(page(undefined, 'Another slide'))).toBe('');
    expect(firstText(page(true, 'Welcome', 'Pastor Sam'))).toBe('Welcome\nPastor Sam');
  });

  it('falls back to the text baked into a hybrid or picture slide’s art', () => {
    const pptx = (cls: 'native' | 'hybrid' | 'picture') =>
      ({
        id: 's',
        objects: [],
        pptx: { fileId: 'f', index: 0, class: cls, version: 1, artText: 'Q3 giving' },
      }) as Slide;
    expect(importedText(pptx('hybrid'))).toBe('Q3 giving');
    expect(importedText(pptx('picture'))).toBe('Q3 giving');
    expect(importedText(pptx('native'))).toBe('');
    expect(firstText(pptx('picture'))).toBe('Q3 giving');
  });

  it('never replaces the slide’s own text', () => {
    const own = {
      ...page(true, 'Page text'),
      objects: [{ id: 't', type: 'text', text: 'Edited title' }],
    } as unknown as Slide;
    expect(firstText(own)).toBe('Edited title');
    // An empty text object is no text: the page's own text shows.
    const empty = {
      ...page(true, 'Page text'),
      objects: [{ id: 't', type: 'text', text: '' }],
    } as unknown as Slide;
    expect(firstText(empty)).toBe('Page text');
  });

  it('is bounded and never splits a surrogate pair', () => {
    const long = page(true, 'a'.repeat(19_999) + '😀', 'more');
    const t = importedText(long);
    expect(t.length).toBeLessThanOrEqual(20_000);
    expect(t.endsWith('a')).toBe(true);
    const odd = { id: 's', objects: [], imported: { textAligned: true, textBoxes: [{ text: 5 }, null] } };
    expect(importedText(odd as never)).toBe('');
  });
});
