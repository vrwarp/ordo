import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Slide } from '@ordo/domain';
import { describe, expect, it } from 'vitest';
import {
  type DiagnosticSlidePacketInput,
  buildFeatureClusters,
  renderDiagnosticStrip,
  writeDiagnosticArtifacts,
} from './diagnostics.ts';
import { makePng } from './png.ts';
import type { DeckScore, SummaryReport } from './types.ts';

describe('diagnostics', () => {
  it('buildFeatureClusters computes recoverable gain and worst representative slide', () => {
    const decks: DeckScore[] = [
      {
        name: 'deck-a',
        kind: 'sample',
        title: 'Deck A',
        slideCount: 2,
        ssim: 0.85,
        minSlideSsim: 0.8,
        importNotes: [],
        perSlide: [
          {
            n: 1,
            ssim: 0.9,
            transparentRef: false,
            overallMae: 2,
            backgroundMae: 1,
            alphaMae: 0,
            boxMaes: [],
            features: ['gradientFill', 'docBackground'],
            refPngPath: 'ref1.png',
            ordoPngPath: 'ordo1.png',
          },
          {
            n: 2,
            ssim: 0.8,
            transparentRef: true,
            overallMae: 5,
            backgroundMae: 3,
            alphaMae: 1,
            boxMaes: [],
            features: ['gradientFill', 'transparentPlate'],
            refPngPath: 'ref2.png',
            ordoPngPath: 'ordo2.png',
          },
        ],
      },
      {
        name: 'deck-b',
        kind: 'synthetic',
        title: 'Deck B',
        slideCount: 1,
        ssim: 0.7,
        minSlideSsim: 0.7,
        importNotes: [],
        perSlide: [
          {
            n: 1,
            ssim: 0.7,
            transparentRef: false,
            overallMae: 10,
            backgroundMae: 8,
            alphaMae: 0,
            boxMaes: [],
            features: ['docBackground', 'videoBg'],
            refPngPath: 'refB1.png',
            ordoPngPath: 'ordoB1.png',
          },
        ],
      },
    ];

    const clusters = buildFeatureClusters(decks);
    expect(clusters.length).toBeGreaterThan(0);

    // gradientFill: slideCount = 2, meanSsim = (0.9 + 0.8) / 2 = 0.85, gain = 2 * (1 - 0.85) = 0.3
    const grad = clusters.find((c) => c.feature === 'gradientFill')!;
    expect(grad).toBeDefined();
    expect(grad.slideCount).toBe(2);
    expect(grad.meanSsim).toBe(0.85);
    expect(grad.recoverableGain).toBeCloseTo(0.3);
    expect(grad.worstSlide).toEqual({ deck: 'deck-a', n: 2, ssim: 0.8 });

    // docBackground: slideCount = 2, meanSsim = (0.9 + 0.7) / 2 = 0.8, gain = 2 * (1 - 0.8) = 0.4
    const docBg = clusters.find((c) => c.feature === 'docBackground')!;
    expect(docBg).toBeDefined();
    expect(docBg.slideCount).toBe(2);
    expect(docBg.meanSsim).toBe(0.8);
    expect(docBg.recoverableGain).toBeCloseTo(0.4);
    expect(docBg.worstSlide).toEqual({ deck: 'deck-b', n: 1, ssim: 0.7 });

    // Sorted descending by recoverableGain
    expect(clusters[0]!.recoverableGain).toBeGreaterThanOrEqual(clusters[1]!.recoverableGain);
  });

  it('renderDiagnosticStrip creates a 1920x1080 2x2 grid with divider lines', () => {
    const ref = makePng(1920, 1080, (x, _y) => (x < 960 ? [200, 100, 50, 255] : [0, 0, 0, 0]));
    const cand = makePng(1920, 1080, (x, _y) => (x < 960 ? [180, 100, 50, 255] : [0, 0, 0, 0]));

    const strip = renderDiagnosticStrip(ref, cand);
    expect(strip.width).toBe(1920);
    expect(strip.height).toBe(1080);
    expect(strip.data.length).toBe(1920 * 1080 * 4);

    // Divider line at x = 960, y = 300
    const divIdxV = (300 * 1920 + 960) * 4;
    expect(Array.from(strip.data.subarray(divIdxV, divIdxV + 4))).toEqual([90, 90, 90, 255]);

    // Divider line at x = 400, y = 540
    const divIdxH = (540 * 1920 + 400) * 4;
    expect(Array.from(strip.data.subarray(divIdxH, divIdxH + 4))).toEqual([90, 90, 90, 255]);

    // Top-left quadrant (100, 100) has composited ref
    const tlIdx = (100 * 1920 + 100) * 4;
    expect(strip.data[tlIdx + 3]).toBe(255);
  });

  it('writeDiagnosticArtifacts produces summary.json, report.md, and worst slide dirs', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'pro7-diag-test-'));

    try {
      const summary: SummaryReport = {
        createdAt: '2026-11-12T00:00:00Z',
        exportCompat: true,
        meanSsim: 0.88,
        sampleMeanSsim: 0.85,
        syntheticMeanSsim: 0.95,
        totalSlides: 2,
        decks: [
          {
            name: 'sample-deck',
            kind: 'sample',
            title: 'Sample Deck',
            slideCount: 2,
            ssim: 0.88,
            minSlideSsim: 0.8,
            perSlide: [],
            importNotes: [],
          },
        ],
        clusters: [
          {
            feature: 'gradientFill',
            slideCount: 1,
            meanSsim: 0.8,
            recoverableGain: 0.2,
            worstSlide: { deck: 'sample-deck', n: 1, ssim: 0.8 },
          },
        ],
      };

      const ref = makePng(1920, 1080, () => [100, 100, 100, 255]);
      const cand = makePng(1920, 1080, () => [90, 90, 90, 255]);
      const dummySlide: Slide = { id: 'slide-1', objects: [] };

      const packet: DiagnosticSlidePacketInput = {
        deckName: 'sample-deck',
        score: {
          n: 1,
          ssim: 0.8,
          transparentRef: false,
          overallMae: 5,
          backgroundMae: 2,
          alphaMae: 0,
          boxMaes: [],
          features: ['gradientFill'],
          refPngPath: 'ref.png',
          ordoPngPath: 'ordo.png',
        },
        ref,
        cand,
        slide: dummySlide,
        source: {
          slideNumber: 1,
          cueName: 'Test Cue',
          features: ['gradientFill'],
          pro7SlideJson: { note: 'test pro7 slide' },
        },
      };

      const { summaryPath, reportPath, worstDirs } = await writeDiagnosticArtifacts({
        outDir: tmp,
        summary,
        packets: [packet],
        worstCount: 1,
      });

      expect(summaryPath).toBe(join(tmp, 'summary.json'));
      expect(reportPath).toBe(join(tmp, 'report.md'));
      expect(worstDirs).toHaveLength(1);

      const summaryContent = JSON.parse(await readFile(summaryPath, 'utf8'));
      expect(summaryContent.meanSsim).toBe(0.88);

      const reportContent = await readFile(reportPath, 'utf8');
      expect(reportContent).toContain('# ProPresenter 7 Fidelity Report');
      expect(reportContent).toContain('`gradientFill`');

      const worstDir = worstDirs[0]!;
      const stripPng = await readFile(join(worstDir, 'strip.png'));
      expect(stripPng.length).toBeGreaterThan(0);

      const pro7Json = JSON.parse(await readFile(join(worstDir, 'pro7-slide.json'), 'utf8'));
      expect(pro7Json.note).toBe('test pro7 slide');

      const ordoJson = JSON.parse(await readFile(join(worstDir, 'ordo-slide.json'), 'utf8'));
      expect(ordoJson.deck).toBe('sample-deck');
      expect(ordoJson.ssim).toBe(0.8);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
