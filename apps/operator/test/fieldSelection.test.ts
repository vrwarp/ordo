import { afterEach, describe, expect, it, vi } from 'vitest';
import { restoreFieldSelection, TEXT_FIELD_ID } from '../src/views/editor/fieldSelection.ts';

/** A stand-in for the Object panel's text field: its value and the range last set on it. */
class FakeField {
  value: string;
  range: [number, number] | undefined;
  constructor(value: string) {
    this.value = value;
  }
  setSelectionRange(start: number, end: number): void {
    this.range = [start, end];
  }
}

describe('restoreFieldSelection (the range after an undo, a redo, a cut or a paste)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sets the range in the same call, never a frame later', () => {
    const field = new FakeField('Potluck lunch after the service');
    const ids: string[] = [];
    vi.stubGlobal('document', {
      getElementById: (id: string) => {
        ids.push(id);
        return field;
      },
    });
    const frames = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frames);
    expect(restoreFieldSelection({ start: 0, end: 7 })).toEqual({ start: 0, end: 7 });
    expect(field.range).toEqual([0, 7]);
    expect(ids).toEqual([TEXT_FIELD_ID]);
    expect(frames).not.toHaveBeenCalled();
    // A selection made right after it is the one the field keeps (nothing pending can overwrite it).
    field.setSelectionRange(3, 3);
    expect(field.range).toEqual([3, 3]);
  });

  it('cuts the range to the new text', () => {
    const field = new FakeField('Potluck');
    vi.stubGlobal('document', { getElementById: () => field });
    expect(restoreFieldSelection({ start: 4, end: 30 })).toEqual({ start: 4, end: 7 });
    expect(field.range).toEqual([4, 7]);
    expect(restoreFieldSelection({ start: -3, end: 2 })).toEqual({ start: 0, end: 2 });
  });

  it('does nothing without the field (another panel is open, or no DOM)', () => {
    vi.stubGlobal('document', { getElementById: () => null });
    expect(restoreFieldSelection({ start: 0, end: 1 })).toBeUndefined();
    vi.stubGlobal('document', undefined);
    expect(restoreFieldSelection({ start: 0, end: 1 })).toBeUndefined();
  });
});
