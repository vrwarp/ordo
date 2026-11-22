import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { emitSlides, parseDeck } from './index.ts';
import { body, buildDeck, custGeom, para, run, solid, sp } from './test-util.ts';

/**
 * The shape pictures of the owner's Q53 (design/29 decision 4, sub-wave 3): a custom-path shape with more
 * than `RASTER_POINTS` points is drawn into a picture at import. This file is the RECORD of the release's
 * converter side:
 *
 * - part 1 (THE PIN, step 1 of the track): six synthetic slides parsed and emitted with TODAY's options, the
 *   SHA-256 of what is emitted for each (the slide's JSON, its notes and its missing list) recorded as
 *   literals. It was green at the unchanged base and stays green at every commit: with `rasters: 'off'`
 *   (gate G1, and a Reset slide) and with 'detect' the converter's output must not move by one byte.
 * - part 2 (the constants and the capability list) is added with the planner (step 3).
 *
 * A changed literal here is a change of the converter's output: it moves with CONVERTER_VERSION and a note in
 * the track's report, never silently.
 */

const IN = 914_400;

/** A closed polygon on a circle whose commands cost exactly `cost` points: a moveTo, `cost - 2` lnTo, a close. */
function poly(cost: number, o: { w?: number; h?: number; phase?: number } = {}): string {
  const w = o.w ?? 100_000;
  const h = o.h ?? 100_000;
  const n = cost - 2;
  const pt = (i: number) => {
    const a = (2 * Math.PI * i) / (n + 1) + (o.phase ?? 0) * 0.01;
    return `<a:pt x="${Math.round(w / 2 + (w / 2) * Math.cos(a))}" y="${Math.round(h / 2 + (h / 2) * Math.sin(a))}"/>`;
  };
  let d = `<a:moveTo>${pt(0)}</a:moveTo>`;
  for (let i = 1; i <= n; i++) d += `<a:lnTo>${pt(i)}</a:lnTo>`;
  return `<a:path w="${w}" h="${h}">${d}<a:close/></a:path>`;
}

/** A custom-geometry shape of one path of `cost` points, in a box `cx` x `cy` at (`x`, `y`) EMU. */
function blob(id: number, cost: number, x: number, y: number, cx: number, cy: number, extra = ''): string {
  return sp({
    id,
    x,
    y,
    cx,
    cy,
    geom: 'none',
    fill:
      custGeom({ paths: poly(cost, { phase: id }) }) +
      solid(((id * 2_654_435_761) >>> 8).toString(16).padStart(6, '0').slice(0, 6).toUpperCase()),
    ...(extra ? { txBody: extra } : {}),
  });
}

/** The six slides of the pin: what the converter does today with each way a shape is "many-point". */
function pinDeck() {
  const slides = [
    // 1: a 300-point shape (native today)
    { shapes: blob(2, 300, IN, IN, 2 * IN, 2 * IN) },
    // 2: a shape whose one sub-path has 5,000 points (past the 4,096 cut of one path)
    { shapes: blob(2, 5_000, IN, IN, 3 * IN, 3 * IN) },
    // 3: a shape of nine paths (past the 8 a shape keeps)
    {
      shapes: sp({
        id: 2,
        x: IN,
        y: IN,
        cx: 2 * IN,
        cy: 2 * IN,
        geom: 'none',
        fill:
          custGeom({ paths: Array.from({ length: 9 }, (_, k) => poly(12, { phase: k })).join('') }) +
          solid('3366AA'),
      }),
    },
    // 4: 600 shapes of 120 points (72,000 points: the slide's 65,536 are used up before the end)
    {
      shapes: Array.from({ length: 600 }, (_, k) =>
        blob(10 + k, 120, (k % 30) * 380_000, Math.floor(k / 30) * 330_000, 360_000, 310_000),
      ).join(''),
    },
    // 5: a shape of 400 points with text
    {
      shapes: blob(
        2,
        400,
        IN,
        IN,
        4 * IN,
        2 * IN,
        body(para(run('Words in a many-point shape', 'sz="2400"', solid('FFFFFF')))),
      ),
    },
    // 6: a plain slide (a rectangle and a title)
    {
      shapes:
        sp({ id: 2, x: IN, y: IN, cx: 3 * IN, cy: IN, fill: solid('336699') }) +
        sp({
          id: 3,
          x: IN,
          y: 3 * IN,
          cx: 6 * IN,
          cy: IN,
          txBox: true,
          txBody: body(para(run('A plain slide', 'sz="3200"', solid('000000')))),
        }),
    },
  ];
  return buildDeck({ slides });
}

