/**
 * Picture ops and the crop geometry (M4 item D; design/27 §11 item 6 "Pictures", §14 item 9): setCrop,
 * setMask, setFlip and replacePicture as pure ops, wired as one undo step each; the crop fields' sides as
 * seen on the slide; the canvas handles' frame, which moves and scales the picture behind its box without
 * distorting it; and the Object panel's crop controls.
 */
import { type ImageObject, ImageObject as ImageObjectSchema, type Presentation } from '@ordo/domain';
import fc from 'fast-check';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import * as actions from '../src/views/editor/actions.ts';
import { CropControlView, endCrop, startCrop, useCropMode } from '../src/views/editor/CropControl.tsx';
import {
  cropForFrame,
  dragFrame,
  HANDLES,
  handlePoint,
  isDistorted,
  mirrorFrame,
  pictureFrame,
  sideMax,
  visualCrop,
  withVisualSide,
} from '../src/views/editor/cropGeometry.ts';
import { openPresentation, redo, selectSlide, undo, useEditor } from '../src/views/editor/editorStore.ts';
import { getSlide } from '../src/views/editor/ops.ts';
import {
  coverCrop,
  legacyRadius,
  MIN_CROP_KEEP,
  normalizeCrop,
  replacePicture,
  roundCorner,
  sameCrop,
  setCrop,
  setFlip,
  setMask,
} from '../src/views/editor/ops/pictures.ts';

const box = { x: 1000, y: 100, w: 800, h: 450, rotation: 0 };
const photo = (extra: Partial<ImageObject> = {}): ImageObject => ({
  id: 'i1',
  type: 'image',
  box,
  mediaId: 'photo',
  fit: 'stretch',
  opacity: 1,
  radius: 0,
  ...extra,
});

/** The aspect a picture of `size` shows at in `o`'s box: 1 is undistorted. */
function distortion(o: ImageObject, size: { width: number; height: number }): number {
  const c = o.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const shown = (size.width * (1 - c.l - c.r)) / (size.height * (1 - c.t - c.b));
  return shown / (o.box.w / o.box.h);
}

