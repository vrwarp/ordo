import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Slide } from '@ordo/domain';
import { encodePng } from './png.ts';
import type {
  DeckScore,
  FeatureCluster,
  Pro7FeatureTag,
  RgbaImage,
  SlideDiagnosticSource,
  SlideScore,
  SummaryReport,
} from './types.ts';

export type DiagnosticSlidePacketInput = {
  deckName: string;
  score: SlideScore;
  ref: RgbaImage;
  cand: RgbaImage;
  slide: Slide;
  source?: SlideDiagnosticSource;
};

export function buildFeatureClusters(decks: readonly DeckScore[]): FeatureCluster[] {
  const slidesByFeature = new Map<Pro7FeatureTag, { deck: string; n: number; ssim: number }[]>();

  for (const deck of decks) {
    for (const slide of deck.perSlide) {
      for (const feat of slide.features) {
        let list = slidesByFeature.get(feat);
        if (!list) {
          list = [];
          slidesByFeature.set(feat, list);
        }
        list.push({ deck: deck.name, n: slide.n, ssim: slide.ssim });
      }
    }
  }

  const clusters: FeatureCluster[] = [];
  for (const [feat, list] of slidesByFeature) {
    if (list.length === 0) continue;
    const slideCount = list.length;
    let sumSsim = 0;
    let worst = list[0]!;
    for (const item of list) {
      sumSsim += item.ssim;
      if (item.ssim < worst.ssim) {
        worst = item;
      }
    }
    const meanSsim = sumSsim / slideCount;
    const recoverableGain = slideCount * (1 - meanSsim);
    clusters.push({
      feature: feat,
      slideCount,
      meanSsim: Math.round(meanSsim * 10000) / 10000,
      recoverableGain: Math.round(recoverableGain * 10000) / 10000,
      worstSlide: { deck: worst.deck, n: worst.n, ssim: worst.ssim },
    });
  }

  clusters.sort((a, b) => {
    if (b.recoverableGain !== a.recoverableGain) {
      return b.recoverableGain - a.recoverableGain;
    }
    return b.slideCount - a.slideCount;
  });

  return clusters;
}

