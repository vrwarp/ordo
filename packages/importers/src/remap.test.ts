import type { Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import { PPTX_MEDIA_PREFIX, remapMediaIds } from './index.ts';

const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
const image = (id: string, mediaId: string) =>
  ({ id, type: 'image', box, mediaId, fit: 'stretch', opacity: 1, radius: 0 }) as const;

describe('remapMediaIds with PowerPoint placeholders', () => {
  it('maps pptxmedia ids, drops images whose picture was not stored and removes unmapped backgrounds', () => {
    const slide: Slide = {
      id: 's1',
      backgroundMediaId: `${PPTX_MEDIA_PREFIX}3`,
      objects: [image('a', `${PPTX_MEDIA_PREFIX}1`), image('b', `${PPTX_MEDIA_PREFIX}2`)],
      lyricObjectId: 'a',
    };
    const out = remapMediaIds(slide, new Map([[`${PPTX_MEDIA_PREFIX}1`, 'M1']]));
    expect(out.objects.map((o) => (o.type === 'image' ? o.mediaId : ''))).toEqual(['M1']);
    expect(out.backgroundMediaId).toBeUndefined();
    expect(out.lyricObjectId).toBe('a');
    // The input is untouched.
    expect(slide.objects).toHaveLength(2);
    expect(slide.backgroundMediaId).toBe(`${PPTX_MEDIA_PREFIX}3`);
  });

  it('keeps a placeholder-looking string outside the media fields', () => {
    const out = remapMediaIds(
      { notes: `${PPTX_MEDIA_PREFIX}9`, mediaId: `${PPTX_MEDIA_PREFIX}9` },
      new Map(),
    );
    expect(out).toEqual({ notes: `${PPTX_MEDIA_PREFIX}9` });
  });
});
