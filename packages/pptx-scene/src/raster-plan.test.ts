import { describe, expect, it } from 'vitest';
import { decorRuns } from './decor.ts';
import type { Element, ShapeElement } from './ir.ts';
import {
  RASTER_CANDIDATES_MAX,
  RASTER_MAX_PICTURES,
  RASTER_MAY_HOLD,
  RASTER_READ,
  RASTER_RUN,
  RASTER_WORDS_MAX,
} from './raster.ts';
import {
  applyRasterForm,
  applyUnclaimedForms,
  type RasterElement,
  type RasterPlan,
  type RasterPlanOptions,
  planRasters,
  rasterFormOf,
} from './raster-plan.ts';
import {
  asElements,
  builtCustom,
  candEl,
  custNode,
  FRAME,
  IN,
  pictureEl,
  resetIds,
  row,
  shapeEl,
  smallEl,
  textBody,
} from './raster.test-util.ts';

const run = (els: readonly (RasterElement | Element)[], o: Partial<RasterPlanOptions> = {}): RasterPlan =>
  planRasters(asElements(els), undefined, FRAME, { maker: 'page', ...o });

/** The member indexes of each run. */
const members = (p: RasterPlan) => p.runs.map((r) => r.members.map((m) => m.index));

const marked = (els: readonly RasterElement[]) => els.map((e) => e.raster);