export function renderDiagnosticStrip(ref: RgbaImage, cand: RgbaImage): RgbaImage {
  const width = 1920;
  const height = 1080;
  const out = new Uint8Array(width * height * 4);

  const qW = 960;
  const qH = 540;

  for (let qy = 0; qy < qH; qy++) {
    const y0 = qy * 2;
    const y1 = y0 + 1;
    for (let qx = 0; qx < qW; qx++) {
      const x0 = qx * 2;
      const x1 = x0 + 1;

      // 2x2 box area downsampling
      const i00 = (y0 * 1920 + x0) * 4;
      const i10 = (y0 * 1920 + x1) * 4;
      const i01 = (y1 * 1920 + x0) * 4;
      const i11 = (y1 * 1920 + x1) * 4;

      const rR = (ref.data[i00]! + ref.data[i10]! + ref.data[i01]! + ref.data[i11]!) >> 2;
      const gR = (ref.data[i00 + 1]! + ref.data[i10 + 1]! + ref.data[i01 + 1]! + ref.data[i11 + 1]!) >> 2;
      const bR = (ref.data[i00 + 2]! + ref.data[i10 + 2]! + ref.data[i01 + 2]! + ref.data[i11 + 2]!) >> 2;
      const aR = (ref.data[i00 + 3]! + ref.data[i10 + 3]! + ref.data[i01 + 3]! + ref.data[i11 + 3]!) >> 2;

      const rC = (cand.data[i00]! + cand.data[i10]! + cand.data[i01]! + cand.data[i11]!) >> 2;
      const gC = (cand.data[i00 + 1]! + cand.data[i10 + 1]! + cand.data[i01 + 1]! + cand.data[i11 + 1]!) >> 2;
      const bC = (cand.data[i00 + 2]! + cand.data[i10 + 2]! + cand.data[i01 + 2]! + cand.data[i11 + 2]!) >> 2;
      const aC = (cand.data[i00 + 3]! + cand.data[i10 + 3]! + cand.data[i01 + 3]! + cand.data[i11 + 3]!) >> 2;

      // 16px dark checkerboard ([42, 42, 42] / [58, 58, 58])
      const check = ((Math.floor(qx / 16) + Math.floor(qy / 16)) & 1) === 0 ? 42 : 58;

      // Top-Left (0, 0): Reference composited over checkerboard
      const tlIdx = (qy * 1920 + qx) * 4;
      if (aR === 255) {
        out[tlIdx] = rR;
        out[tlIdx + 1] = gR;
        out[tlIdx + 2] = bR;
      } else if (aR === 0) {
        out[tlIdx] = check;
        out[tlIdx + 1] = check;
        out[tlIdx + 2] = check;
      } else {
        const invA = 255 - aR;
        out[tlIdx] = Math.round((rR * aR + check * invA) / 255);
        out[tlIdx + 1] = Math.round((gR * aR + check * invA) / 255);
        out[tlIdx + 2] = Math.round((bR * aR + check * invA) / 255);
      }
      out[tlIdx + 3] = 255;

      // Top-Right (960, 0): Ordo candidate composited over checkerboard
      const trIdx = (qy * 1920 + (qW + qx)) * 4;
      if (aC === 255) {
        out[trIdx] = rC;
        out[trIdx + 1] = gC;
        out[trIdx + 2] = bC;
      } else if (aC === 0) {
        out[trIdx] = check;
        out[trIdx + 1] = check;
        out[trIdx + 2] = check;
      } else {
        const invA = 255 - aC;
        out[trIdx] = Math.round((rC * aC + check * invA) / 255);
        out[trIdx + 1] = Math.round((gC * aC + check * invA) / 255);
        out[trIdx + 2] = Math.round((bC * aC + check * invA) / 255);
      }
      out[trIdx + 3] = 255;

      // Bottom-Left (0, 540): 4x |Ref - Ordo| error heatmap
      const refB_r = Math.round((rR * aR) / 255);
      const refB_g = Math.round((gR * aR) / 255);
      const refB_b = Math.round((bR * aR) / 255);
      const refW_r = Math.round((rR * aR + 255 * (255 - aR)) / 255);
      const refW_g = Math.round((gR * aR + 255 * (255 - aR)) / 255);
      const refW_b = Math.round((bR * aR + 255 * (255 - aR)) / 255);

      const candB_r = Math.round((rC * aC) / 255);
      const candB_g = Math.round((gC * aC) / 255);
      const candB_b = Math.round((bC * aC) / 255);
      const candW_r = Math.round((rC * aC + 255 * (255 - aC)) / 255);
      const candW_g = Math.round((gC * aC + 255 * (255 - aC)) / 255);
      const candW_b = Math.round((bC * aC + 255 * (255 - aC)) / 255);

      const diffMax = Math.max(
        Math.abs(refB_r - candB_r),
        Math.abs(refB_g - candB_g),
        Math.abs(refB_b - candB_b),
        Math.abs(refW_r - candW_r),
        Math.abs(refW_g - candW_g),
        Math.abs(refW_b - candW_b),
      );

      const val = Math.min(255, diffMax * 4);
      let hmR = 0;
      let hmG = 0;
      let hmB = 0;
      if (val <= 0) {
        hmR = 0;
        hmG = 0;
        hmB = 0;
      } else if (val <= 64) {
        const t = val / 64;
        hmR = 0;
        hmG = 0;
        hmB = Math.round(255 * t);
      } else if (val <= 160) {
        const t = (val - 64) / 96;
        hmR = Math.round(255 * t);
        hmG = 0;
        hmB = Math.round(255 * (1 - t));
      } else {
        const t = (val - 160) / 95;
        hmR = 255;
        hmG = Math.round(255 * t);
        hmB = Math.round(255 * t);
      }

      const blIdx = ((qH + qy) * 1920 + qx) * 4;
      out[blIdx] = hmR;
      out[blIdx + 1] = hmG;
      out[blIdx + 2] = hmB;
      out[blIdx + 3] = 255;

      // Bottom-Right (960, 540): |Ref.a - Ordo.a| grayscale alpha-channel diff
      const v = Math.min(255, Math.abs(aR - aC) * 2);
      const brIdx = ((qH + qy) * 1920 + (qW + qx)) * 4;
      out[brIdx] = v;
      out[brIdx + 1] = v;
      out[brIdx + 2] = v;
      out[brIdx + 3] = 255;
    }
  }

  // Draw 1px neutral divider line ([90, 90, 90, 255]) at x = 960 and y = 540
  for (let y = 0; y < height; y++) {
    const idx = (y * 1920 + qW) * 4;
    out[idx] = 90;
    out[idx + 1] = 90;
    out[idx + 2] = 90;
    out[idx + 3] = 255;
  }
  for (let x = 0; x < width; x++) {
    const idx = (qH * 1920 + x) * 4;
    out[idx] = 90;
    out[idx + 1] = 90;
    out[idx + 2] = 90;
    out[idx + 3] = 255;
  }

  return { width, height, data: out };
}

function sanitizeSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'deck'
  );
}

