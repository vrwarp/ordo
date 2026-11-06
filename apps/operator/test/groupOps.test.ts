/**
 * Groups and locked objects in the editor (M4 item B; design/27 §11 item 5 "Groups and shape+text pairs",
 * "Locked objects", §14 item 9 "group transforms", §15 M4 "200-step undo"): the group ops, what a press on
 * the canvas selects, the selection actions on the store (one undo step each), and the Object panel's group
 * note, group box and locked state.
 */
import {
  type Box,
  DEFAULT_THEME,
  type ImageObject,
  type Presentation,
  type ShapeObject,
  type Slide,
  type SlideObject,
  type TextObject,
} from '@ordo/domain';
import fc from 'fast-check';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as actions from '../src/views/editor/actions.ts';
import {
  currentObjects,
  openPresentation,
  redo,
  selectObjects,
  selectSlide,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import {
  GroupBoxView,
  GroupNoteView,
  LockedNote,
  ObjectBoxView,
  objectLabel,
  withAspect,
} from '../src/views/editor/GroupPanel.tsx';
import { ObjectPanel } from '../src/views/editor/ObjectPanel.tsx';
import { getSlide, type ZOrder } from '../src/views/editor/ops.ts';
import {
  boundsOf,
  boxFromCorner,
  clickSelection,
  deleteObjects,
  duplicateObjects,
  groupBox,
  groupMembers,
  hasGroup,
  isLocked,
  keepsAspect,
  moveObjects,
  reorderObjects,
  transformGroup,
  transformMember,
  ungroup,
} from '../src/views/editor/ops/group.ts';

// ---- a slide like an imported one ------------------------------------------------------------------------

const B = (x: number, y: number, w: number, h: number, rotation = 0): Box => ({ x, y, w, h, rotation });
const bg = (): ShapeObject => ({
  id: 'bg',
  type: 'shape',
  box: B(0, 0, 1920, 1080),
  shape: 'rect',
  fill: { r: 255, g: 255, b: 255, a: 1 },
  opacity: 1,
  radius: 0,
  origin: { src: 'pptx', role: 'bg' },
});
/** The rounded box of "Coffee after the service" and its text: one PowerPoint shape, group 4. */
const pairShape = (): ShapeObject => ({
  id: 'sh',
  type: 'shape',
  box: B(576, 480, 1402, 480),
  shape: 'rect',
  fill: { r: 31, g: 78, b: 121, a: 1 },
  stroke: { width: 3, color: { r: 0, g: 0, b: 0, a: 1 } },
  opacity: 1,
  radius: 40,
  origin: { src: 'pptx', shapeId: 4, role: 'shape', group: 4 },
});
const pairText = (): TextObject => ({
  id: 'tx',
  type: 'text',
  box: B(600, 500, 1354, 440),
  text: 'Coffee after the service',
  style: { ...DEFAULT_THEME.textBoxDefaults, fontSizePx: 80 },
  opacity: 1,
  runs: [{ start: 0, end: 6, fontWeight: 700 }],
  origin: { src: 'pptx', shapeId: 4, role: 'text', group: 4 },
});
const photo = (): ImageObject => ({
  id: 'pic',
  type: 'image',
  box: B(100, 100, 400, 300),
  mediaId: 'm1',
  fit: 'cover',
  opacity: 1,
  radius: 0,
  origin: { src: 'pptx', shapeId: 7, role: 'picture' },
});
/** LibreOffice's art for a chart: locked, stretched to its box. */
const art = (): ImageObject => ({
  id: 'art',
  type: 'image',
  box: B(1200, 100, 600, 300),
  mediaId: 'm2',
  fit: 'stretch',
  opacity: 1,
  radius: 0,
  locked: true,
  origin: { src: 'pptx', role: 'art' },
});
const slide = (): Slide => ({
  id: 's1',
  objects: [bg(), pairShape(), pairText(), photo(), art()],
  lyricObjectId: 'tx',
});
const deck = (): Presentation => ({
  id: 'p1',
  rev: 2,
  title: 'Church',
  kind: 'slides',
  meta: { tags: [] },
  sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [slide(), { id: 's2', objects: [] }] }],
  arrangements: [{ id: 'a', name: 'Default', sectionIds: ['sec'] }],
  archived: false,
});
const objs = (p: Presentation, slideId = 's1') => getSlide(p, slideId)!.objects;
const obj = (p: Presentation, id: string) => objs(p).find((o) => o.id === id)!;
const ids = (p: Presentation) => objs(p).map((o) => o.id);
const close = (a: Box, b: Box, eps = 0.01) => {
  for (const k of ['x', 'y', 'w', 'h', 'rotation'] as const)
    expect(Math.abs(a[k] - b[k]), k).toBeLessThan(eps);
};