describe('planRasters: the runs (R2, C-SR3)', () => {
  it("strict neighbours are one run; the picture goes where the run's lowest member is", () => {
    resetIds();
    const els = [shapeEl(), ...row(3, 2), shapeEl({ box: [8, 6, 0.3, 0.3] })];
    const p = run(els);
    expect(members(p)).toEqual([[1, 2, 3]]);
    const r = p.runs[0]!;
    expect(r.first).toBe(1);
    expect(r.candidates).toBe(3);
    expect(p.candidates).toBe(3);
    expect(p.shapes).toBe(3);
    // The marks: the index of the run's first element on each member, on nothing else.
    expect(marked(els as RasterElement[])).toEqual([undefined, 1, 1, 1, undefined]);
  });

  it('small shapes between two candidates are drawn into the run; leading and trailing ones are not', () => {
    resetIds();
    const els = [
      smallEl({ box: [0.2, 1, 0.3, 0.3] }),
      candEl({ box: [0.6, 1, 0.4, 0.4] }),
      smallEl({ box: [1.1, 1, 0.3, 0.3] }),
      smallEl({ box: [1.5, 1, 0.3, 0.3] }),
      candEl({ box: [1.9, 1, 0.4, 0.4] }),
      smallEl({ box: [2.4, 1, 0.3, 0.3] }),
    ];
    const p = run(els);
    expect(members(p)).toEqual([[1, 2, 3, 4]]);
    expect(p.runs[0]!.candidates).toBe(2);
    expect(p.shapes).toBe(4);
    expect(marked(els)).toEqual([undefined, 1, 1, 1, 1, undefined]);
  });

  it('a text box a LATER member lies over is drawn in; one nothing covers stays live text above the picture (the exact z-order rule)', () => {
    resetIds();
    const overlapping = shapeEl({ box: [0.5, 1, 0.5, 0.5], text: textBody('Gulf'), fill: { kind: 'none' } });
    const apart = shapeEl({ box: [6, 5, 1, 0.4], text: textBody('Legend'), fill: { kind: 'none' } });
    const els = [
      candEl({ box: [0.2, 1, 0.5, 0.5] }),
      overlapping,
      apart,
      candEl({ box: [1.2, 1, 0.5, 0.5] }),
    ];
    const p = run(els);
    // The text over the first member is above it and no later member lies over it: it stays live text above the picture.
    expect(members(p)).toEqual([[0, 3]]);
    expect(p.runs[0]!.texts).toBe(0);
    expect(marked(els)).toEqual([0, undefined, undefined, 0]);
    // A later member that lies over it puts it under that member: it is drawn in, with its words.
    const covered = [
      candEl({ box: [0.2, 1, 0.5, 0.5] }),
      shapeEl({ box: [0.5, 1, 0.5, 0.5], text: textBody('Gulf'), fill: { kind: 'none' } }),
      candEl({ box: [0.7, 1, 0.5, 0.5] }),
    ];
    const q = run(covered);
    expect(members(q)).toEqual([[0, 1, 2]]);
    expect(q.runs[0]!.texts).toBe(1);
  });
  it('a picture over a member is skipped when no later member lies over it, and ends the run when one does; one that shares no area is skipped (any kind of element is)', () => {
    resetIds();
    const over = [
      candEl({ box: [1, 1, 1, 1] }),
      pictureEl({ box: [1.5, 1.5, 1, 1] }),
      candEl({ box: [4, 1, 1, 1] }),
    ];
    // Nothing later lies over the picture: it is drawn live above the picture of the run, which is still below it.
    expect(members(run(over))).toEqual([[0, 2]]);
    // A later member that lies over it would put it under that member: the run ends at the picture.
    const under = [
      candEl({ box: [1, 1, 1, 1] }),
      pictureEl({ box: [1.5, 1.5, 1, 1] }),
      candEl({ box: [2, 2, 1, 1] }),
    ];
    expect(members(run(under))).toEqual([[0], [2]]);
    // Other kinds: a shape the picture may not hold (a shadow), a text box and a picture, all clear of the run.
    const clear = [
      candEl({ box: [1, 1, 1, 1] }),
      shapeEl({
        box: [6, 4, 1, 1],
        geom: 'ellipse',
        shadow: { dist: 25_400, blur: 25_400, dir: 45, color: { r: 0, g: 0, b: 0, a: 0.4 } },
      }),
      shapeEl({ box: [6, 5, 1, 1], text: textBody('x'), fill: { kind: 'none' } }),
      pictureEl({ box: [8, 5, 1, 1] }),
      candEl({ box: [4, 1, 1, 1] }),
    ];
    expect(members(run(clear))).toEqual([[0, 4]]);
  });

  it('a TEXT-BEARING candidate is a member of a run when the maker is the page, and breaks it when the maker is not', () => {
    resetIds();
    const mk = () => [
      candEl({ box: [1, 1, 0.5, 0.5] }),
      candEl({ box: [1.2, 1, 0.8, 0.5], text: textBody('Africa') }),
      candEl({ box: [1.5, 1, 0.5, 0.5] }),
    ];
    const page = run(mk());
    expect(members(page)).toEqual([[0, 1, 2]]);
    expect(page.runs[0]!.texts).toBe(1);
    expect(page.runs[0]!.members[1]).toMatchObject({ candidate: true, text: true });
    expect(page.skipped.text).toBe(0);
    // With the maker 'pdf' (no text) the words stay as today: they cannot be skipped (they overlap), so the run ends.
    const pdf = run(mk(), { maker: 'pdf' });
    expect(members(pdf)).toEqual([[0], [2]]);
    expect(pdf.skipped.text).toBe(1);
    expect(pdf.reasons).toContain('text');
  });

  it('a group change ends a run (the scope); a different source (layout, slide) is never one picture', () => {
    resetIds();
    const g = (n: number, list: RasterElement[]) => list.map((e) => ({ ...e, group: n }));
    const els = [...g(1, row(2, 1)), ...g(2, row(2, 2))];
    const p = run(els);
    expect(members(p)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(p.runs.map((r) => r.group)).toEqual([1, 2]);
    const layered = [candEl({ from: 'layout' }), candEl({ from: 'slide', box: [3, 3, 0.5, 0.5] })];
    expect(members(run(layered, { maxPictures: 1 }))).toEqual([[1]]);
    expect(run(layered).runs.map((r) => r.from)).toEqual(['layout', 'slide']);
  });

  it('600 candidates are one run (under the run caps)', () => {
    resetIds();
    const els = row(600, 1, { gap: 0 }).map((e, k) => ({
      ...e,
      xf: [
        0.2 * IN,
        0,
        0,
        0.2 * IN,
        (k % 30) * 0.2 * IN,
        (1 + Math.floor(k / 30) * 0.2) * IN,
      ] as RasterElement['xf'],
    }));
    const p = run(els);
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]!.members).toHaveLength(600);
    expect(p.candidates).toBe(600);
  });

  it('a claimed shape past a limit is a native element again (support and the custGeom reason cleared)', () => {
    resetIds();
    const past = candEl({ limit: true });
    expect(past.support).toBe('residual');
    const refused = candEl({
      limit: true,
      box: [3, 3, 0.5, 0.5],
      shadow: { dist: 1, blur: 1, dir: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
    });
    run([past, refused]);
    expect(past.support).toBe('native');
    expect(past.reasons).toBeUndefined();
    // What stays as today is left exactly as it was.
    expect(refused.support).toBe('residual');
    expect(refused.reasons).toEqual(['custGeom']);
    expect(refused.raster).toBeUndefined();
  });

  it("the picture's rectangle is the run's union box cut to the slide and rounded outward to the 2 px grid", () => {
    resetIds();
    const p = run([candEl({ box: [1, 1, 0.5, 0.5] })]);
    expect(p.runs[0]!.rect).toEqual({ x: 144, y: 144, w: 72, h: 72 });
    // 1.003 in = 144.43 px; its far edge 216.43: out to 144 and 218.
    const q = run([candEl({ box: [1.003, 1.003, 0.5, 0.5] })]);
    expect(q.runs[0]!.rect).toEqual({ x: 144, y: 144, w: 74, h: 74 });
    // A shape that hangs over the canvas is cut to it (the screens show nothing outside).
    const cut = run([candEl({ box: [-1, -1, 2, 2] }), candEl({ box: [12.5, 6.5, 2, 2] })]);
    expect(cut.runs[0]!.rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    for (const r of cut.runs) {
      expect(r.rect.x % 2).toBe(0);
      expect(r.rect.w % 2).toBe(0);
    }
  });

  it('a run whose members all lie outside the canvas is not made', () => {
    resetIds();
    const p = run([candEl({ box: [14.5, 8, 1, 1] }), candEl({ box: [15, 8, 1, 1] })]);
    expect(p.runs).toEqual([]);
  });
});

describe('planRasters: the pictures a slide holds and the merge policy (R3)', () => {
  it('past RASTER_MAX_PICTURES neighbouring runs are merged where the skip rule allows', () => {
    resetIds();
    // Six groups side by side, no element between them: six runs by scope, merged to the cap.
    const g = (n: number) => row(2, 1 + n, {}).map((e) => ({ ...e, group: n + 1 }));
    const els = [0, 1, 2, 3, 4, 5].flatMap(g);
    const p = run(els);
    expect(p.runs.length).toBeLessThanOrEqual(RASTER_MAX_PICTURES);
    expect(p.runs.length).toBe(RASTER_MAX_PICTURES);
    // Nothing is lost by merging: every candidate is still a member, in z order.
    expect(p.runs.flatMap((r) => r.members.map((m) => m.index))).toEqual(els.map((_, i) => i));
    expect(p.runs.some((r) => r.group === undefined)).toBe(true);
    // The cap is an option (the census may raise it to 8 with the measure in the report).
    expect(run(els, { maxPictures: 1 }).runs).toHaveLength(1);
    expect(run(els, { maxPictures: 8 }).runs).toHaveLength(6);
  });

  it('runs the skip rule cannot merge are dropped, the ones with the fewest candidate points first, and said', () => {
    resetIds();
    // Six runs, each cut off from the next by a picture that the NEXT run's member lies over (the picture bridges the two): nothing
    // can merge, as the picture could not be drawn live above one run and under the other.
    const els: Element[] = [];
    const costs = [600, 200, 900, 150, 400, 300];
    costs.forEach((cost, k) => {
      const y = 0.3 + k * 1.2;
      els.push(candEl({ box: [1, y, 0.8, 0.8], cost }), pictureEl({ box: [1.2, y + 0.6, 0.4, 0.9] }));
    });
    const p = run(els);
    expect(p.runs).toHaveLength(RASTER_MAX_PICTURES);
    // The two fewest (150 and 200 points) are not made; their shapes stay as today.
    expect(p.runs.map((r) => r.points)).toEqual([600, 900, 400, 300]);
    expect(p.skipped.other).toBe(2);
    expect(p.reasons).toContain('pictures');
    expect(els.filter((e) => (e as RasterElement).raster !== undefined)).toHaveLength(4);
  });

  it("the pixels of a slide's pictures are bounded too: past them the runs with the fewest points are not made", () => {
    resetIds();
    const els: Element[] = [
      candEl({ box: [1, 1, 4, 3], cost: 900 }),
      // A picture over the first member that the second member lies over too: it cuts the run in two.
      pictureEl({ box: [4.5, 2, 2, 1] }),
      candEl({ box: [6, 1, 4, 3], cost: 300 }),
    ];
    // Each picture is 576 x 432 logical px = 995,328 device px: one fits under 1,500,000, two do not.
    const p = run(els, { slidePixels: 1_500_000 });
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]!.points).toBe(900);
    expect(p.reasons).toContain('pixels');
    expect(run(els).runs).toHaveLength(2);
  });
});

