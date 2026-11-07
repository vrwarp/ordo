import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  causeOf,
  causeRows,
  type DeckScore,
  inF,
  nativeStats,
  nativeTables,
  policyRows,
  type SlideScore,
  textFeatureRows,
  writeReport,
} from './report.ts';

const deck = (name: string, extra: Partial<DeckScore>, perSlide: SlideScore[]): DeckScore => ({
  name,
  slides: perSlide.length,
  notes: [],
  nativeSlides: perSlide.length,
  perSlide,
  ...extra,
});

/** Three decks: two counted, one with embedded fonts (counted in shares, left out of means). */
const decks: DeckScore[] = [
  deck('a', { nativeSsim: 0.85, ssim: 0.8, textFeatures: ['superSub', 'lnSpcPct'], worship: true }, [
    { n: 1, tier: 'T2', nativeSsim: 0.9, ssim: 0.7, blackSsim: 0.1, textFeatures: ['superSub'] },
    { n: 2, tier: 'T3', nativeSsim: 0.8, ssim: 0.9, blackSsim: 0.1, textFeatures: ['superSub', 'lnSpcPct'] },
  ]),
  deck('b', { nativeSsim: 0.6, ssim: 0.5, textFeatures: ['superSub'] }, [
    { n: 1, tier: 'T1', nativeSsim: 0.6, ssim: 0.5, blackSsim: 0.7, compat: ['runShadow'] },
  ]),
  deck('c', { nativeSsim: 0.1, embeddedFonts: true, textFeatures: ['superSub'] }, [
    { n: 1, tier: 'T2', nativeSsim: 0.1, blackSsim: 0.05, textFeatures: ['superSub'] },
  ]),
];

describe('text feature rows', () => {
  it('gives slide, tier and deck means per feature, next to the M2 target', () => {
    const rows = textFeatureRows(decks);
    expect(rows.map((r) => r.key)).toEqual(['superSub', 'lnSpcPct']);
    const sup = rows[0]!;
    // Three shown slides have it (one in a deck with embedded fonts): counted, not averaged.
    expect(sup.count).toBe(3);
    expect(sup.share).toBeCloseTo(3 / 4);
    expect(sup.native).toBeCloseTo(0.85);
    expect(sup.ppv).toBeCloseTo(0.8);
    expect(sup.beatsBlack).toBe(1);
    expect(sup.tiers).toEqual({
      T2: { count: 2, native: 0.9, ppv: 0.7 },
      T3: { count: 1, native: 0.8, ppv: 0.9 },
    });
    // Decks with the feature anywhere: a and b (c has embedded fonts).
    expect(sup.decks).toBe(2);
    expect(sup.deckNative).toBeCloseTo(0.725);
    expect(sup.deckPpv).toBeCloseTo(0.65);
    expect(sup.target).toBe(0.61);
    expect(rows[1]).toMatchObject({ key: 'lnSpcPct', count: 1, decks: 1, target: 0.75 });
    expect(sup.policy).toBeUndefined();
  });

  it("gives ordo's policy means next to LibreOffice's under --lo-compat", () => {
    const lo = [
      deck('d', { nativeSsim: 0.9 }, [
        {
          n: 1,
          tier: 'T1',
          nativeSsim: 0.9,
          policySsim: 0.7,
          compat: ['textOutline'],
          textFeatures: ['rtl'],
        },
        { n: 2, tier: 'T1', nativeSsim: 0.5, textFeatures: ['rtl'] },
      ]),
    ];
    expect(textFeatureRows(lo)[0]).toMatchObject({ key: 'rtl', native: 0.7, policy: 0.6 });
    expect(policyRows(lo)).toEqual([
      expect.objectContaining({ key: 'textOutline', count: 1, native: 0.9, policy: 0.7 }),
    ]);
    expect(nativeStats(lo).meanPolicy).toBeCloseTo(0.6);
    expect(nativeStats(decks).meanPolicy).toBeUndefined();
  });
});

describe('policy rows and tier totals', () => {
  it('counts the slides each LibreOffice rule changes, and T1+T2 together', () => {
    expect(policyRows(decks)).toEqual([
      expect.objectContaining({ key: 'runShadow', count: 1, native: 0.6, ppv: 0.5, beatsBlack: 0 }),
    ]);
    const t = nativeStats(decks).t1t2!;
    expect(t).toMatchObject({ key: 'T1+T2', count: 3 });
    expect(t.native).toBeCloseTo(0.75);
    expect(t.ppv).toBeCloseTo(0.6);
    const tables = nativeTables(decks);
    expect(tables.textFeatures).toHaveLength(2);
    expect(tables.policy).toHaveLength(1);
  });
});