const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** What the pin records of one emitted slide. */
function pinOf(opts: { libreoffice?: boolean }) {
  const parts = pinDeck();
  const out = emitSlides(parseDeck(parts, opts), opts);
  return out.slides.map((s) => ({
    slide: sha(s.slide),
    notes: sha(s.notes),
    missing: sha(s.missing ?? null),
    class: s.classification.class,
  }));
}

/** Recorded at the unchanged base (r2b3-base, 544664f1), read from this very code before any raster file existed. */
const TODAY: Record<'withLibreOffice' | 'withoutLibreOffice', ReturnType<typeof pinOf>> = {
  withLibreOffice: [
    {
      slide: '5824686dc6982e4a5873dec57153bbfc280b3af6a6b303f14595cb2467c93b25',
      notes: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      missing: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      class: 'native',
    },
    {
      slide: 'e9cee5598fdfbf527a07bbb5e7f633075361f319f18731e181df9ff1a6699098',
      notes: '3e7a98812aa3741e50830ea4a4e3455583de0826fd7c9318045b03bd5514e9f8',
      missing: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      class: 'hybrid',
    },
    {
      slide: '667a74edd920d118f4f2b6b86fbc55e83ddab244eae1cee332b1c55677e1a104',
      notes: '072ceedc75644c63e46b328739da22c88ada8c3841771520e5fd2f9be7093625',
      missing: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      class: 'hybrid',
    },
    {
      slide: 'ccb45777821d4c705e5f648b1f2270707232d0831a0b0763ee912d8458255be6',
      notes: '59d360749a2e7203c1a3f35ed8499198dc7369e35ebc7c6a4a552623a7d853ea',
      missing: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      class: 'hybrid',
    },
    {
      slide: '3eef76509c9e0a5117bb06f6a4c23639cbf68c006f434b68973ebda36654b9ac',
      notes: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      missing: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      class: 'native',
    },
    {
      slide: '41e5e1b155431aa87a3ecc84a8848696b382c66a0105d9301f9d671490614735',
      notes: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      missing: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      class: 'native',
    },
  ],
  withoutLibreOffice: [
    {
      slide: '5824686dc6982e4a5873dec57153bbfc280b3af6a6b303f14595cb2467c93b25',
      notes: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      missing: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      class: 'native',
    },
    {
      slide: 'e9cee5598fdfbf527a07bbb5e7f633075361f319f18731e181df9ff1a6699098',
      notes: '87811b89b187e763ec87eec0518fc18d31701374bfbfdd4790dc920383e4f9c0',
      missing: 'a0f9dae699de49ea8b8df7332e6e7c5c32d00eda6d013ac1f0102ac298e4a322',
      class: 'hybrid',
    },
    {
      slide: '667a74edd920d118f4f2b6b86fbc55e83ddab244eae1cee332b1c55677e1a104',
      notes: 'f22280de0a9b4ce40a3e2153c9c9ad3eef658e990e6a6b1f63fc5a94b212d51e',
      missing: 'a0f9dae699de49ea8b8df7332e6e7c5c32d00eda6d013ac1f0102ac298e4a322',
      class: 'hybrid',
    },
    {
      slide: 'ccb45777821d4c705e5f648b1f2270707232d0831a0b0763ee912d8458255be6',
      notes: 'f46d1fc0b66daf3cf28c50d655591e11ed6f13eebde7f00c38cae10606a77e44',
      missing: 'a0f9dae699de49ea8b8df7332e6e7c5c32d00eda6d013ac1f0102ac298e4a322',
      class: 'hybrid',
    },
    {
      slide: '3eef76509c9e0a5117bb06f6a4c23639cbf68c006f434b68973ebda36654b9ac',
      notes: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      missing: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      class: 'native',
    },
    {
      slide: '41e5e1b155431aa87a3ecc84a8848696b382c66a0105d9301f9d671490614735',
      notes: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      missing: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      class: 'native',
    },
  ],
};

describe("the pin of today's converter output (gate G1, step 1)", () => {
  it('six synthetic slides emit byte for byte what they emitted at the base (a hub with LibreOffice)', () => {
    expect(pinOf({})).toEqual(TODAY.withLibreOffice);
  });

  it('and on a hub without LibreOffice', () => {
    expect(pinOf({ libreoffice: false })).toEqual(TODAY.withoutLibreOffice);
  });
});