describe('groups and the selection a press makes', () => {
  it('a member selects its group in z order; an object without one, itself', () => {
    const s = slide();
    expect(groupMembers(s, 'tx')).toEqual(['sh', 'tx']);
    expect(groupMembers(s, 'sh')).toEqual(['sh', 'tx']);
    expect(groupMembers(s, 'pic')).toEqual(['pic']);
    expect(groupMembers(s, 'gone')).toEqual([]);
    expect(hasGroup([pairText()])).toBe(true);
    expect(hasGroup([photo(), art()])).toBe(false);
  });

  it('plain press: the group (primary the pressed one), or the selection kept when it is in it', () => {
    const s = slide();
    expect(clickSelection(s, { ids: [] }, 'tx')).toEqual({ ids: ['sh', 'tx'], primary: 'tx' });
    expect(clickSelection(s, { ids: ['pic'], primary: 'pic' }, 'sh')).toEqual({
      ids: ['sh', 'tx'],
      primary: 'sh',
    });
    // Pressing a selected object keeps the selection, so the press can drag all of it.
    expect(clickSelection(s, { ids: ['pic', 'art'], primary: 'pic' }, 'art')).toEqual({
      ids: ['pic', 'art'],
      primary: 'art',
    });
    expect(clickSelection(s, { ids: ['tx'], primary: 'tx' }, 'tx')).toEqual({ ids: ['tx'], primary: 'tx' });
    expect(clickSelection(s, { ids: [] }, 'gone')).toBeUndefined();
  });

  it('Alt: one member; Shift: the group added or taken out; Shift+Alt: one member toggled', () => {
    const s = slide();
    expect(clickSelection(s, { ids: ['sh', 'tx'], primary: 'sh' }, 'tx', { alt: true })).toEqual({
      ids: ['tx'],
      primary: 'tx',
    });
    expect(clickSelection(s, { ids: ['pic'], primary: 'pic' }, 'tx', { shift: true })).toEqual({
      ids: ['sh', 'tx', 'pic'],
      primary: 'tx',
    });
    expect(clickSelection(s, { ids: ['sh', 'tx', 'pic'], primary: 'pic' }, 'sh', { shift: true })).toEqual({
      ids: ['pic'],
      primary: 'pic',
    });
    expect(clickSelection(s, { ids: ['sh', 'tx'], primary: 'tx' }, 'tx', { shift: true, alt: true })).toEqual(
      {
        ids: ['sh'],
        primary: 'sh',
      },
    );
    expect(clickSelection(s, { ids: ['pic'], primary: 'pic' }, 'pic', { shift: true })).toBeUndefined();
    // Stale ids (objects gone) are dropped.
    expect(clickSelection(s, { ids: ['gone'], primary: 'gone' }, 'pic', { shift: true })).toEqual({
      ids: ['pic'],
      primary: 'pic',
    });
  });
});

describe('geometry', () => {
  it('bounds of a turned box, the group box of a selection', () => {
    expect(boundsOf(B(0, 0, 100, 50))).toEqual({ x0: 0, y0: 0, x1: 100, y1: 50 });
    const q = boundsOf(B(0, 0, 100, 50, 90));
    expect(q.x0).toBeCloseTo(25);
    expect(q.y0).toBeCloseTo(-25);
    expect(q.x1).toBeCloseTo(75);
    expect(q.y1).toBeCloseTo(75);
    expect(groupBox([pairShape(), pairText()])).toEqual(B(576, 480, 1402, 480));
    expect(groupBox([photo(), art()])).toEqual(B(100, 100, 1700, 300));
    expect(groupBox([])).toBeUndefined();
  });

  it("Konva's corner-anchored rectangle as a centre-turned slide box", () => {
    expect(boxFromCorner({ x: 50, y: 25, width: 200, height: 100, rotation: 0 }, 0.5)).toEqual(
      B(100, 50, 400, 200),
    );
    // Turned a quarter about its top-left corner (100, 0): its centre is at (0, 100) in slide px.
    const b = boxFromCorner({ x: 100, y: 0, width: 200, height: 100, rotation: 90 }, 1);
    expect(b.x + b.w / 2).toBeCloseTo(50);
    expect(b.y + b.h / 2).toBeCloseTo(100);
    expect(b).toMatchObject({ w: 200, h: 100, rotation: 90 });
  });

  it('a member turned a quarter takes the group scale along its own axes', () => {
    const from = B(0, 0, 100, 100);
    const to = B(0, 0, 200, 100);
    const plain = transformMember({ type: 'shape', box: B(0, 0, 100, 50) }, from, to);
    expect(plain).toEqual(B(0, 0, 200, 50));
    const turned = transformMember({ type: 'shape', box: B(25, 25, 50, 20, 90) }, from, to);
    // Its width runs down the slide: it does not widen; its height (across) doubles.
    expect(turned).toMatchObject({ w: 50, h: 40, rotation: 90 });
    expect(turned.x + turned.w / 2).toBeCloseTo(100);
  });
});