describe('writeReport', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it('shows the text feature and policy tables, and what the run was asked for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ordo-report-'));
    dirs.push(dir);
    const file = join(dir, 'report.html');
    await writeReport(file, {
      createdAt: 'now',
      loCompat: true,
      slides: [{ deck: 'a', slides: [1, 2] }],
      scriptFallbacks: [
        {
          family: 'Noto Sans Hebrew',
          scripts: ['Hebr'],
          served: 'stand-in',
          host: 'DejaVu Sans',
          file: '/x',
        },
        { family: 'Noto Naskh Arabic', scripts: ['Arab'], served: 'missing' },
      ],
      decks,
    });
    const html = await readFile(file, 'utf8');
    expect(html).toContain('Text features');
    expect(html).toContain('<td>superSub</td>');
    expect(html).toContain('LibreOffice policy rules');
    expect(html).toContain('--lo-compat');
    expect(html).toContain('(--slides): a: 1, 2');
    expect(html).toContain('Noto Sans Hebrew (Hebr): DejaVu Sans standing in');
    expect(html).toContain("Noto Naskh Arabic (Arab): not installed, the browser's fallback draws it");
  });
});

describe('cause groups of F', () => {
  const T = { tier: 'T3', libreoffice: 'lo.png' } as const;
  const f: DeckScore[] = [
    deck('d', {}, [
      // 3-D first: a slide with 3-D and a warp is in the 3-D group, as exit_ssim.py puts it.
      {
        n: 1,
        ...T,
        class: 'hybrid',
        reasons: ['art:3d', 'art:warp'],
        nativeSsim: 0.8,
        beforeHubSsim: 0.96,
        beforeHubFrom: 'hub',
        beforeHubPaste: 0.99,
        noLoSsim: 0.8,
        blackSsim: 0.1,
      },
      {
        n: 2,
        ...T,
        class: 'hybrid',
        reasons: ['art:warp'],
        nativeSsim: 0.9,
        beforeHubSsim: 0.98,
        beforeHubFrom: 'paste',
        beforeHubPaste: 0.98,
        blackSsim: 0.2,
      },
      {
        n: 3,
        ...T,
        class: 'hybrid',
        reasons: ['art:warp'],
        nativeSsim: 0.7,
        beforeHubSsim: 0.94,
        beforeHubFrom: 'hub',
        beforeHubPaste: 0.97,
        blackSsim: 0.1,
        maxObjectMs: { '1920': 3, '3840': 9 },
      },
      // A native slide whose metafile waits for LibreOffice is in F, in the metafile group.
      {
        n: 4,
        ...T,
        class: 'native',
        reasons: ['pic:emf'],
        metafiles: 1,
        nativeSsim: 0.6,
        beforeHubSsim: 0.93,
        beforeHubFrom: 'hub',
        blackSsim: 0.1,
      },
      // Native, no metafile: not in F.
      { n: 5, ...T, class: 'native', reasons: [], nativeSsim: 0.99, beforeHubSsim: 0.99, blackSsim: 0.1 },
      // The hub's budget made this native slide a picture; no listed reason: the ladder's.
      {
        n: 6,
        ...T,
        class: 'native',
        hub: 'picture',
        reasons: [],
        nativeSsim: 0.85,
        beforeHubSsim: 0.95,
        beforeHubFrom: 'hub',
        noLoSsim: 0.2,
        blackSsim: 0.2,
        exception: 'named',
      },
      // The converter did not emit it: the hub shows LibreOffice's picture.
      {
        n: 7,
        libreoffice: 'lo.png',
        nativeSsim: 0,
        beforeHubSsim: 1,
        beforeHubFrom: 'paste',
        beforeHubPaste: 1,
      },
    ]),
  ];

  it('groups by cause with before-harness and before-hub means', () => {
    const slides = f[0]!.perSlide;
    expect(slides.map(inF)).toEqual([true, true, true, true, false, true, true]);
    expect(slides.filter(inF).map(causeOf)).toEqual([
      '3d',
      'warp',
      'warp',
      'metafile/ole',
      'ladder',
      'not converted',
    ]);
    const rows = causeRows(f);
    expect(rows.map((r) => [r.key, r.count])).toEqual([
      ['all of F', 6],
      ['3d', 1],
      ['warp', 2],
      ['metafile/ole', 1],
      ['ladder', 1],
      ['not converted', 1],
    ]);
    const warp = rows.find((r) => r.key === 'warp')!;
    expect(warp.harness).toBeCloseTo(0.8, 9);
    expect(warp.hub).toBeCloseTo(0.96, 9);
    expect(warp).toMatchObject({ hubCount: 2, fromHub: 1, maxObjectMs3840: 9, missing: 0, exceptions: 0 });
    expect(warp.paste).toBeCloseTo(0.975, 9);
    expect(warp.noLo).toBeUndefined();
    const all = rows[0]!;
    expect(all.harness).toBeCloseTo((0.8 + 0.9 + 0.7 + 0.6 + 0.85 + 0) / 6, 9);
    expect(all.hub).toBeCloseTo((0.96 + 0.98 + 0.94 + 0.93 + 0.95 + 1) / 6, 9);
    expect(all).toMatchObject({ fromHub: 4, exceptions: 1 });
    expect(all.noLo).toBeCloseTo(0.5, 9);
    // The tables summary.json keeps carry the groups.
    expect(nativeTables(f).causes).toEqual(rows);
  });
});