describe('planRasters: decor and raster never claim one shape (R4)', () => {
  it('the decoration runs, given the raster marks as excluded, never hold a member', () => {
    resetIds();
    const els = [...row(3, 1), smallEl({ box: [5, 4, 0.3, 0.3] }), smallEl({ box: [5.5, 4, 0.3, 0.3] })];
    const p = run(els);
    const claimed = new Set(p.runs.flatMap((r) => r.members.map((m) => m.index)));
    expect(claimed.size).toBe(3);
    // Left to itself the decoration rule would take the candidates (they are plain shapes with stored paths)...
    expect(
      decorRuns(asElements(els), FRAME, { wide: true })
        .flat()
        .some((i) => claimed.has(i)),
    ).toBe(true);
    // ...so the planner runs first and the decorations are told what is taken.
    for (const r of decorRuns(asElements(els), FRAME, { wide: true, exclude: claimed }))
      for (const i of r) expect(claimed.has(i)).toBe(false);
    // The planner sets no decoration mark of its own.
    expect(els.every((e) => e.decor === undefined)).toBe(true);
  });
});

describe('planRasters: what is skipped, what is included (R5)', () => {
  it('a slide of 400 shapes is one picture of 400, whatever the guard would cull later', () => {
    resetIds();
    const els = row(400, 1, { gap: 0 }).map((e, k) => ({
      ...e,
      xf: [
        0.1 * IN,
        0,
        0,
        0.1 * IN,
        (k % 40) * 0.1 * IN,
        (1 + Math.floor(k / 40) * 0.1) * IN,
      ] as RasterElement['xf'],
    }));
    const p = run(els);
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]!.members).toHaveLength(400);
    // None of them is hidden or culled yet: the planner runs before the budget steps, which then find them in the picture.
    expect(els.every((e) => e.hidden === undefined && e.culled === undefined)).toBe(true);
  });

  it('hidden, off-slide and invisible elements are skipped and do not end a run', () => {
    resetIds();
    const els: Element[] = [
      candEl({ box: [1, 1, 0.5, 0.5] }),
      candEl({ box: [2, 1, 0.5, 0.5], hidden: true }),
      candEl({ box: [30, 1, 0.5, 0.5] }),
      shapeEl({ box: [3, 1, 0.5, 0.5], fill: { kind: 'none' } }),
      pictureEl({ box: [1, 1, 0.5, 0.5], hidden: true }),
      candEl({ box: [4, 1, 0.5, 0.5] }),
    ];
    const p = run(els);
    expect(members(p)).toEqual([[0, 5]]);
    expect((els[1] as RasterElement).raster).toBeUndefined();
    expect((els[2] as RasterElement).raster).toBeUndefined();
  });

  it("a shape past the picture limits, with the shadow of the guard's cost, is still included when the guard would cull it", () => {
    resetIds();
    // The guard culls by cost after the planner runs; a candidate marked complex is not different to the planner.
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5] }),
      candEl({ box: [2, 1, 0.5, 0.5], custom: { ...builtCustom(300), complex: true } }),
    ];
    expect(members(run(els))).toEqual([[0, 1]]);
  });
});

