import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type DeckScore,
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