describe('the group ops', () => {
  it('moveObjects moves every member, locked ones too, and nothing else', () => {
    const p = deck();
    const q = moveObjects(p, 's1', ['sh', 'tx', 'art'], 30, -10);
    expect(obj(q, 'sh').box).toEqual(B(606, 470, 1402, 480));
    expect(obj(q, 'tx').box).toEqual(B(630, 490, 1354, 440));
    expect(obj(q, 'art').box).toEqual(B(1230, 90, 600, 300));
    expect(obj(q, 'pic')).toBe(obj(p, 'pic'));
    expect(getSlide(q, 's2')).toBe(getSlide(p, 's2'));
    expect(moveObjects(p, 's1', ['sh'], 0, 0)).toBe(p);
    expect(moveObjects(p, 's1', ['gone'], 5, 5)).toBe(p);
    expect(moveObjects(p, 'nope', ['sh'], 5, 5)).toBe(p);
    expect(moveObjects(p, 's1', ['sh'], Number.NaN, 5)).toBe(p);
  });

  it('transformGroup scales the boxes about the group box; fonts, strokes and corners do not scale', () => {
    const p = deck();
    const from = groupBox([pairShape(), pairText()])!;
    const to = { ...from, x: 100, y: 100, w: from.w / 2, h: from.h / 2 };
    const q = transformGroup(p, 's1', ['sh', 'tx'], from, to);
    expect(obj(q, 'sh').box).toEqual(B(100, 100, 701, 240));
    expect(obj(q, 'tx').box).toEqual(B(112, 110, 677, 220));
    const t = obj(q, 'tx') as TextObject;
    expect(t.style).toEqual(pairText().style);
    expect(t.runs).toEqual(pairText().runs);
    const sh = obj(q, 'sh') as ShapeObject;
    expect(sh.stroke).toEqual(pairShape().stroke);
    expect(sh.radius).toBe(40);
    expect(transformGroup(p, 's1', ['sh', 'tx'], from, { ...from })).toBe(p);
    expect(transformGroup(p, 's1', ['sh', 'tx'], from, { ...to, w: Number.POSITIVE_INFINITY })).toBe(p);
  });

  it('a turn turns members about the group centre; a locked member only follows it', () => {
    const p = deck();
    const from = groupBox([photo(), art()])!; // 100,100 1700x300: centre (950, 250)
    const q = transformGroup(p, 's1', ['pic', 'art'], from, { ...from, rotation: 90 });
    const pic = obj(q, 'pic').box;
    // The photo's centre (300, 250) is 650 left of the group centre: a quarter turn puts it 650 above.
    expect(pic.x + pic.w / 2).toBeCloseTo(950);
    expect(pic.y + pic.h / 2).toBeCloseTo(250 - 650);
    expect(pic.rotation).toBe(90);
    const a = obj(q, 'art').box;
    expect(a.x + a.w / 2).toBeCloseTo(950);
    expect(a.y + a.h / 2).toBeCloseTo(250 + 550);
    expect(a.rotation).toBe(0);
    expect([a.w, a.h]).toEqual([600, 300]);
  });

  it('locked art keeps its aspect in a group resize; a free member does not', () => {
    const p = deck();
    const from = groupBox([photo(), art()])!;
    const q = transformGroup(p, 's1', ['pic', 'art'], from, { ...from, w: from.w * 2, h: from.h });
    expect(obj(q, 'pic').box).toMatchObject({ w: 800, h: 300 });
    expect(obj(q, 'art').box).toMatchObject({ w: 600, h: 300 });
    expect(keepsAspect(art())).toBe(true);
    expect(keepsAspect(photo())).toBe(false);
    expect(keepsAspect({ ...pairShape(), locked: true })).toBe(false);
    expect(isLocked(art())).toBe(true);
  });

  it('deleteObjects removes the block, locked objects too, and clears the lyric object', () => {
    const p = deck();
    const q = deleteObjects(p, 's1', ['sh', 'tx', 'art']);
    expect(ids(q)).toEqual(['bg', 'pic']);
    expect(getSlide(q, 's1')!.lyricObjectId).toBeUndefined();
    expect(getSlide(deleteObjects(p, 's1', ['pic']), 's1')!.lyricObjectId).toBe('tx');
    expect(deleteObjects(p, 's1', ['gone'])).toBe(p);
    expect(deleteObjects(p, 's1', [])).toBe(p);
  });

  it('duplicateObjects: one block above the topmost, 20 px off, fresh ids, a group of its own', () => {
    const p = deck();
    const r = duplicateObjects(p, 's1', ['tx', 'sh']);
    expect(r.ids).toHaveLength(2);
    const after = objs(r.p);
    expect(after.map((o) => o.id).slice(0, 3)).toEqual(['bg', 'sh', 'tx']);
    const [cs, ct] = [after[3]!, after[4]!];
    // The copies, in the order asked for: the text's copy first.
    expect(r.ids).toEqual([ct.id, cs.id]);
    expect(cs).toEqual({ ...pairShape(), id: cs.id, box: B(596, 500, 1402, 480), origin: { ...cs.origin! } });
    expect(ct.box).toEqual(B(620, 520, 1354, 440));
    expect((ct as TextObject).runs).toEqual(pairText().runs);
    expect(cs.origin).toMatchObject({ src: 'pptx', shapeId: 4, role: 'shape' });
    expect(cs.origin!.group).toBe(ct.origin!.group);
    expect(cs.origin!.group).not.toBe(4);
    expect(groupMembers(getSlide(r.p, 's1')!, ct.id)).toEqual([cs.id, ct.id]);
    expect(groupMembers(getSlide(r.p, 's1')!, 'tx')).toEqual(['sh', 'tx']);
    expect(getSlide(r.p, 's1')!.lyricObjectId).toBe('tx');
    // A locked object's copy is locked too; an ungrouped one stays ungrouped.
    const l = duplicateObjects(p, 's1', ['art', 'pic']);
    const copies = objs(l.p).slice(5);
    expect(copies.map((o) => o.locked)).toEqual([undefined, true]);
    expect(copies.every((o) => o.origin?.group === undefined)).toBe(true);
    expect(duplicateObjects(p, 's1', ['gone'])).toEqual({ p, ids: [] });
  });

  it('duplicateObjects finds a free group number when the top one is taken', () => {
    const p = deck();
    const s = getSlide(p, 's1')!;
    const full: Presentation = {
      ...p,
      sections: [
        {
          ...p.sections[0]!,
          slides: [
            {
              ...s,
              objects: s.objects.map((o) =>
                o.id === 'pic' ? { ...o, origin: { src: 'pptx', group: 100_000 } } : o,
              ),
            },
          ],
        },
      ],
    };
    const r = duplicateObjects(full, 's1', ['sh', 'tx', 'pic']);
    const groups = r.ids.map((id) => obj(r.p, id).origin?.group);
    expect(new Set(groups).size).toBe(2);
    for (const g of groups) expect([0, 1]).toContain(g);
  });

  it('reorderObjects moves the selection as one contiguous block in its own order', () => {
    const p = deck(); // bg sh tx pic art
    expect(ids(reorderObjects(p, 's1', ['sh', 'tx'], 'front'))).toEqual(['bg', 'pic', 'art', 'sh', 'tx']);
    expect(ids(reorderObjects(p, 's1', ['tx', 'sh'], 'back'))).toEqual(['sh', 'tx', 'bg', 'pic', 'art']);
    expect(ids(reorderObjects(p, 's1', ['sh', 'tx'], 'forward'))).toEqual(['bg', 'pic', 'sh', 'tx', 'art']);
    expect(ids(reorderObjects(p, 's1', ['sh', 'tx'], 'backward'))).toEqual(['sh', 'tx', 'bg', 'pic', 'art']);
    // A scattered selection is gathered: forward at its top member, backward at its bottom one.
    expect(ids(reorderObjects(p, 's1', ['bg', 'pic'], 'forward'))).toEqual(['sh', 'tx', 'art', 'bg', 'pic']);
    expect(ids(reorderObjects(p, 's1', ['sh', 'art'], 'backward'))).toEqual(['sh', 'art', 'bg', 'tx', 'pic']);
    expect(reorderObjects(p, 's1', ['pic', 'art'], 'front')).toBe(p);
    expect(reorderObjects(p, 's1', ['bg'], 'back')).toBe(p);
    expect(reorderObjects(p, 's1', ['art'], 'forward')).toBe(p);
    expect(reorderObjects(p, 's1', ['gone'], 'front')).toBe(p);
  });

  it('ungroup clears the group and keeps the rest of the origin', () => {
    const p = deck();
    const q = ungroup(p, 's1', ['sh', 'tx']);
    expect(obj(q, 'sh').origin).toEqual({ src: 'pptx', shapeId: 4, role: 'shape' });
    expect(obj(q, 'tx').origin).toEqual({ src: 'pptx', shapeId: 4, role: 'text' });
    expect(groupMembers(getSlide(q, 's1')!, 'tx')).toEqual(['tx']);
    // One member taken out leaves the others grouped.
    const one = ungroup(p, 's1', ['tx']);
    expect(groupMembers(getSlide(one, 's1')!, 'sh')).toEqual(['sh']);
    expect(ungroup(q, 's1', ['sh', 'tx'])).toBe(q);
    expect(ungroup(p, 's1', ['pic', 'bg'])).toBe(p);
  });
});

