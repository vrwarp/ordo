import type { Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { slideText } from './model.ts';

const page = (textAligned?: boolean): Slide => ({
  id: 's',
  objects: [],
  imported: {
    fileId: 'f',
    page: 2,
    imageMediaId: 'm',
    textBoxes: [{ text: 'Offering', box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 } }],
    ...(textAligned === undefined ? {} : { textAligned }),
  },
});

describe('stage text of a picture slide (design/27 §11)', () => {
  it('shows the page’s own text, never a legacy box that may be another slide’s', () => {
    expect(slideText(page(true))).toBe('Offering');
    expect(slideText(page())).toBe('');
    expect(slideText(page(false))).toBe('');
  });
});