describe('setCrop', () => {
  it('sets the shares while the box stays, and removes a crop of zeros', () => {
    const o = photo();
    const c = setCrop(o, { l: 0.1, t: 0, r: 0.2, b: 0.05 });
    expect(c).toEqual({ ...o, crop: { l: 0.1, t: 0, r: 0.2, b: 0.05 } });
    expect(c.box).toBe(o.box);
    expect(setCrop(c, undefined)).toEqual(o);
    expect(setCrop(c, { l: 0, t: 0, r: 0, b: 0 })).not.toHaveProperty('crop');
  });

  it('returns the object itself when nothing changes', () => {
    const o = photo({ crop: { l: 0.123456789, t: 0, r: 0, b: 0 } });
    expect(setCrop(o, { l: 0.1234568, t: 0, r: 0, b: 0 })).toBe(o);
    expect(setCrop(photo(), undefined)).toEqual(photo());
    const plain = photo();
    expect(setCrop(plain, undefined)).toBe(plain);
    const locked = photo({ locked: true });
    expect(setCrop(locked, { l: 0.5, t: 0, r: 0, b: 0 })).toBe(locked);
  });

  it('keeps a share of each axis and every share inside -1..1', () => {
    expect(normalizeCrop({ l: 0.7, t: -3, r: 0.6, b: Number.NaN })).toEqual({
      l: 0.533077,
      t: -1,
      r: 0.456923,
      b: 0,
    });
    fc.assert(
      fc.property(
        fc.record({
          l: fc.double({ min: -2, max: 2, noNaN: false }),
          t: fc.double({ min: -2, max: 2 }),
          r: fc.double({ min: -2, max: 2 }),
          b: fc.double({ min: -2, max: 2 }),
        }),
        (crop) => {
          const out = normalizeCrop(crop);
          if (!out) return;
          for (const v of [out.l, out.t, out.r, out.b]) expect(Math.abs(v)).toBeLessThanOrEqual(1);
          expect(1 - out.l - out.r).toBeGreaterThanOrEqual(MIN_CROP_KEEP - 2e-6);
          expect(1 - out.t - out.b).toBeGreaterThanOrEqual(MIN_CROP_KEEP - 2e-6);
          // What the ops store is valid for the schema and stable.
          expect(ImageObjectSchema.safeParse(photo({ crop: out })).success).toBe(true);
          expect(normalizeCrop(out)).toEqual(out);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('setMask', () => {
  it('sets an ellipse or a rounded rect, keeping the legacy radius', () => {
    const o = photo({ radius: 12 });
    expect(setMask(o, { preset: 'ellipse' })).toEqual({ ...o, mask: { preset: 'ellipse' } });
    expect(setMask(o, { preset: 'roundRect', adj: [['adj', 80_000]] }).mask).toEqual({
      preset: 'roundRect',
      adj: [['adj', 50_000]],
    });
    expect(setMask(o, { preset: 'roundRect', adj: [['other', 5]] }).mask).toEqual({ preset: 'roundRect' });
    const m = setMask(o, { preset: 'ellipse' });
    expect(setMask(m, { preset: 'ellipse' })).toBe(m);
    expect(setMask(o, undefined)).toBe(o);
    expect(setMask(o, { preset: 'star5' } as never)).toBe(o);
    expect(setMask(photo({ locked: true }), { preset: 'ellipse' })).toEqual(photo({ locked: true }));
  });

  it('removes a mask; a radius that only stood in for it goes too', () => {
    const own = photo({ radius: 12, mask: { preset: 'ellipse' } });
    expect(setMask(own, undefined)).toEqual(photo({ radius: 12 }));
    // The importer's stand-ins: half the shorter side for an ellipse, the corner for a rounded rect.
    const ell = photo({ radius: 225, mask: { preset: 'ellipse' } });
    expect(legacyRadius(ell)).toBe(225);
    expect(setMask(ell, undefined)).toEqual(photo());
    const rr = photo({ radius: 135, mask: { preset: 'roundRect', adj: [['adj', 30_000]] } });
    expect(roundCorner(rr)).toBe(30_000);
    expect(setMask(rr, undefined)).toEqual(photo());
    expect(roundCorner(photo({ mask: { preset: 'roundRect' } }))).toBe(16_667);
    expect(roundCorner(photo())).toBeUndefined();
  });
});

describe('setFlip', () => {
  it('sets and removes each flip; box, crop and mask stay', () => {
    const o = photo({ crop: { l: 0.2, t: 0, r: 0, b: 0 }, mask: { preset: 'ellipse' } });
    const h = setFlip(o, { flipH: true });
    expect(h).toEqual({ ...o, flipH: true });
    expect(setFlip(h, { flipH: true })).toBe(h);
    expect(setFlip(h, { flipV: true })).toEqual({ ...o, flipH: true, flipV: true });
    expect(setFlip(h, { flipH: false })).toEqual(o);
    expect(setFlip(o, {})).toBe(o);
    expect(setFlip(o, { flipV: false })).toBe(o);
    expect(setFlip(photo({ locked: true }), { flipH: true })).toEqual(photo({ locked: true }));
  });

  it('flipping twice gives the picture back', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), fc.boolean(), (h0, v0, h, v) => {
        const o = photo({ ...(h0 ? { flipH: true } : {}), ...(v0 ? { flipV: true } : {}) });
        const once = setFlip(o, { flipH: h !== h0, flipV: v !== v0 });
        const back = setFlip(once, { flipH: h0, flipV: v0 });
        expect(back).toEqual(o);
      }),
    );
  });
});

describe('replacePicture (design/27 §11 item 6)', () => {
  it('cover-crops a stretched picture of another aspect to the box, centred where the old crop was', () => {
    // A 16:9 box showing the right half of a picture; the new one is square.
    const o = photo({ crop: { l: 0.5, t: 0, r: 0, b: 0 } });
    const r = replacePicture(o, { id: 'square', width: 1000, height: 1000 });
    expect(r.mediaId).toBe('square');
    expect(r.box).toBe(o.box);
    // Full width, 9/16 of the height; the old centre (y 0.5) is the picture's middle.
    expect(r.crop!.l).toBe(0);
    expect(r.crop!.r).toBe(0);
    expect(r.crop!.t).toBeCloseTo((1 - 9 / 16) / 2, 5);
    expect(distortion(r, { width: 1000, height: 1000 })).toBeCloseTo(1, 4);
    // A wide picture: the crop's centre x is 0.75, kept inside the picture.
    const wide = replacePicture(o, { id: 'pano', width: 4000, height: 1000 });
    const keep = 16 / 9 / 4;
    expect(wide.crop!.l).toBeCloseTo(0.75 - keep / 2, 5);
    expect(wide.crop!.t).toBe(0);
    const edge = replacePicture(photo({ crop: { l: 0.9, t: 0, r: 0, b: 0 } }), {
      id: 'pano',
      width: 4000,
      height: 1000,
    });
    expect(edge.crop!.r).toBe(0);
  });

  it('keeps box, mask, flips, opacity, radius, the clip and origin', () => {
    const o = photo({
      crop: { l: 0.1, t: 0.1, r: 0.1, b: 0.1 },
      mask: { preset: 'ellipse' },
      flipH: true,
      opacity: 0.7,
      radius: 9,
      play: { mediaId: 'clip', loop: true },
      origin: { src: 'pptx', shapeId: 4, role: 'poster' },
    });
    const { crop: _c, mediaId: _m, ...rest } = replacePicture(o, { id: 'n', width: 300, height: 200 });
    const { crop: _c2, mediaId: _m2, ...before } = o;
    expect(rest).toEqual(before);
  });

  it('drops the crop of a contained or covered picture and keeps its fit', () => {
    for (const fit of ['contain', 'cover'] as const) {
      const r = replacePicture(photo({ fit, crop: { l: 0.3, t: 0, r: 0, b: 0 } }), {
        id: 'n',
        width: 100,
        height: 900,
      });
      expect(r).toEqual(photo({ fit, mediaId: 'n' }));
    }
  });

  it('covers the box with a picture of unknown size (never stretched), and takes the same picture back as itself', () => {
    // An upload the hub has not read yet: no crop can be worked out, so it covers the box instead of being
    // stretched over it.
    expect(replacePicture(photo({ crop: { l: 0.2, t: 0, r: 0, b: 0 } }), { id: 'n' })).toEqual(
      photo({ mediaId: 'n', fit: 'cover' }),
    );
    const unknown = photo({ crop: { l: 0.2, t: 0, r: 0, b: 0 } });
    expect(replacePicture(unknown, { id: 'photo' })).toBe(unknown);
    // A contained or covered picture keeps its fit either way.
    expect(replacePicture(photo({ fit: 'contain' }), { id: 'n' })).toEqual(
      photo({ fit: 'contain', mediaId: 'n' }),
    );
    const same = photo({ crop: { l: 0.25, t: 0, r: 0.25, b: 0 } });
    // Its crop already shows 800x450 of a 1600x450 picture: nothing changes.
    expect(replacePicture(same, { id: 'photo', width: 1600, height: 450 })).toBe(same);
    expect(replacePicture(photo({ locked: true }), { id: 'n' })).toEqual(photo({ locked: true }));
  });

  it('never distorts, whatever the aspects and the old crop (10,000 cases)', () => {
    const shareArb = fc.double({ min: -0.5, max: 0.45, noNaN: true });
    fc.assert(
      fc.property(
        fc.integer({ min: 20, max: 3000 }),
        fc.integer({ min: 20, max: 3000 }),
        fc.integer({ min: 1, max: 8000 }),
        fc.integer({ min: 1, max: 8000 }),
        fc.record({ l: shareArb, t: shareArb, r: shareArb, b: shareArb }),
        fc.boolean(),
        (bw, bh, pw, ph, crop, cropped) => {
          const o = photo({ box: { x: 0, y: 0, w: bw, h: bh, rotation: 0 }, ...(cropped ? { crop } : {}) });
          const size = { width: pw, height: ph };
          const r = replacePicture(o, { id: 'n', ...size });
          // Undistorted while the part shown keeps the least share a crop keeps (a 100:1 mismatch).
          const mismatch = Math.max((pw / ph) * (bh / bw), (ph / pw) * (bw / bh));
          if (mismatch <= 1 / MIN_CROP_KEEP) expect(Math.abs(distortion(r, size) - 1)).toBeLessThan(2e-4);
          else {
            const k = r.crop!;
            expect(Math.min(1 - k.l - k.r, 1 - k.t - k.b)).toBeCloseTo(MIN_CROP_KEEP, 5);
          }
          const c = r.crop ?? { l: 0, t: 0, r: 0, b: 0 };
          // Inside the picture (cover, no padding) and the largest such part: one axis is whole.
          for (const v of [c.l, c.t, c.r, c.b]) expect(v).toBeGreaterThanOrEqual(0);
          expect(Math.min(c.l + c.r, c.t + c.b)).toBeLessThan(1e-5);
          expect(r.box).toBe(o.box);
        },
      ),
      { numRuns: 10_000 },
    );
  });

  it('coverCrop is undefined when the whole picture fits', () => {
    expect(coverCrop(photo(), { width: 1600, height: 900 })).toBeUndefined();
    expect(coverCrop(photo(), {})).toBeUndefined();
    expect(sameCrop(undefined, { l: 0, t: 0, r: 0, b: 0 })).toBe(true);
  });
});

describe('the crop fields name the sides seen on the slide', () => {
  it('swaps the source sides of a mirrored picture', () => {
    const o = photo({ crop: { l: 0.1, t: 0.2, r: 0.3, b: 0.05 } });
    expect(visualCrop(o)).toEqual({ left: 0.1, top: 0.2, right: 0.3, bottom: 0.05 });
    expect(visualCrop({ ...o, flipH: true, flipV: true })).toEqual({
      left: 0.3,
      top: 0.05,
      right: 0.1,
      bottom: 0.2,
    });
    expect(withVisualSide({ ...o, flipH: true }, 'left', 0.25)).toEqual({ l: 0.1, t: 0.2, r: 0.25, b: 0.05 });
  });

  it('keeps the opposite side a share of the picture', () => {
    const o = photo({ crop: { l: 0.6, t: 0, r: 0, b: 0 } });
    expect(sideMax(o, 'right')).toBeCloseTo(0.39);
    expect(withVisualSide(o, 'right', 0.9)!.r).toBeCloseTo(0.39);
    expect(withVisualSide(o, 'left', 0)).toBeUndefined();
    expect(withVisualSide(o, 'top', -5)!.t).toBe(-1);
  });
});

describe('the canvas crop frame', () => {
  const size = { width: 1600, height: 900 };

  it('lies where drawImageFit draws the whole picture, for every fit', () => {
    expect(pictureFrame(photo(), size)).toEqual({ x: 0, y: 0, w: 800, h: 450 });
    const cut = photo({ crop: { l: 0.25, t: 0, r: 0.25, b: 0 } });
    // Half the width stretched over the box: the whole picture is twice the box wide.
    expect(pictureFrame(cut, size)).toEqual({ x: -400, y: 0, w: 1600, h: 450 });
    // Contained: the half is 800x900 px, fitted 400x450 in the middle of the box.
    const f = pictureFrame({ ...cut, fit: 'contain' }, size);
    expect(f).toEqual({ x: 200 - 200, y: 0, w: 800, h: 450 });
    expect(mirrorFrame({ ...cut, flipH: true }, { x: -400, y: 0, w: 1000, h: 450 })).toEqual({
      x: 200,
      y: 0,
      w: 1000,
      h: 450,
    });
  });

  it('gives back the crop it was made from', () => {
    const shareArb = fc.double({ min: -0.4, max: 0.4, noNaN: true });
    fc.assert(
      fc.property(fc.record({ l: shareArb, t: shareArb, r: shareArb, b: shareArb }), (crop) => {
        const o = photo({ crop });
        const back = cropForFrame(o, pictureFrame(o, size));
        expect(back).toBeDefined();
        expect(sameCrop(back!.crop, normalizeCrop(crop))).toBe(true);
      }),
      { numRuns: 2000 },
    );
    expect(cropForFrame(photo(), { x: 0, y: 0, w: 800, h: 450 })).toEqual({ crop: undefined });
    // Past the bounds: the picture moved more than its own width away, or smaller than the box.
    expect(cropForFrame(photo(), { x: 900, y: 0, w: 800, h: 450 })).toBeUndefined();
  });

  it('scales the picture at its aspect about the opposite corner or side, and moves it', () => {
    const f = { x: -100, y: -50, w: 1000, h: 562.5 };
    const k = f.w / f.h;
    for (const h of HANDLES) {
      const p = handlePoint(f, h);
      const out = dragFrame(f, h, { x: p.x + 37, y: p.y - 23 });
      expect(out.w / out.h).toBeCloseTo(k, 9);
    }
    // The south-east corner pulled out: the north-west corner stays.
    const se = dragFrame(f, 'se', { x: 1100, y: 512.5 });
    expect(se).toMatchObject({ x: -100, y: -50 });
    expect(se.w).toBeCloseTo(1200);
    // The west side: the east side's midpoint stays.
    const w = dragFrame(f, 'w', { x: -300, y: 0 });
    expect(w.x + w.w).toBeCloseTo(900);
    expect(w.y + w.h / 2).toBeCloseTo(f.y + f.h / 2);
    // Never inside out or smaller than a few pixels.
    expect(dragFrame(f, 'e', { x: -5000, y: 0 }).w).toBeGreaterThan(0);
  });

  it('a handle drag never distorts a picture that was not distorted (any fit)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('stretch', 'contain', 'cover'),
        fc.constantFrom(...HANDLES),
        fc.double({ min: -300, max: 300, noNaN: true }),
        fc.double({ min: -300, max: 300, noNaN: true }),
        fc.boolean(),
        (fit, handle, dx, dy, flipH) => {
          const o = photo({ fit, ...(flipH ? { flipH: true } : {}) });
          const seen = mirrorFrame(o, pictureFrame(o, size));
          const p = handlePoint(seen, handle);
          const r = cropForFrame(o, mirrorFrame(o, dragFrame(seen, handle, { x: p.x + dx, y: p.y + dy })));
          if (!r) return;
          const next = setCrop(o, r.crop);
          expect(Math.abs(distortion(next, size) - 1)).toBeLessThan(1e-3);
          // And the picture lands where the frame said.
          const again = pictureFrame(next, size);
          const want = mirrorFrame(o, dragFrame(seen, handle, { x: p.x + dx, y: p.y + dy }));
          expect(again.w).toBeCloseTo(want.w, 1);
          expect(again.x).toBeCloseTo(want.x, 1);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('tells a stretched picture out of its proportions', () => {
    expect(isDistorted(photo(), size)).toBe(false);
    expect(isDistorted(photo({ crop: { l: 0.2, t: 0, r: 0, b: 0 } }), size)).toBe(true);
    expect(isDistorted(photo({ fit: 'cover', crop: { l: 0.2, t: 0, r: 0, b: 0 } }), size)).toBe(false);
    expect(isDistorted(photo({ crop: { l: 0.2, t: 0, r: 0, b: 0 } }), {})).toBe(false);
  });
});

const deck = (o: ImageObject = photo()): Presentation => ({
  id: 'p1',
  rev: 3,
  title: 'Photos',
  kind: 'slides',
  meta: { tags: [] },
  sections: [{ id: 'sec', label: 'Main', short: 'M', slides: [{ id: 's1', objects: [o] }] }],
  arrangements: [{ id: 'a', name: 'Default', sectionIds: ['sec'] }],
  archived: false,
});
const current = () => getSlide(useEditor.getState().draft!, 's1')!.objects[0] as ImageObject;

describe('the picture actions (one undo step each, saved with the presentation)', () => {
  beforeEach(() => {
    openPresentation(deck());
    selectSlide('s1');
  });

  it('crops, masks, flips and replaces through change()', () => {
    actions.cropPicture('i1', { l: 0.1, t: 0, r: 0, b: 0 });
    actions.maskPicture('i1', { preset: 'ellipse' });
    actions.flipPicture('i1', { flipV: true });
    actions.replacePictureWith('i1', { id: 'square', width: 500, height: 500 });
    expect(current()).toMatchObject({ mediaId: 'square', flipV: true, mask: { preset: 'ellipse' } });
    expect(useEditor.getState().dirty).toBe(true);
    undo();
    expect(current().mediaId).toBe('photo');
    undo();
    expect(current()).not.toHaveProperty('flipV');
    undo();
    expect(current()).not.toHaveProperty('mask');
    undo();
    expect(current()).toEqual(photo());
    expect(useEditor.getState().canUndo).toBe(false);
    redo();
    expect(current().crop).toEqual({ l: 0.1, t: 0, r: 0, b: 0 });
  });

  it('coalesces a crop drag into one step, and records nothing for no change', () => {
    for (let i = 1; i <= 20; i++) actions.cropPicture('i1', { l: i / 100, t: 0, r: 0, b: 0 });
    expect(current().crop!.l).toBe(0.2);
    undo();
    expect(current()).toEqual(photo());
    expect(useEditor.getState().canUndo).toBe(false);
    const before = useEditor.getState().draft;
    actions.flipPicture('i1', { flipH: false });
    actions.maskPicture('i1', undefined);
    actions.cropPicture('i1', undefined);
    expect(useEditor.getState().draft).toBe(before);
  });

  it('leaves a locked picture (art) alone', () => {
    openPresentation(deck(photo({ locked: true })));
    selectSlide('s1');
    actions.cropPicture('i1', { l: 0.1, t: 0, r: 0, b: 0 });
    actions.flipPicture('i1', { flipH: true });
    actions.replacePictureWith('i1', { id: 'n' });
    expect(useEditor.getState().dirty).toBe(false);
  });
});

describe('the crop controls (Object panel)', () => {
  const noop = () => undefined;
  const view = (o: ImageObject, more: Partial<Parameters<typeof CropControlView>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(CropControlView, {
        o,
        readOnly: false,
        cropping: false,
        onCrop: noop,
        onMask: noop,
        onFlip: noop,
        onCropMode: noop,
        ...more,
      }),
    );
  const inputs = (html: string) => html.match(/<input[^>]*>/g) ?? [];

  it('shows the four shares as labelled percentages, Reset crop and Crop on the slide', () => {
    const html = view(photo({ crop: { l: 0.125, t: 0, r: 0.25, b: 0.05 }, flipH: true }));
    for (const label of ['Left', 'Right', 'Top', 'Bottom']) expect(html).toContain(`<span>${label}</span>`);
    const numbers = inputs(html).filter((i) => i.includes('type="number"'));
    expect(numbers.map((i) => i.match(/value="([^"]*)"/)![1])).toEqual(['25', '12.5', '0', '5']);
    expect(html).toContain('<legend');
    expect(html).toMatch(/<button[^>]*>Reset crop<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Crop on the slide<\/button>/);
    expect(view(photo(), { cropping: true })).toMatch(/aria-pressed="true"[^>]*>Crop on the slide/);
    expect(view(photo())).toMatch(/<button[^>]*disabled=""[^>]*>Reset crop/);
  });

  it('offers the mask as a radio group and the flips as toggles', () => {
    const html = view(photo({ mask: { preset: 'roundRect', adj: [['adj', 25_000]] }, flipV: true }));
    expect(html).toContain('role="radiogroup"');
    const radios = inputs(html).filter((i) => i.includes('type="radio"'));
    expect(radios).toHaveLength(3);
    expect(radios[2]).toContain('checked');
    expect(html).toContain('Corner size');
    expect(html).toMatch(/aria-pressed="false"[^>]*>Flip horizontal/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Flip vertical/);
    expect(view(photo())).not.toContain('Corner size');
    expect(inputs(view(photo())).filter((i) => i.includes('type="radio"'))[0]).toContain('checked');
    // A PowerPoint geometry the editor does not offer checks no choice; any of them replaces it.
    const other = inputs(view(photo({ mask: { preset: 'star5' } }))).filter((i) =>
      i.includes('type="radio"'),
    );
    for (const r of other) expect(r).not.toContain('checked');
  });

  it('offers Keep proportions for a stretched picture out of its proportions', () => {
    const o = photo({ crop: { l: 0.3, t: 0, r: 0, b: 0 } });
    expect(view(o, { size: { width: 1600, height: 900 } })).toContain('Keep proportions');
    expect(view(o)).not.toContain('Keep proportions');
    expect(view(photo(), { size: { width: 1600, height: 900 } })).not.toContain('Keep proportions');
  });

  it('is read-only while the presentation is locked and on locked art', () => {
    for (const html of [view(photo(), { readOnly: true }), view(photo({ locked: true }))]) {
      for (const i of inputs(html)) expect(i).toContain('disabled');
      for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toContain('disabled');
    }
  });

  it('crop mode names one picture at a time', () => {
    startCrop('i1');
    expect(useCropMode.getState().objectId).toBe('i1');
    startCrop('i2');
    expect(useCropMode.getState().objectId).toBe('i2');
    endCrop();
    expect(useCropMode.getState().objectId).toBeUndefined();
  });
});