// ---- properties (design/27 §14 item 9: group transforms) ---------------------------------------------

const arbBox = (rot: fc.Arbitrary<number>) =>
  fc.record({
    x: fc.integer({ min: -500, max: 2000 }),
    y: fc.integer({ min: -500, max: 1500 }),
    w: fc.integer({ min: 1, max: 1500 }),
    h: fc.integer({ min: 1, max: 1000 }),
    rotation: rot,
  });
const shapes = (boxes: Box[]): SlideObject[] =>
  boxes.map((box, i) => ({
    id: `o${i}`,
    type: 'shape',
    box,
    shape: 'rect',
    opacity: 1,
    radius: 0,
  }));
const onSlide = (objects: SlideObject[]): Presentation => ({
  ...deck(),
  sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 's1', objects }] }],
});

describe('group transform properties', () => {
  it('a resize lands the group box on `to`, and the reverse transform gives the boxes back', () => {
    fc.assert(
      fc.property(
        fc.array(arbBox(fc.constant(0)), { minLength: 1, maxLength: 6 }),
        fc.record({
          x: fc.integer({ min: -300, max: 1500 }),
          y: fc.integer({ min: -300, max: 900 }),
          sx: fc.double({ min: 0.1, max: 4, noNaN: true }),
          sy: fc.double({ min: 0.1, max: 4, noNaN: true }),
        }),
        (boxes, t) => {
          const p = onSlide(shapes(boxes));
          const all = boxes.map((_, i) => `o${i}`);
          const from = groupBox(objs(p))!;
          const to = { x: t.x, y: t.y, w: from.w * t.sx, h: from.h * t.sy, rotation: 0 };
          const q = transformGroup(p, 's1', all, from, to);
          // Members smaller than 1 px stay 1 px, so only boxes that keep their size compare exactly.
          if (objs(q).some((o) => o.box.w === 1 || o.box.h === 1)) return;
          close(groupBox(objs(q))!, to, 0.05);
          const back = transformGroup(q, 's1', all, groupBox(objs(q))!, from);
          for (const [i, o] of objs(back).entries()) close(o.box, boxes[i]!, 0.05);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('turning the group and back gives every box back; a turn keeps each member its size', () => {
    fc.assert(
      fc.property(
        fc.array(arbBox(fc.integer({ min: -179, max: 180 })), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: -179, max: 180 }).filter((d) => d !== 0),
        (boxes, deg) => {
          const p = onSlide(shapes(boxes));
          const all = boxes.map((_, i) => `o${i}`);
          const from = groupBox(objs(p))!;
          const to = { ...from, rotation: deg };
          const q = transformGroup(p, 's1', all, from, to);
          objs(q).forEach((o, i) => {
            expect(o.box.w).toBeCloseTo(boxes[i]!.w, 2);
            expect(o.box.h).toBeCloseTo(boxes[i]!.h, 2);
          });
          const back = transformGroup(q, 's1', all, to, from);
          for (const [i, o] of objs(back).entries()) close(o.box, boxes[i]!, 0.2);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('every reorder is a permutation that leaves the selection one contiguous block in its order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }).chain((n) =>
          fc.tuple(
            fc.constant(n),
            fc.subarray(
              Array.from({ length: n }, (_, i) => `o${i}`),
              { minLength: 1 },
            ),
            fc.constantFrom<ZOrder>('front', 'back', 'forward', 'backward'),
          ),
        ),
        ([n, sel, z]) => {
          const p = onSlide(shapes(Array.from({ length: n }, () => B(0, 0, 10, 10))));
          const q = reorderObjects(p, 's1', sel, z);
          const after = ids(q);
          expect([...after].sort()).toEqual([...ids(p)].sort());
          const at = sel.map((id) => after.indexOf(id)).sort((a, b) => a - b);
          expect(at[at.length - 1]! - at[0]!).toBe(sel.length - 1);
          expect(after.filter((id) => sel.includes(id))).toEqual(ids(p).filter((id) => sel.includes(id)));
          if (z === 'front') expect(at[at.length - 1]).toBe(n - 1);
          if (z === 'back') expect(at[0]).toBe(0);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('duplicate then delete the copies gives the slide back', () => {
    fc.assert(
      fc.property(fc.subarray(['bg', 'sh', 'tx', 'pic', 'art'], { minLength: 1 }), (sel) => {
        const p = deck();
        const r = duplicateObjects(p, 's1', sel);
        expect(r.ids).toHaveLength(sel.length);
        expect(objs(r.p)).toHaveLength(5 + sel.length);
        expect(objs(deleteObjects(r.p, 's1', r.ids))).toEqual(objs(p));
      }),
      { numRuns: 100 },
    );
  });
});

// ---- the selection actions on the store ------------------------------------------------------------

describe('the selection actions (one undo step each)', () => {
  beforeEach(() => {
    openPresentation(deck());
    selectSlide('s1');
  });
  afterEach(() => vi.useRealTimers());
  const draft = () => useEditor.getState().draft!;

  it('nudges coalesce, drags do not; undo puts the group back', () => {
    selectObjects(['sh', 'tx'], 'tx');
    actions.moveSelection(1, 0);
    actions.moveSelection(1, 0);
    actions.moveSelection(0, 10);
    expect(obj(draft(), 'sh').box).toMatchObject({ x: 578, y: 490 });
    expect(obj(draft(), 'tx').box).toMatchObject({ x: 602, y: 510 });
    actions.dragSelection(100, 0);
    actions.dragSelection(100, 0);
    undo();
    expect(obj(draft(), 'sh').box.x).toBe(678);
    undo();
    undo();
    expect(objs(draft())).toEqual(slide().objects);
    expect(useEditor.getState().canUndo).toBe(false);
  });

  it('the transform, the group box and turning are one step each; the selection stays', () => {
    selectObjects(['sh', 'tx'], 'tx');
    const from = groupBox(currentObjects())!;
    actions.transformSelection(from, { ...from, w: from.w / 2 });
    expect(obj(draft(), 'sh').box.w).toBe(701);
    actions.setSelectionBox({ ...groupBox(currentObjects())!, x: 0 });
    expect(obj(draft(), 'sh').box.x).toBe(0);
    expect(obj(draft(), 'tx').box.x).toBe(12);
    actions.setSelectionBox({ ...groupBox(currentObjects())!, rotation: 180 });
    expect(obj(draft(), 'tx').box.rotation).toBe(180);
    expect(useEditor.getState()).toMatchObject({ objectId: 'tx', objectIds: ['sh', 'tx'] });
    undo();
    undo();
    undo();
    expect(objs(draft())).toEqual(slide().objects);
  });

  it('delete and undo the pair; duplicate selects the copies; z-order and Ungroup', () => {
    selectObjects(['sh', 'tx'], 'tx');
    actions.deleteSelection();
    expect(ids(draft())).toEqual(['bg', 'pic', 'art']);
    expect(useEditor.getState()).toMatchObject({ objectId: undefined, objectIds: [] });
    undo();
    expect(objs(draft())).toEqual(slide().objects);
    selectObjects(['sh', 'tx'], 'tx');
    actions.duplicateSelection();
    const st = useEditor.getState();
    expect(st.objectIds).toHaveLength(2);
    expect(st.objectIds).not.toContain('tx');
    expect(obj(draft(), st.objectId!).type).toBe('text');
    expect(ids(draft()).slice(3, 5)).toEqual(st.objectIds);
    actions.reorderSelection('back');
    expect(ids(draft()).slice(0, 2)).toEqual(st.objectIds);
    actions.ungroupSelection();
    expect(hasGroup(currentObjects())).toBe(false);
    undo();
    undo();
    undo();
    expect(objs(draft())).toEqual(slide().objects);
  });

  it('locked objects: the group actions move and delete them; the object actions leave them alone', () => {
    selectObjects(['art']);
    actions.moveSelection(5, 5);
    expect(obj(draft(), 'art').box).toMatchObject({ x: 1205, y: 105 });
    actions.cropPicture('art', { l: 0.1, t: 0, r: 0, b: 0 });
    actions.flipPicture('art', { flipH: true });
    expect(obj(draft(), 'art')).toEqual({ ...art(), box: B(1205, 105, 600, 300) });
    actions.deleteSelection();
    expect(ids(draft())).not.toContain('art');
  });

  it('200 undo steps across rich text edits and group transforms, and redo all of them', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const states: Presentation[] = [draft()];
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(1000);
      if (i % 2 === 0) {
        const t = obj(draft(), 'tx') as TextObject;
        // A typo fix inside the bold word: its run follows the edit.
        actions.typeText('tx', `${t.text.slice(0, 3)}${i % 10}${t.text.slice(4)}`, 4);
      } else {
        selectObjects(['sh', 'tx'], 'tx');
        const from = groupBox(currentObjects())!;
        actions.transformSelection(from, { ...from, x: from.x + 3, w: from.w * (i % 4 === 1 ? 1.01 : 0.99) });
      }
      expect(draft()).not.toBe(states[states.length - 1]);
      states.push(draft());
    }
    const end = draft();
    for (let i = 199; i >= 0; i--) {
      undo();
      expect(draft()).toBe(states[i]);
    }
    expect(useEditor.getState().canUndo).toBe(false);
    expect((obj(draft(), 'tx') as TextObject).runs).toEqual(pairText().runs);
    for (let i = 0; i < 200; i++) redo();
    expect(draft()).toBe(end);
    // The 201st step forgets the first.
    vi.advanceTimersByTime(1000);
    selectObjects(['pic']);
    actions.moveSelection(1, 1);
    for (let i = 0; i < 200; i++) undo();
    expect(draft()).toBe(states[1]);
  });
});

// ---- the Object panel ------------------------------------------------------------------------------

const noop = () => undefined;
/** Markup as text: tags removed, entities decoded, spaces collapsed. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
const inputs = (html: string) => html.match(/<(input|select|textarea|button)\b[^>]*>/g) ?? [];

describe('the Object panel on a selection', () => {
  it('names objects by kind and text', () => {
    expect(objectLabel(pairText())).toBe('Text “Coffee after the service”');
    expect(objectLabel({ ...pairText(), text: '  ' })).toBe('Text (empty)');
    expect(objectLabel(pairShape())).toBe('Shape (rectangle)');
    expect(objectLabel(art())).toBe('PowerPoint art');
    expect(objectLabel(photo())).toBe('Picture');
  });

  it('the group note: what moves together, Select one (Alt-click), Ungroup', () => {
    const html = renderToStaticMarkup(
      createElement(GroupNoteView, {
        primary: pairText(),
        selected: [pairShape(), pairText()],
        group: [pairShape(), pairText()],
        readOnly: false,
        onSelectOne: noop,
        onSelectGroup: noop,
        onUngroup: noop,
      }),
    );
    expect(text(html)).toContain('2 objects selected, a group from PowerPoint');
    expect(text(html)).toContain('Alt-click an object (a long press on touch)');
    expect(html).toMatch(/<label class="field"><span>Select one<\/span><select/);
    expect(html).toContain('<option value="tx" selected="">Text “Coffee after the service”</option>');
    expect(inputs(html).find((b) => b.startsWith('<button'))).not.toContain('disabled');
    expect(text(html)).toContain('Ungroup');
  });

  it('a member selected alone can take its group back; nothing for an object on its own', () => {
    const one = renderToStaticMarkup(
      createElement(GroupNoteView, {
        primary: pairText(),
        selected: [pairText()],
        group: [pairShape(), pairText()],
        readOnly: true,
        onSelectOne: noop,
        onSelectGroup: noop,
        onUngroup: noop,
      }),
    );
    expect(text(one)).toContain('one of a group of 2 objects');
    expect(text(one)).toContain('Select the group');
    expect(inputs(one)[1]).toContain('disabled');
    const gathered = renderToStaticMarkup(
      createElement(GroupNoteView, {
        primary: photo(),
        selected: [photo(), art()],
        group: [photo()],
        readOnly: false,
        onSelectOne: noop,
        onSelectGroup: noop,
        onUngroup: noop,
      }),
    );
    expect(text(gathered)).toContain('2 objects selected:');
    expect(text(gathered)).not.toContain('Ungroup');
    const alone = createElement(GroupNoteView, {
      primary: photo(),
      selected: [photo()],
      group: [photo()],
      readOnly: false,
      onSelectOne: noop,
      onSelectGroup: noop,
      onUngroup: noop,
    });
    expect(renderToStaticMarkup(alone)).toBe('');
  });

  it("the box editors: a locked object's has no Rotation, art keeps its aspect, a group's has Turn by", () => {
    const free = renderToStaticMarkup(
      createElement(ObjectBoxView, { o: photo(), readOnly: false, onChange: noop }),
    );
    expect(text(free)).toContain('Rotation');
    const locked = renderToStaticMarkup(
      createElement(ObjectBoxView, { o: art(), readOnly: false, onChange: noop }),
    );
    expect(text(locked)).not.toContain('Rotation');
    expect(locked).not.toContain('disabled');
    expect(withAspect(B(0, 0, 600, 300), B(0, 0, 300, 300))).toEqual(B(0, 0, 300, 150));
    expect(withAspect(B(0, 0, 600, 300), B(0, 0, 600, 600))).toEqual(B(0, 0, 1200, 600));
    expect(withAspect(B(0, 0, 600, 300), B(9, 9, 600, 300))).toEqual(B(9, 9, 600, 300));
    const group = renderToStaticMarkup(
      createElement(GroupBoxView, {
        box: B(10, 20, 300, 400),
        canTurn: true,
        readOnly: false,
        onChange: noop,
      }),
    );
    expect(text(group)).toContain('Turn by');
    expect(text(group)).not.toContain('Rotation');
    expect(group).toContain('value="300"');
    const noTurn = renderToStaticMarkup(
      createElement(GroupBoxView, {
        box: B(10, 20, 300, 400),
        canTurn: false,
        readOnly: true,
        onChange: noop,
      }),
    );
    expect(text(noTurn)).not.toContain('Turn by');
    expect(noTurn).toMatch(/^<fieldset disabled=""/);
  });

  it("a locked object: 'From PowerPoint (not editable)', its box editable, every other field read-only", () => {
    expect(renderToStaticMarkup(createElement(LockedNote, { o: photo() }))).toBe('');
    const html = renderToStaticMarkup(createElement(ObjectPanel, { o: art(), readOnly: false }));
    expect(text(html)).toContain('From PowerPoint (not editable)');
    expect(text(html)).toContain('it keeps its shape');
    // The box: X, Y, W, H editable, no Rotation; Opacity and the picture section disabled.
    const box = html.slice(html.indexOf('Position and size'), html.indexOf('Opacity'));
    expect(text(box)).not.toContain('Rotation');
    expect(inputs(box)).toHaveLength(4);
    for (const i of inputs(box)) expect(i).not.toContain('disabled');
    const rest = html.slice(html.indexOf('Opacity'));
    expect(rest.match(/<fieldset[^>]*disabled=""/)).not.toBeNull();
    expect(inputs(rest)[0]).toContain('disabled');
  });

  it('an object that is not locked: no badge, its text, style and box all editable', () => {
    // (Rendered to markup, the panel sees the store as it starts: no selection, so no group note. The
    // note and the group box are rendered above through their views, and in e2e/editor-group.spec.ts.)
    const html = renderToStaticMarkup(createElement(ObjectPanel, { o: pairText(), readOnly: false }));
    expect(text(html)).not.toContain('From PowerPoint (not editable)');
    expect(html).not.toContain('data-group-note');
    expect(html.match(/<textarea[^>]*>/)![0]).not.toContain('disabled');
    expect(text(html)).toContain('Rotation');
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(inputs(html).filter((i) => i.includes('disabled'))).toEqual([]);
    // The live lock still makes everything read-only, the box included.
    const live = renderToStaticMarkup(createElement(ObjectPanel, { o: pairText(), readOnly: true }));
    expect(live.match(/<textarea[^>]*>/)![0]).toContain('disabled');
    expect(live).toMatch(/<fieldset disabled=""/);
  });
});
