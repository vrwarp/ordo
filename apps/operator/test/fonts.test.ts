/**
 * Library fonts by layout (design/28 §7; services/fonts.ts createFontSync): the thumbnail worker always gets the
 * list; the page's resolver and document faces only on the regular layout, and a switch to it adds them once
 * with the last list. The regular layout behaves as before.
 */
import type { Font } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import type { Layout } from '../src/lib/layout.ts';
import { createFontSync } from '../src/services/fonts.ts';

const font = (family: string, hash: string): Font =>
  ({
    id: hash,
    family,
    weight: 400,
    style: 'normal',
    file: { hash, bytes: 10, mime: 'font/ttf', path: `files/${hash}` },
  }) as unknown as Font;

function harness(start: Layout) {
  let layout = start;
  const thumbLists: number[] = [];
  const resolverLists: number[] = [];
  const faces: string[] = [];
  const sync = createFontSync({
    setThumbFonts: (f) => thumbLists.push(f.length),
    resolverSync: (f) => resolverLists.push(f.length),
    addDocumentFace: (family, url) => faces.push(`${family} ${url}`),
    layout: () => layout,
    fileUrl: (h) => `/api/v1/files/${h}`,
  });
  return {
    sync,
    thumbLists,
    resolverLists,
    faces,
    set(l: Layout) {
      layout = l;
      sync.layoutChanged(l);
    },
  };
}

describe('syncFonts', () => {
  it('regular: worker, resolver and each document face once, as before', () => {
    const h = harness('regular');
    h.sync.sync([font('A', 'a'), font('B', 'b')]);
    h.sync.sync([font('A', 'a'), font('B', 'b'), font('C', 'c')]);
    expect(h.thumbLists).toEqual([2, 3]);
    expect(h.resolverLists).toEqual([2, 3]);
    expect(h.faces).toEqual(['A /api/v1/files/a', 'B /api/v1/files/b', 'C /api/v1/files/c']);
  });

  it('compact: the worker gets the list, the page loads no face', () => {
    const h = harness('compact');
    h.sync.sync([font('A', 'a')]);
    expect(h.thumbLists).toEqual([1]);
    expect(h.resolverLists).toEqual([]);
    expect(h.faces).toEqual([]);
  });

  it('a switch to regular adds and loads each face once, with the last list', () => {
    const h = harness('compact');
    h.sync.sync([font('A', 'a')]);
    h.sync.sync([font('A', 'a'), font('B', 'b')]);
    h.set('regular');
    expect(h.resolverLists).toEqual([2]);
    expect(h.faces).toEqual(['A /api/v1/files/a', 'B /api/v1/files/b']);
    h.set('compact');
    h.set('regular');
    expect(h.faces).toHaveLength(2);
    expect(h.resolverLists).toEqual([2, 2]);
  });

  it('a switch with no list yet does nothing', () => {
    const h = harness('compact');
    h.set('regular');
    expect(h.resolverLists).toEqual([]);
    expect(h.faces).toEqual([]);
  });
});
