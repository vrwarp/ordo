import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, parseLyrics, type Slide, songFromParsed, type Theme } from '@ordo/domain';
import { snapBox } from '../src/views/editor/snapping.ts';
import { History } from '../src/views/editor/history.ts';
import { MAX_TEXT_CANVAS, TEXT_MARGIN, textDensity, textRasterKey } from '../src/views/editor/textRaster.ts';
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

describe('rich text in the editor (design/27 §7.4, §11)', () => {
  /** The song's first slide with its lyric made rich: a bold 'b' and a level per paragraph. */
  const richSong = () => {
    const p = song();
    const s0 = p.sections[0]!.slides[0]!;
    const lyr = lyricObject(s0)!;
    expect(lyr.text).toBe('a\nb\nc\nd');
    return {
      p: updateObject(p, s0.id, lyr.id, (o) => ({
        ...o,
        runs: [{ start: 2, end: 3, fontWeight: 900 }],
        paras: [{ level: 1 }, { level: 2 }, { level: 3 }, { level: 4 }],
      })),
      id: s0.id,
    };
  };
  const rich = (s: Slide) => {
    const o = lyricObject(s)!;
    return [o.text, o.runs?.map((r) => [r.start, r.end]), o.paras?.map((x) => x?.level)];
  };

  it('splits and merges slides with their runs and paragraph styles', () => {
    const { p, id } = richSong();
    const split = splitSlide(p, id);
    expect(split.sections[0]!.slides.slice(0, 2).map(rich)).toEqual([
      ['a\nb', [[2, 3]], [1, 2]],
      ['c\nd', [], [3, 4]],
    ]);
    const merged = mergeWithNext(split, id);
    expect(rich(merged.sections[0]!.slides[0]!)).toEqual(['a\nb\nc\nd', [[2, 3]], [1, 2, 3, 4]]);
  });

  it('keeps a legacy lyric legacy through a split and a merge', () => {
    const p = song();
    const s0 = p.sections[0]!.slides[0]!;
    const merged = mergeWithNext(splitSlide(p, s0.id), s0.id);
    const o = lyricObject(merged.sections[0]!.slides[0]!)!;
    expect('runs' in o || 'paras' in o).toBe(false);
  });

  it('rasterizes rich text at the screen density and legacy text at 1:1', () => {
    const lyr = lyricObject(song().sections[0]!.slides[0]!)!;
    expect(textDensity(lyr, 2)).toBe(1);
    const r = { ...lyr, runs: [] };
    expect(textDensity(r, 2)).toBe(2);
    expect(textDensity(r, Number.NaN)).toBe(1);
    const huge = { ...r, box: { ...r.box, w: 3840 } };
    expect((3840 + 2 * TEXT_MARGIN) * textDensity(huge, 4)).toBeLessThanOrEqual(MAX_TEXT_CANVAS);
    expect(textRasterKey(r, 3, 2)).not.toBe(textRasterKey(r, 3, 1));
  });
});