describe('planRasters: the put-back accounting in walk order (R6, D5)', () => {
  it('every put-back form fits the slide total left: the built ones never add up past 65,536', () => {
    resetIds();
    // 40 shapes whose stored paths are 4,096 points each (5,000-point outlines cut by the converter), 20,000 points
    // already held by the shapes that stay shapes.
    const els = Array.from({ length: 40 }, (_, k) =>
      candEl({
        box: [0.2 + (k % 20) * 0.4, 1 + Math.floor(k / 20), 0.3, 0.3],
        cost: 5_000,
        todayPoints: 4_096,
      }),
    );
    const p = run(els, { pointsUsed: 20_000 });
    const built = p.forms.filter((f) => f === 'built').length;
    expect(built).toBe(11);
    expect(p.forms.slice(0, 11).every((f) => f === 'built')).toBe(true);
    expect(p.forms.slice(11).every((f) => f === 'box')).toBe(true);
    expect(20_000 + built * 4_096).toBeLessThanOrEqual(65_536);
    // The forms are on the members too.
    expect(p.runs.flatMap((r) => r.members.map((m) => m.form))).toEqual(
      p.forms.filter((f) => f !== undefined),
    );
  });

  it('a shape past a limit is a box whatever room is left; one only the slide total refused fits when there is room', () => {
    resetIds();
    const els = [
      candEl({ box: [1, 1, 0.4, 0.4], limit: true, cost: 9_000 }),
      candEl({ box: [2, 1, 0.4, 0.4], why: 'total', cost: 300 }),
    ];
    const p = run(els);
    expect(p.forms).toEqual(['box', 'built']);
  });

  it('the forms are worked out for every candidate, the pictured or not, so what stays as today stays inside the total', () => {
    resetIds();
    const els = [
      candEl({ box: [1, 1, 0.4, 0.4], cost: 900, todayPoints: 60_000 }),
      candEl({
        box: [2, 1, 0.4, 0.4],
        cost: 900,
        todayPoints: 60_000,
        shadow: { dist: 1, blur: 1, dir: 0, color: { r: 0, g: 0, b: 0, a: 1 } },
      }),
    ];
    const p = run(els);
    expect(p.runs[0]!.members.map((m) => m.index)).toEqual([0]);
    expect(p.forms).toEqual(['built', 'box']);
  });

  it('a text-bearing member has a form too (its shape and its text object put back together)', () => {
    resetIds();
    const els = [candEl({ cost: 400, text: textBody('Words') })];
    const p = run(els);
    expect(p.runs[0]!.members[0]).toMatchObject({ text: true, form: 'built' });
  });
});