export function generateReportMarkdown(summary: SummaryReport): string {
  const lines: string[] = [];
  lines.push('# ProPresenter 7 Fidelity Report');
  lines.push('');
  lines.push('## Overall Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Created At | ${summary.createdAt} |`);
  lines.push(`| Export Compatibility | ${summary.exportCompat ? 'Yes' : 'No'} |`);
  lines.push(`| Total Slides | ${summary.totalSlides} |`);
  lines.push(`| Mean SSIM | ${(summary.meanSsim * 100).toFixed(2)}% |`);
  if (summary.sampleMeanSsim !== undefined) {
    lines.push(`| Sample Mean SSIM | ${(summary.sampleMeanSsim * 100).toFixed(2)}% |`);
  }
  if (summary.syntheticMeanSsim !== undefined) {
    lines.push(`| Synthetic Mean SSIM | ${(summary.syntheticMeanSsim * 100).toFixed(2)}% |`);
  }
  lines.push('');

  lines.push('## Per-Deck Scores');
  lines.push('');
  lines.push('| Deck | Kind | Slides | Mean SSIM | Min SSIM | Notes |');
  lines.push('|---|---|---|---|---|---|');
  for (const deck of summary.decks) {
    lines.push(
      `| ${deck.name} | ${deck.kind} | ${deck.slideCount} | ${(deck.ssim * 100).toFixed(2)}% | ${(deck.minSlideSsim * 100).toFixed(2)}% | ${deck.importNotes.length} |`,
    );
  }
  lines.push('');

  lines.push('## Ranked Root-Cause Feature Clusters by Recoverable SSIM');
  lines.push('');
  lines.push('| Rank | Feature Tag | Slide Count | Mean SSIM | Recoverable Gain | Worst Slide |');
  lines.push('|---|---|---|---|---|---|');
  for (let i = 0; i < summary.clusters.length; i++) {
    const c = summary.clusters[i]!;
    const worst = `${c.worstSlide.deck} s${c.worstSlide.n} (${(c.worstSlide.ssim * 100).toFixed(1)}%)`;
    lines.push(
      `| ${i + 1} | \`${c.feature}\` | ${c.slideCount} | ${(c.meanSsim * 100).toFixed(2)}% | ${c.recoverableGain.toFixed(3)} | ${worst} |`,
    );
  }
  lines.push('');

  return lines.join('\n');
}

export async function writeDiagnosticArtifacts(opts: {
  outDir: string;
  summary: SummaryReport;
  packets: readonly DiagnosticSlidePacketInput[];
  worstCount: number;
}): Promise<{ summaryPath: string; reportPath: string; worstDirs: string[] }> {
  await mkdir(opts.outDir, { recursive: true });

  const summaryPath = join(opts.outDir, 'summary.json');
  await writeFile(summaryPath, JSON.stringify(opts.summary, null, 2), 'utf8');

  const reportPath = join(opts.outDir, 'report.md');
  const reportMd = generateReportMarkdown(opts.summary);
  await writeFile(reportPath, reportMd, 'utf8');

  // Select worst slides: first pick worst representative slide for each top cluster, then fill remaining with lowest SSIM
  const selectedKeys = new Set<string>();
  const selectedPackets: DiagnosticSlidePacketInput[] = [];

  const keyOf = (p: DiagnosticSlidePacketInput) => `${p.deckName}#${p.score.n}`;

  for (const cluster of opts.summary.clusters) {
    if (selectedPackets.length >= opts.worstCount) break;
    const match = opts.packets.find(
      (p) => p.deckName === cluster.worstSlide.deck && p.score.n === cluster.worstSlide.n,
    );
    if (match && !selectedKeys.has(keyOf(match))) {
      selectedKeys.add(keyOf(match));
      selectedPackets.push(match);
    }
  }

  if (selectedPackets.length < opts.worstCount) {
    const sorted = [...opts.packets].sort((a, b) => a.score.ssim - b.score.ssim);
    for (const p of sorted) {
      if (selectedPackets.length >= opts.worstCount) break;
      if (!selectedKeys.has(keyOf(p))) {
        selectedKeys.add(keyOf(p));
        selectedPackets.push(p);
      }
    }
  }

  const worstDirs: string[] = [];
  const worstParent = join(opts.outDir, 'worst');
  await mkdir(worstParent, { recursive: true });

  for (let rank = 1; rank <= selectedPackets.length; rank++) {
    const packet = selectedPackets[rank - 1]!;
    const rankPad = String(rank).padStart(2, '0');
    const slug = sanitizeSlug(packet.deckName);
    const slidePad = String(packet.score.n).padStart(2, '0');
    const dirName = `${rankPad}-${slug}-s${slidePad}`;
    const dirPath = join(worstParent, dirName);
    await mkdir(dirPath, { recursive: true });

    // 1. strip.png
    const stripImg = renderDiagnosticStrip(packet.ref, packet.cand);
    const stripBuf = encodePng(stripImg);
    await writeFile(join(dirPath, 'strip.png'), stripBuf);

    // 2. pro7-slide.json
    const pro7Slide = packet.source?.pro7SlideJson ?? packet.source ?? { note: 'no raw pro7 source' };
    await writeFile(join(dirPath, 'pro7-slide.json'), JSON.stringify(pro7Slide, null, 2), 'utf8');

    // 3. ordo-slide.json
    const ordoSlide = {
      deck: packet.deckName,
      n: packet.score.n,
      ssim: packet.score.ssim,
      ssimBlack: packet.score.ssimBlack,
      ssimWhite: packet.score.ssimWhite,
      overallMae: packet.score.overallMae,
      backgroundMae: packet.score.backgroundMae,
      alphaMae: packet.score.alphaMae,
      boxMaes: packet.score.boxMaes,
      slide: packet.slide,
    };
    await writeFile(join(dirPath, 'ordo-slide.json'), JSON.stringify(ordoSlide, null, 2), 'utf8');

    worstDirs.push(dirPath);
  }

  return { summaryPath, reportPath, worstDirs };
}
