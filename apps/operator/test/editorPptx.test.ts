import { describe, expect, it } from 'vitest';
import { cloneSlide } from '../src/views/editor/ops.ts';

describe('duplicating a PowerPoint slide', () => {
  const pptx = (o: Record<string, unknown>) => ({
    fileId: 'deck',
    index: 3,
    shown: 2,
    version: 1,
    digest: 'd',
    ...o,
  });
  it('does not carry the follow-up plan to the copy: only a picture slide still waits for its page', () => {
    const hybrid = cloneSlide({
      id: 'h',
      objects: [],
      pptx: pptx({ class: 'hybrid', pending: true }),
    } as never);
    expect(hybrid.id).not.toBe('h');
    expect(hybrid.pptx).toMatchObject({ class: 'hybrid', index: 3 });
    expect(hybrid.pptx!.pending).toBeUndefined();
    expect(hybrid.pptx!.digest).toBeUndefined();
    const picture = cloneSlide({
      id: 'p',
      objects: [],
      pptx: pptx({ class: 'picture', pending: true }),
    } as never);
    expect(picture.pptx).toMatchObject({ class: 'picture', pending: true });
    expect(picture.pptx!.digest).toBeUndefined();
    // A slide LibreOffice could not draw stays reported in its copy.
    const failed = cloneSlide({
      id: 'f',
      objects: [],
      pptx: pptx({ class: 'hybrid', failed: true }),
    } as never);
    expect(failed.pptx!.failed).toBe(true);
  });
});