describe('planRasters: determinism (R7)', () => {
  it('the same IR plans the same whatever its ids, and the maker does not change a plan without words', () => {
    resetIds(2);
    const a = [
      candEl({ box: [1, 1, 0.5, 0.5] }),
      smallEl({ box: [1.6, 1, 0.3, 0.3] }),
      candEl({ box: [2.2, 1, 0.5, 0.5] }),
    ];
    resetIds(900);
    const b = [
      candEl({ box: [1, 1, 0.5, 0.5] }),
      smallEl({ box: [1.6, 1, 0.3, 0.3] }),
      candEl({ box: [2.2, 1, 0.5, 0.5] }),
    ];
    const pa = run(a);
    const pb = run(b);
    const strip = (p: RasterPlan) =>
      p.runs.map((r) => ({
        first: r.first,
        m: r.members.map((m) => [m.index, m.candidate, m.form]),
        rect: r.rect,
        refs: r.refs.map((x) => [x.from, x.nth]),
      }));
    expect(strip(pa)).toEqual(strip(pb));
    expect(
      strip(
        run(
          a.map((e) => ({ ...e })),
          { maker: 'pdf' },
        ),
      ),
    ).toEqual(strip(pa));
  });
});

describe('planRasters: every kind and every reason (R8)', () => {
  const dark = { r: 0, g: 0, b: 0, a: 1 };
  const kinds: Record<
    string,
    {
      patch: Partial<ShapeElement>;
      bucket: 'text' | 'effects' | 'fill' | 'other';
      flip?: keyof typeof RASTER_MAY_HOLD;
    }
  > = {
    shadow: {
      patch: { shadow: { dist: 25_400, blur: 38_100, dir: 45, color: dark } },
      bucket: 'effects',
      flip: 'shadow',
    },
    glow: { patch: { glow: { radius: 63_500, color: dark } }, bucket: 'effects', flip: 'glow' },
    softEdge: { patch: { softEdge: 63_500 }, bucket: 'effects', flip: 'softEdge' },
    look3d: { patch: { look3d: { extrusionH: 12_700 } }, bucket: 'effects', flip: 'threeD' },
    'a gradient with per-stop alpha': {
      patch: {
        fill: {
          kind: 'gradient',
          stops: [
            { at: 0, color: { r: 255, g: 0, b: 0, a: 1 } },
            { at: 1, color: { r: 255, g: 0, b: 0, a: 0 } },
          ],
        },
      },
      bucket: 'fill',
      flip: 'alphaGradient',
    },
    'a picture fill': {
      patch: { fill: { kind: 'picture', picture: { part: 'ppt/media/image1.png' } } },
      bucket: 'fill',
      flip: 'pictureFill',
    },
    'a pattern fill': {
      patch: {
        fill: { kind: 'pattern', preset: 'pct50', fg: dark, bg: { r: 255, g: 255, b: 255, a: 1 } },
        support: 'approx',
        reasons: ['pattFill'],
      },
      bucket: 'fill',
      flip: 'pattern',
    },
    'another reason it is residual (vertical text)': {
      patch: { support: 'residual', reasons: ['custGeom', 'vert'] },
      bucket: 'other',
    },
  };

  for (const [name, k] of Object.entries(kinds)) {
    it(`${name}: a candidate with it stays as today and is counted as ${k.bucket}${k.flip ? '; one list decides' : ''}`, () => {
      resetIds();
      const mk = () => [candEl({ box: [1, 1, 0.5, 0.5] }), candEl({ box: [2, 1, 0.5, 0.5], ...k.patch })];
      const els = mk();
      const p = run(els);
      expect(p.skipped[k.bucket]).toBe(1);
      expect(p.skipped.text + p.skipped.effects + p.skipped.fill + p.skipped.other).toBe(1);
      expect((els[1] as RasterElement).raster).toBeUndefined();
      expect(p.candidates).toBe(2);
      // The same shape, with a TEST COPY of the list flipped for its kind, is a member: nothing else decides.
      if (k.flip) {
        const copy = { ...RASTER_MAY_HOLD, [k.flip]: true };
        const els2 = mk();
        const q = run(els2, { mayHold: copy });
        expect(q.skipped[k.bucket]).toBe(0);
        expect(members(q)).toEqual([[0, 1]]);
      }
    });
  }

  it('arrowheads on the outline and a gradient whose stops share one transparency are plain: they are drawn in', () => {
    resetIds();
    const els = [
      candEl({
        box: [1, 1, 0.5, 0.5],
        line: { width: 12_700, fill: { kind: 'solid', color: dark }, head: 'triangle', tail: 'oval' },
      }),
      candEl({
        box: [2, 1, 0.5, 0.5],
        fill: {
          kind: 'gradient',
          stops: [
            { at: 0, color: { r: 255, g: 0, b: 0, a: 0.5 } },
            { at: 1, color: { r: 0, g: 0, b: 255, a: 0.5 } },
          ],
        },
      }),
    ];
    expect(members(run(els))).toEqual([[0, 1]]);
  });

  it('text counts only when the maker is the page AND the list says so', () => {
    resetIds();
    const mk = () => [candEl({ box: [1, 1, 0.5, 0.5], text: textBody('x') })];
    expect(run(mk()).skipped.text).toBe(0);
    expect(run(mk(), { maker: 'pdf' }).skipped.text).toBe(1);
    expect(run(mk(), { mayHold: { ...RASTER_MAY_HOLD, text: false } }).skipped.text).toBe(1);
    // A maker 'pdf' never draws words, even when the list says yes.
    expect(run(mk(), { maker: 'pdf', mayHold: { ...RASTER_MAY_HOLD, text: true } }).skipped.text).toBe(1);
  });

  it('an anchored slide makes no run: every candidate stays as today, counted', () => {
    resetIds();
    const els = [...row(3, 1), smallEl({ box: [5, 4, 0.3, 0.3] })];
    const p = run(els, { anchored: true });
    expect(p.runs).toEqual([]);
    expect(p.skipped.anchored).toBe(3);
    expect(p.reasons).toContain('anchored');
    expect(marked(els as RasterElement[])).toEqual([undefined, undefined, undefined, undefined]);
    // The put-back forms are worked out all the same: they are today's output.
    expect(p.forms.filter((f) => f !== undefined)).toHaveLength(3);
  });
});

