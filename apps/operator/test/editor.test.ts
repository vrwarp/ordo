import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, parseLyrics, songFromParsed, type Theme } from '@ordo/domain';
import { snapBox } from '../src/views/editor/snapping.ts';
import { History } from '../src/views/editor/history.ts';
import {
  addSection,
  applyTheme,
  deleteSection,
  duplicateObject,
  lyricObject,
  markOverride,
  mergeWithNext,
  moveSlide,
  reorderObject,
  resetSlideToTheme,
  splitSlide,
  updateObject,
} from '../src/views/editor/ops.ts';

const song = () => songFromParsed(parseLyrics('Verse 1\na\nb\nc\nd\n\nChorus\ne\nf'), { linesPerSlide: 4 });

describe('snapping', () => {
  it('snaps centre to canvas centre and edges to other objects', () => {
    const r = snapBox({ x: 455, y: 10, w: 1000, h: 100, rotation: 0 }, []);
    expect(r.x).toBe(460);
    expect(r.guides.x).toEqual([960]);
    expect(r.y).toBe(10);
    const r2 = snapBox({ x: 1203, y: 503, w: 100, h: 100, rotation: 0 }, [
      { x: 1000, y: 600, w: 200, h: 50, rotation: 0 },
    ]);
    expect(r2.x).toBe(1200);
    expect(r2.y).toBe(500);
  });
});

describe('history', () => {
  it('undoes, redoes and coalesces', () => {
    const h = new History<number>();
    h.push(1, undefined, 0);
    h.push(2, 'nudge', 10);
    h.push(3, 'nudge', 20);
    expect(h.undo(4)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeUndefined();
    expect(h.redo(1)).toBe(2);
    expect(h.canRedo).toBe(true);
  });
});

describe('slide ops', () => {
  it('splits and merges lyric slides', () => {
    const p = song();
    const s0 = p.sections[0]!.slides[0]!;
    const split = splitSlide(p, s0.id);
    expect(split.sections[0]!.slides.map((s) => lyricObject(s)?.text)).toEqual(['a\nb', 'c\nd']);
    const merged = mergeWithNext(split, s0.id);
    expect(merged.sections[0]!.slides.map((s) => lyricObject(s)?.text)).toEqual(['a\nb\nc\nd']);
  });

  it('moves slides between sections and manages sections in arrangements', () => {
    const p = song();
    const s0 = p.sections[0]!.slides[0]!;
    const moved = moveSlide(p, s0.id, p.sections[1]!.id, 1);
    expect(moved.sections[0]!.slides).toHaveLength(0);
    expect(moved.sections[1]!.slides[1]!.id).toBe(s0.id);
    const added = addSection(p, 'Bridge', 'B', DEFAULT_THEME);
    expect(added.arrangements[0]!.sectionIds).toHaveLength(3);
    const removed = deleteSection(added, added.sections[2]!.id);
    expect(removed.arrangements[0]!.sectionIds).toHaveLength(2);
  });

  it('applies a theme except overridden properties and resets', () => {
    const p = song();
    const s0 = p.sections[0]!.slides[0]!;
    const lyr = lyricObject(s0)!;
    let q = updateObject(p, s0.id, lyr.id, (o) =>
      o.type === 'text' ? { ...o, style: { ...o.style, fontSizePx: 120 } } : o,
    );
    q = {
      ...q,
      sections: q.sections.map((sec) => ({
        ...sec,
        slides: sec.slides.map((s) => (s.id === s0.id ? markOverride(s, 'style.fontSizePx') : s)),
      })),
    };
    const theme: Theme = {
      ...DEFAULT_THEME,
      id: 't2',
      text: { ...DEFAULT_THEME.text, fontSizePx: 50, fontFamily: 'Lato' },
    };
    const themed = applyTheme(q, theme);
    const a = lyricObject(themed.sections[0]!.slides[0]!)!;
    const b = lyricObject(themed.sections[1]!.slides[0]!)!;
    expect(a.style.fontSizePx).toBe(120);
    expect(a.style.fontFamily).toBe('Lato');
    expect(b.style.fontSizePx).toBe(50);
    const reset = resetSlideToTheme(themed.sections[0]!.slides[0]!, theme);
    expect(lyricObject(reset)!.style.fontSizePx).toBe(50);
    expect(reset.overrides).toBeUndefined();
  });

  it('duplicates and reorders objects', () => {
    const p = song();
    const s0 = p.sections[0]!.slides[0]!;
    const lyr = lyricObject(s0)!;
    const d = duplicateObject(p, s0.id, lyr.id);
    const objs = d.p.sections[0]!.slides[0]!.objects;
    expect(objs).toHaveLength(2);
    expect(objs[1]!.box.x).toBe(lyr.box.x + 20);
    const back = reorderObject(d.p, s0.id, d.id!, 'back');
    expect(back.sections[0]!.slides[0]!.objects[0]!.id).toBe(d.id);
  });
});
