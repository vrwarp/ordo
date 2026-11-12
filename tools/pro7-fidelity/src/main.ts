import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { importPro7 } from '@ordo/importers';
import { parseArgs } from './args.ts';
import { buildSyntheticCorpus } from './corpus.ts';
import {
  buildFeatureClusters,
  type DiagnosticSlidePacketInput,
  writeDiagnosticArtifacts,
} from './diagnostics.ts';
import { extractDeckSlideSources } from './features.ts';
import { decodePng, encodePng, readPng } from './png.ts';
import { loadSampleBundle, prepareMediaPoster } from './posters.ts';
import { compareBaseline } from './ratchet.ts';
import { Pro7HeadlessRenderer } from './renderer.ts';
import { scoreSlideImages } from './score.ts';
import type { DeckScore, SlideScore, SummaryReport } from './types.ts';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function matchesDeckFilter(deckName: string, filter: ReadonlySet<string> | undefined): boolean {
  if (!filter || filter.size === 0) return true;
  const lower = deckName.toLowerCase();
  const norm = lower.replace(/[:/]/g, '_');
  const slug = slugify(deckName);
  return filter.has(lower) || filter.has(norm) || filter.has(slug);
}

function slideFilterForDeck(
  deckName: string,
  slidesMap: ReadonlyMap<string, Set<number>> | undefined,
): ReadonlySet<number> | undefined {
  if (!slidesMap || slidesMap.size === 0) return undefined;
  const lower = deckName.toLowerCase();
  const norm = lower.replace(/[:/]/g, '_');
  const slug = slugify(deckName);
  return slidesMap.get(lower) ?? slidesMap.get(norm) ?? slidesMap.get(slug);
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function resolveUserPath(p: string, mustExist = false): string {
  if (isAbsolute(p)) return p;
  const initCwd = process.env.INIT_CWD;
  if (initCwd) {
    const fromInit = resolve(initCwd, p);
    if (!mustExist || existsSync(fromInit)) return fromInit;
  }
  return resolve(p);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolveUserPath(args.outDir);
  const cacheDir = join(outDir, '.cache');
  await mkdir(cacheDir, { recursive: true });
  const rendersDir = join(outDir, 'renders');
  await mkdir(rendersDir, { recursive: true });

  const deckScores: DeckScore[] = [];
  const packets: DiagnosticSlidePacketInput[] = [];

  const renderer = await Pro7HeadlessRenderer.open();
  try {
    // 1. Real ProPresenter 7 sample bundle (when --sample-dir / ORDO_PRO7_SAMPLE_DIR is set)
    if (args.sampleDir) {
      const sampleDir = resolveUserPath(args.sampleDir, true);
      const bundle = await loadSampleBundle(sampleDir, cacheDir);
      const imported = await importPro7(bundle.files, {
        phase: 'documents',
        exportCompat: args.exportCompat,
      });

      const presById = new Map(imported.presentations.map((p) => [p.id, p]));
      const refByPath = new Map(imported.refs.map((r) => [r.path, r]));

      // Discover per-video thumbnailPosition from raw .pro documents so static poster comparison
      // uses the exact video frame ProPresenter exports (`video.video.thumbnailPosition`, default 0).
      const thumbTimeByBase = new Map<string, number>();
      for (const entry of bundle.decks) {
        const sources = extractDeckSlideSources(entry.proBytes, { exportCompat: args.exportCompat });
        for (const s of sources) {
          const actions = (s.pro7SlideJson.mediaActions ?? []) as Record<string, unknown>[];
          for (const a of actions) {
            const mEl = ((a.media as Record<string, unknown> | undefined)?.element ?? {}) as Record<
              string,
              unknown
            >;
            const urlObj = (mEl.url ?? {}) as { absoluteString?: string; local?: { path?: string } };
            const rawUrl = urlObj.local?.path ?? urlObj.absoluteString ?? '';
            const base = rawUrl.split(/[/\\]/).pop()?.toLowerCase();
            const pos = (
              (mEl.video as Record<string, unknown> | undefined)?.video as
                | { thumbnailPosition?: number }
                | undefined
            )?.thumbnailPosition;
            if (base && typeof pos === 'number' && pos >= 0) {
              thumbTimeByBase.set(base, pos);
            }
          }
        }
      }

      // Prepare media posters once for all referenced media
      const mediaFiles = new Map<string, string>();
      for (const m of imported.media) {
        const diskPath = bundle.onDisk.get(m.path);
        if (!diskPath) continue;
        const base = m.path.split('/').pop()?.toLowerCase() ?? '';
        const timeSec = thumbTimeByBase.get(base) ?? 0;
        const posterPath = await prepareMediaPoster(diskPath, cacheDir, { timeSec });
        mediaFiles.set(m.key, posterPath);
      }

      for (const entry of bundle.decks) {
        if (!matchesDeckFilter(entry.name, args.decks)) continue;
        if (args.slides && args.slides.size > 0 && !slideFilterForDeck(entry.name, args.slides)) continue;

        const ref = refByPath.get(entry.proPath);
        const pres = ref ? presById.get(ref.id) : undefined;
        if (!pres) {
          console.warn(`[pro7-fidelity] Missing imported presentation for ${entry.proPath}`);
          continue;
        }

        const slides = pres.sections.flatMap((s) => s.slides);
        const sources = extractDeckSlideSources(entry.proBytes, { exportCompat: args.exportCompat });
        const onlySlides = slideFilterForDeck(entry.name, args.slides);

        if (slides.length !== entry.refPngPaths.length) {
          console.warn(
            `[pro7-fidelity] Slide count mismatch on "${entry.name}": imported=${slides.length}, refPngs=${entry.refPngPaths.length}`,
          );
        }

        const rendered = await renderer.renderDeck({
          slides,
          presentationBackgroundMediaId: pres.backgroundMediaId,
          mediaFiles,
          onlySlides,
        });

        const deckRenderDir = join(rendersDir, slugify(entry.name));
        await mkdir(deckRenderDir, { recursive: true });

        const perSlide: SlideScore[] = [];
        const count = Math.min(slides.length, entry.refPngPaths.length);
        for (let i = 0; i < count; i++) {
          const n = i + 1;
          if (onlySlides && !onlySlides.has(n)) continue;
          const r = rendered.get(n);
          if (!r) continue;

          const ordoPngPath = join(deckRenderDir, `${n}.png`);
          await writeFile(ordoPngPath, r.png);

          const refPngPath = entry.refPngPaths[i]!;
          const refImg = await readPng(refPngPath);
          const candImg = decodePng(r.png);
          const src = sources[i];
          const slide = slides[i]!;

          const score = scoreSlideImages({
            n,
            ref: refImg,
            cand: candImg,
            slide,
            features: src?.features ?? [],
            refPngPath,
            ordoPngPath,
            ms1920: r.ms1920,
          });
          perSlide.push(score);
          packets.push({
            deckName: entry.name,
            score,
            ref: refImg,
            cand: candImg,
            slide,
            source: src,
          });
        }

        if (perSlide.length === 0) continue;
        const deckNotes = imported.log
          .filter((l) => l.item === entry.proPath || l.item === pres.title)
          .map((l) => `[${l.level}] ${l.message}`);

        const ssimVals = perSlide.map((s) => s.ssim);
        deckScores.push({
          name: entry.name,
          kind: 'sample',
          title: pres.title,
          slideCount: perSlide.length,
          ssim: Math.round(mean(ssimVals) * 10000) / 10000,
          minSlideSsim: Math.round(Math.min(...ssimVals) * 10000) / 10000,
          perSlide,
          importNotes: deckNotes,
        });
      }
    }

    // 2. Synthetic deterministic probe corpus (--corpus or default when no sampleDir)
    if (args.corpus) {
      const synthDecks = buildSyntheticCorpus();
      for (const sdeck of synthDecks) {
        if (!matchesDeckFilter(sdeck.name, args.decks)) continue;
        if (args.slides && args.slides.size > 0 && !slideFilterForDeck(sdeck.name, args.slides)) continue;

        const imported = await importPro7(sdeck.files, {
          phase: 'documents',
          exportCompat: args.exportCompat,
        });
        const pres = imported.presentations[0];
        if (!pres) continue;

        const proBytes = sdeck.files.get(sdeck.proFileName);
        const sources = proBytes
          ? extractDeckSlideSources(proBytes, { exportCompat: args.exportCompat })
          : [];
        const slides = pres.sections.flatMap((s) => s.slides);
        const onlySlides = slideFilterForDeck(sdeck.name, args.slides);

        const deckRenderDir = join(rendersDir, slugify(sdeck.name));
        await mkdir(deckRenderDir, { recursive: true });

        const synthMediaFiles = new Map<string, string>();
        for (let mi = 0; mi < imported.media.length; mi++) {
          const m = imported.media[mi]!;
          const bytes = sdeck.files.get(m.path);
          if (!bytes) continue;
          const mediaOutPath = join(deckRenderDir, `_media_${mi}.png`);
          await writeFile(mediaOutPath, bytes);
          synthMediaFiles.set(m.key, mediaOutPath);
        }

        const rendered = await renderer.renderDeck({
          slides,
          presentationBackgroundMediaId: pres.backgroundMediaId,
          mediaFiles: synthMediaFiles,
          onlySlides,
        });

        const perSlide: SlideScore[] = [];
        const count = Math.min(slides.length, sdeck.referenceSlides.length);
        for (let i = 0; i < count; i++) {
          const n = i + 1;
          if (onlySlides && !onlySlides.has(n)) continue;
          const r = rendered.get(n);
          if (!r) continue;

          const ordoPngPath = join(deckRenderDir, `${n}.png`);
          const refPngPath = join(deckRenderDir, `${n}.ref.png`);
          const refImg = sdeck.referenceSlides[i]!;
          await writeFile(ordoPngPath, r.png);
          await writeFile(refPngPath, encodePng(refImg));

          const candImg = decodePng(r.png);
          const src = sources[i];
          const slide = slides[i]!;

          const score = scoreSlideImages({
            n,
            ref: refImg,
            cand: candImg,
            slide,
            features: src?.features ?? [],
            refPngPath,
            ordoPngPath,
            ms1920: r.ms1920,
          });
          perSlide.push(score);
          packets.push({
            deckName: sdeck.name,
            score,
            ref: refImg,
            cand: candImg,
            slide,
            source: src,
          });
        }

        if (perSlide.length === 0) continue;
        const ssimVals = perSlide.map((s) => s.ssim);
        deckScores.push({
          name: sdeck.name,
          kind: 'synthetic',
          title: pres.title,
          slideCount: perSlide.length,
          ssim: Math.round(mean(ssimVals) * 10000) / 10000,
          minSlideSsim: Math.round(Math.min(...ssimVals) * 10000) / 10000,
          perSlide,
          importNotes: imported.log.map((l) => `[${l.level}] ${l.message}`),
        });
      }
    }
  } finally {
    await renderer.close();
  }

  const allSlides = deckScores.flatMap((d) => d.perSlide.map((s) => s.ssim));
  const sampleSlides = deckScores
    .filter((d) => d.kind === 'sample')
    .flatMap((d) => d.perSlide.map((s) => s.ssim));
  const synthSlides = deckScores
    .filter((d) => d.kind === 'synthetic')
    .flatMap((d) => d.perSlide.map((s) => s.ssim));

  const clusters = buildFeatureClusters(deckScores);
  const summary: SummaryReport = {
    createdAt: new Date().toISOString(),
    exportCompat: args.exportCompat,
    meanSsim: Math.round(mean(allSlides) * 10000) / 10000,
    sampleMeanSsim: sampleSlides.length ? Math.round(mean(sampleSlides) * 10000) / 10000 : undefined,
    syntheticMeanSsim: synthSlides.length ? Math.round(mean(synthSlides) * 10000) / 10000 : undefined,
    totalSlides: allSlides.length,
    decks: deckScores,
    clusters,
  };

  const written = await writeDiagnosticArtifacts({
    outDir,
    summary,
    packets,
    worstCount: args.worstCount,
  });

  console.log(
    `[pro7-fidelity] Scored ${summary.totalSlides} slide(s) across ${summary.decks.length} deck(s) -> mean SSIM ${(summary.meanSsim * 100).toFixed(2)}%`,
  );
  if (summary.sampleMeanSsim !== undefined) {
    console.log(`  Sample corpus mean SSIM:    ${(summary.sampleMeanSsim * 100).toFixed(2)}%`);
  }
  if (summary.syntheticMeanSsim !== undefined) {
    console.log(`  Synthetic corpus mean SSIM: ${(summary.syntheticMeanSsim * 100).toFixed(2)}%`);
  }
  for (const d of summary.decks) {
    console.log(
      `  - ${d.name.padEnd(24)} (${String(d.slideCount).padStart(2)} slides): mean ${(d.ssim * 100).toFixed(2)}%, min ${(d.minSlideSsim * 100).toFixed(2)}%`,
    );
  }
  console.log(`  Report:  ${written.reportPath}`);
  console.log(`  Summary: ${written.summaryPath}`);

  if (args.writeBaselinePath) {
    const outBase = resolveUserPath(args.writeBaselinePath);
    const cleanBaseline: SummaryReport = {
      ...summary,
      decks: summary.decks.map((d) => ({
        ...d,
        perSlide: d.perSlide.map((s) => ({
          ...s,
          ...(s.refPngPath ? { refPngPath: `renders/${slugify(d.name)}/${s.n}.ref.png` } : {}),
          ...(s.ordoPngPath ? { ordoPngPath: `renders/${slugify(d.name)}/${s.n}.png` } : {}),
          ms1920: 0,
        })),
      })),
    };
    await writeFile(outBase, `${JSON.stringify(cleanBaseline, null, 2)}\n`, 'utf8');
    console.log(`  Wrote baseline: ${outBase}`);
  }

  if (args.baselinePath) {
    const baseRaw = await readFile(resolveUserPath(args.baselinePath, true), 'utf8');
    const baseline = JSON.parse(baseRaw) as SummaryReport;
    const cmp = compareBaseline(summary, baseline, {
      maxSlideDrop: args.maxSlideDrop,
      maxDeckDrop: args.maxDeckDrop,
      requireGain: args.requireGain,
      slidesFilter: args.slides,
    });
    console.log('\n[pro7-fidelity] Baseline Comparison:');
    for (const line of cmp.lines) console.log(`  ${line}`);
    if (args.ratchet && !cmp.passed) {
      console.error('[pro7-fidelity] RATCHET FAILED');
      return 1;
    }
  }

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('[pro7-fidelity] Fatal error:', err);
    process.exitCode = 1;
  });