describe('planRasters: hostile input (R9)', () => {
  it('a shape past the reading bound is refused with a named reason before anything is built', () => {
    resetIds();
    // The walk counts to the bound and stops one past it: a shape of 10 million points reads as 262,145.
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: RASTER_READ.pointsShape + 1, node: custNode(5) }),
      candEl({ box: [2, 1, 0.5, 0.5] }),
    ];
    const p = run(els);
    expect(members(p)).toEqual([[1]]);
    expect(p.skipped.other).toBe(1);
    expect(p.reasons).toContain('read-bound');
  });

  it('NaN and infinite coordinates make no member and throw nothing', () => {
    resetIds();
    const bad = [Number.NaN, Number.POSITIVE_INFINITY].map((v, k) =>
      candEl({ box: [1 + k, 1, 0.5, 0.5], xf: [v, 0, 0, v, v, v] }),
    );
    // A coordinate that is finite but absurd is off the slide: left out like any element past its edge.
    const far = candEl({ box: [1, 1, 0.5, 0.5], xf: [1e300, 0, 0, 1e300, 1e300, 1e300] });
    const els = [...bad, far, candEl({ box: [5, 1, 0.5, 0.5] })];
    const p = run(els);
    expect(members(p)).toEqual([[3]]);
    expect(p.skipped.other).toBe(2);
  });

  it('every list is bounded: 5,000 candidates in a row make runs of at most the run caps, pictures at most the cap', () => {
    resetIds();
    const els = Array.from({ length: 5_000 }, (_, k) =>
      candEl({ box: [0.1 + (k % 100) * 0.1, 0.5 + Math.floor(k / 100) * 0.1, 0.09, 0.09], cost: 200 }),
    );
    const p = run(els);
    expect(p.runs.length).toBeLessThanOrEqual(RASTER_MAX_PICTURES);
    for (const r of p.runs) {
      expect(r.members.length).toBeLessThanOrEqual(RASTER_RUN.members);
      expect(r.refs.length).toBeLessThanOrEqual(RASTER_RUN.members);
      expect(r.points).toBeLessThanOrEqual(RASTER_RUN.points);
    }
    expect(p.runs.map((r) => r.members.length)).toEqual([2_048, 2_048, 904]);
    expect(p.reasons.length).toBeLessThanOrEqual(32);
  });

  it('past RASTER_CANDIDATES_MAX candidates the rest stay as today, named', () => {
    resetIds();
    const n = RASTER_CANDIDATES_MAX + 50;
    const els = Array.from({ length: n }, (_, k) =>
      candEl({ box: [0.1 + (k % 200) * 0.05, 0.5 + Math.floor(k / 200) * 0.05, 0.04, 0.04], cost: 200 }),
    );
    const p = run(els);
    const claimed = p.runs.reduce((a, r) => a + r.candidates, 0);
    expect(claimed).toBeLessThanOrEqual(RASTER_CANDIDATES_MAX);
    expect(p.skipped.other).toBeGreaterThanOrEqual(50);
    expect(p.reasons).toContain('candidates');
  });

  it('a shape with 1,000 recipe points over the run cap per recipe is cut into runs, never one over the cap', () => {
    resetIds();
    // Each member counts 262,144 points: only four fit one recipe (1,048,576).
    const els = row(6, 1, { cost: 262_144, gap: 0.05 });
    const p = run(els, { maxPictures: 8 });
    expect(p.runs.map((r) => r.members.length)).toEqual([4, 2]);
    for (const r of p.runs) expect(r.points).toBeLessThanOrEqual(RASTER_RUN.points);
  });
});

describe('planRasters: the mode (R10)', () => {
  it("'off' plans nothing: no run, no mark, no element touched", () => {
    resetIds();
    const els = [...row(3, 1), candEl({ box: [6, 3, 0.5, 0.5], limit: true })];
    const before = JSON.stringify(els, (_k, v) =>
      v instanceof Object && 'name' in v && 'children' in v ? '<node>' : v,
    );
    const p = run(els, { mode: 'off' });
    expect(p).toMatchObject({ mode: 'off', candidates: 0, runs: [], shapes: 0 });
    expect(p.forms.every((f) => f === undefined)).toBe(true);
    expect(
      JSON.stringify(els, (_k, v) => (v instanceof Object && 'name' in v && 'children' in v ? '<node>' : v)),
    ).toBe(before);
  });

  it("'detect' counts the candidates and nothing else (the operator's browser parse)", () => {
    resetIds();
    const els = [
      ...row(3, 1),
      smallEl({ box: [6, 3, 0.3, 0.3] }),
      candEl({ box: [7, 3, 0.5, 0.5], limit: true }),
    ];
    const p = run(els, { mode: 'detect' });
    expect(p).toMatchObject({ mode: 'detect', candidates: 4, runs: [], shapes: 0 });
    expect(marked(els as RasterElement[]).every((m) => m === undefined)).toBe(true);
    expect(els[4]!.support).toBe('residual');
  });
});

describe('planRasters: the words of the pictured shapes (R11, C-SR18)', () => {
  it('are joined bottom first, one line a shape, a paragraph a line', () => {
    resetIds();
    const two = textBody('Second line');
    two.paras.unshift({ ...two.paras[0]!, runs: [{ ...two.paras[0]!.runs[0]!, text: 'First line' }] });
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], text: textBody('Africa') }),
      candEl({ box: [1.6, 1, 0.5, 0.5] }),
      candEl({ box: [2.2, 1, 0.5, 0.5], text: two }),
    ];
    const p = run(els);
    expect(p.words).toBe('Africa\nFirst line\nSecond line');
    expect(p.wordsCut).toBe(false);
    expect(p.runs[0]!.words).toBe('Africa\nFirst line\nSecond line');
  });

  it('are cut at RASTER_WORDS_MAX characters a slide and the cut is named', () => {
    resetIds();
    const long = 'x'.repeat(3_000);
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], text: textBody(long) }),
      candEl({ box: [1.6, 1, 0.5, 0.5], text: textBody(long) }),
    ];
    const p = run(els);
    expect(p.words).toHaveLength(RASTER_WORDS_MAX);
    expect(p.wordsCut).toBe(true);
    expect(p.reasons).toContain('words');
  });

  it('are not collected from shapes that stay as today', () => {
    resetIds();
    const els = [candEl({ text: textBody('Africa') })];
    expect(run(els, { maker: 'pdf' }).words).toBe('');
  });
});

describe('planRasters: member references (R12, C-SR17)', () => {
  it('ids that repeat get different nth, bottom first within their source, in z order', () => {
    resetIds();
    const a = candEl({ box: [1, 1, 0.5, 0.5], shapeId: 7 });
    const b = candEl({ box: [1.6, 1, 0.5, 0.5], shapeId: 8 });
    const c = candEl({ box: [2.2, 1, 0.5, 0.5], shapeId: 7 });
    const layout = candEl({ box: [8, 4, 0.5, 0.5], shapeId: 7, from: 'layout' });
    const p = run([layout, a, b, c]);
    const slide = p.runs.find((r) => r.from === 'slide')!;
    expect(slide.refs).toEqual([
      { from: 'slide', shapeId: 7, nth: 0 },
      { from: 'slide', shapeId: 8, nth: 0 },
      { from: 'slide', shapeId: 7, nth: 1 },
    ]);
    expect(p.runs.find((r) => r.from === 'layout')!.refs).toEqual([{ from: 'layout', shapeId: 7, nth: 0 }]);
  });

  it('the nth counts every element with that id, the hidden and the unpictured too', () => {
    resetIds();
    const hidden = shapeEl({ shapeId: 7, hidden: true, box: [9, 5, 0.3, 0.3] });
    const first = pictureEl({ shapeId: 7, box: [10, 5, 0.3, 0.3] });
    const cand = candEl({ shapeId: 7, box: [1, 1, 0.5, 0.5] });
    const p = run([hidden, first, cand]);
    expect(p.runs[0]!.refs).toEqual([{ from: 'slide', shapeId: 7, nth: 2 }]);
  });
});

describe('planRasters: the node a candidate keeps', () => {
  it('is not read by the planner (the recipe builder reads it): a candidate without one is refused', () => {
    resetIds();
    const noNode = candEl({ box: [1, 1, 0.5, 0.5] });
    delete (noNode.rasterOf as { node?: unknown }).node;
    const p = run([noNode, candEl({ box: [3, 1, 0.5, 0.5], node: custNode(200) })]);
    expect(members(p)).toEqual([[1]]);
    expect(p.skipped.other).toBe(1);
  });
});

describe('leaving a shape as today leaves it (the forms applied)', () => {
  const shadow = { dist: 1, blur: 1, dir: 0, color: { r: 0, g: 0, b: 0, a: 1 } };

  it('a candidate no run claims is left exactly as the converter leaves it today: a shape past a limit is a residual box', () => {
    resetIds();
    const kept = candEl({ box: [1, 1, 0.5, 0.5], cost: 9_000, limit: true, shadow });
    const before = JSON.stringify({ support: kept.support, reasons: kept.reasons, over: kept.custom?.over });
    const els = [kept];
    const p = run(els);
    expect(p.runs).toEqual([]);
    applyUnclaimedForms(els, p);
    expect(kept.custom?.over).toBe(true);
    expect(kept.support).toBe('residual');
    expect(kept.reasons).toEqual(['custGeom']);
    expect(JSON.stringify({ support: kept.support, reasons: kept.reasons, over: kept.custom?.over })).toBe(
      before,
    );
  });

  it('one only the slide total refused is its stored shape again when the real total has room, a box when it has not', () => {
    resetIds();
    const mk = () =>
      candEl({
        box: [1, 1, 0.5, 0.5],
        why: 'total',
        cost: 600,
        todayPoints: 4_096,
        support: 'residual',
        reasons: ['custGeom'],
        shadow,
      });
    const roomy = [mk()];
    applyUnclaimedForms(roomy, run(roomy, { pointsUsed: 1_000 }));
    expect(roomy[0]!.custom?.over).toBeUndefined();
    expect(roomy[0]!.custom?.paths).toHaveLength(1);
    expect(roomy[0]!.support).toBe('native');
    expect(roomy[0]!.reasons).toBeUndefined();
    const full = [mk()];
    applyUnclaimedForms(full, run(full, { pointsUsed: 65_000 }));
    expect(full[0]!.custom).toMatchObject({ over: true, points: 4_096 });
    expect(full[0]!.support).toBe('residual');
    expect(full[0]!.reasons).toEqual(['custGeom']);
  });

  it('the shapes of a run are not touched by the unclaimed forms; those of a run whose picture failed take theirs by hand', () => {
    resetIds();
    const els = [
      candEl({ box: [1, 1, 0.5, 0.5], cost: 300 }),
      candEl({ box: [1.6, 1, 0.5, 0.5], cost: 9_000, limit: true }),
    ];
    const p = run(els);
    const stored = els.map((e) => e.custom);
    applyUnclaimedForms(els, p);
    expect(els.map((e) => e.custom)).toEqual(stored);
    expect(els.every((e) => e.raster === 0)).toBe(true);
    // The picture could not be made: each member is put back in its form and the mark goes.
    for (const m of p.runs[0]!.members) applyRasterForm(m.element, m.form!);
    expect(els.map((e) => e.raster)).toEqual([undefined, undefined]);
    expect(els[0]!.support).toBe('native');
    expect(els[1]!.custom?.over).toBe(true);
    expect(els[1]!.support).toBe('residual');
    expect(els[1]!.reasons).toEqual(['custGeom']);
  });

  it("rasterFormOf is pure: the stored form is the shape's own, the box form is a copy with the over mark", () => {
    resetIds();
    const el = candEl({ cost: 300 });
    const cand = el.rasterOf!;
    expect(rasterFormOf(cand, 'built')).toBe(cand.today);
    const box = rasterFormOf(cand, 'box');
    expect(box).toMatchObject({ over: true, points: cand.today.points });
    expect(box).not.toBe(cand.today);
    expect(cand.today.over).toBeUndefined();
  });
});
