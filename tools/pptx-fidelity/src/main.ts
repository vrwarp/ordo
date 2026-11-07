/**
 * PowerPoint fidelity: draw decks with LibreOffice (the ground truth for now), with pptx-preview (with and
 * without ordo's corrections) and natively (`@ordo/pptx-scene` drawn by `@ordo/renderer`, design/27
 * §14.1), score every slide against LibreOffice, and write a report.
 *
 *   pnpm --filter @ordo/pptx-fidelity start -- [--engine ppv|native|both] [--no-ppv] [--corpus]
 *        [--out DIR] [--chromium PATH] [--raw] [--fresh-lo] [--manifest FILE] [--baseline FILE]
 *        [--max-drop 0.02] [--lo-compat] [--slides [DECK:]LIST]... [--script-stand-ins]
 *        [--before hub|paste] [--hub dist|source] [--no-libreoffice] [--hub-budget] [deck.pptx | dir]...
 *
 * Folders are searched with their subfolders for PresentationML decks (src/decks.ts `DECK_RE`); a deck any
 * renderer cannot draw is recorded in its notes and the run goes on. README.md lists the per-slide fields.
 *
 * --engine      which renderers to score: pptx-preview (ppv, the default), native, or both
 * --no-ppv      leave pptx-preview out whatever --engine says (alone, only LibreOffice's pictures are made)
 * --corpus      include the synthetic decks (src/corpus.ts)
 * --raw         also draw with pptx-preview unmodified, to show what the corrections are worth
 * --fresh-lo    redraw the LibreOffice pictures even when they exist (they are the slow part); otherwise
 *               <out>/<deck>/libreoffice/slide-NNNN.png from an earlier run are reused
 * --manifest    a suite manifest (JSON: a list, or an object by deck name, with `features` and
 *               `worshipRelevance`/`worship`): the report adds per-feature means, worship decks first
 * --baseline    compare with an earlier summary.json or native-baseline.json and print the change per
 *               deck; with the native engine, a worship deck (every deck without --manifest) whose native
 *               SSIM drops by more than --max-drop (default 0.02) fails the run. Native scores are those of
 *               the slides as ordo draws them in both runs (a --lo-compat run's own-policy pictures), over
 *               the slides this run scored (src/baseline.ts)
 * --lo-compat   draw native slides as LibreOffice would where ordo's policy (PowerPoint's) differs: no run
 *               shadows, no outline on filled text, autofit only for a shape's own normAutofit and fitted
 *               again from full size (design/27 §14.1; the converter's `EmitOptions.loCompat`, the rules
 *               named by src/compat.ts). Each slide a rule changes is drawn both ways; the report and
 *               summary.json give the means both ways and per rule, so a policy gain never passes for
 *               progress
 * --slides      score only these slides (1-based, as the report numbers them): `3,5-7` for every deck, or
 *               `DECK:3,5-7` for the decks whose run name contains DECK (decks no list names are left out).
 *               May be repeated. LibreOffice and pptx-preview still draw whole decks; only native draws less
 * --script-stand-ins  where a script fallback family (Noto Sans Hebrew, Noto Naskh Arabic, …) is not
 *               installed, register fontconfig's face for the script's language under its name, as an
 *               output would have the family; by default such glyphs fall back as LibreOffice's do
 * --before hub  also score what a hub with LibreOffice shows (`perSlide.beforeHubSsim`, src/beforehub.ts):
 *               each deck with a slide the hub does not store native (or with pending metafiles) is imported
 *               through this checkout's hub, and its version 2 of those slides is drawn and scored; the
 *               pixel paste (LibreOffice's pixels over the art box and the metafiles, its page for a picture
 *               slide) is kept as `beforeHubPaste` and stands in where the hub gave no score
 *               (`beforeHubFrom` says which). `--before paste`: the paste alone
 * --hub         the hub `--before hub` imports through: `source` (this checkout's, the default) or `dist`
 * --no-libreoffice  also score what a hub without LibreOffice shows (`perSlide.noLoSsim`): the deck emitted
 *               with `EmitOptions.libreoffice: false` (art and metafile conversions left out, listed in
 *               `perSlide.missing`), each slide as the hub stores it (a picture slide: no objects)
 * --hub-budget  draw every slide as the hub stores it once its budgets ran (`native.ts` `withHubBudget`:
 *               today a slide the hub makes a picture loses its objects; the M9 budget ladder fills the hook)
 *
 * Real decks stay outside the repository: pass their paths. The score is SSIM of greyscale pictures at
 * 960x540 (1 = identical), computed by ffmpeg. A native run also writes <out>/native-baseline.json.
 *
 * The native column draws with the renderer's font resolver, as the outputs do (src/fonts.ts: fontconfig's
 * face for every family the slides ask for, ordo's default face and the script fallbacks installed here). summary.json and the report give, besides tiers, classes and reasons, the text features of each
 * slide's XML (src/features.ts) with means per feature, per tier and per deck next to the M2 targets, and
 * the LibreOffice policy rules each slide hits.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { renderWithPptxPreview } from '@ordo/pptx-render';
import { parseArgs, slidesFor } from './args.ts';
import { type BaselineDeck, compareBaseline } from './baseline.ts';
import { BeforeHub, type HubBefore, type HubScores, needsHub, pasteSsim } from './beforehub.ts';
import { hubClasses } from './census.ts';
import { drawingKey } from './compat/index.ts';
import { buildCorpus } from './corpus.ts';
import { DECK_RE, listDecks } from './decks.ts';
import { deckHash, exceptionMarks } from './exceptions.ts';
import { hubEntry } from './hub-import.ts';
import { drawWithLibreOffice } from './libreoffice.ts';
import {
  convertDeckIsolated,
  hubStoredSlide,
  NativeRenderer,
  type RenderedDeck,
  withHubBudget,
} from './native.ts';
import { png } from './png.ts';
import { ssim } from './ssim.ts';
import {
  type DeckScore,
  mean,
  nativeStats,
  nativeTables,
  type SlideScore,
  type Summary,
  writeReport,
} from './report.ts';

async function findChromium(given?: string): Promise<string> {
  if (given) return given;
  if (process.env.ORDO_CHROMIUM) return process.env.ORDO_CHROMIUM;
  try {
    const exe = (await import('@playwright/test')).chromium.executablePath();
    if (existsSync(exe)) return exe;
  } catch {
    /* not installed */
  }
  for (const exe of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'])
    if (existsSync(exe)) return exe;
  return 'chromium';
}

/** Decks given as files, or found in folders (and their subfolders), each with a name unique in the run. */
async function decksIn(paths: string[]): Promise<{ file: string; name: string }[]> {
  const out = await listDecks(paths);
  // A link whose deck is gone is not a deck the converter failed on: it is left out of the run and its means.
  for (const d of out) if (!d.exists) console.log(`skipped ${d.name}: the deck file is missing`);
  return out.filter((d) => d.exists).map(({ file, name }) => ({ file, name }));
}

async function pngsIn(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

async function drawWithPptxPreview(
  deck: string,
  outDir: string,
  chromium: string,
  fixes: boolean,
): Promise<{ pages: string[]; styled: number; notes: string[] }> {
  const work = join(outDir, '.work');
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  try {
    const r = await renderWithPptxPreview(deck, work, { chromium, timeoutMs: 300_000, fixes });
    const out: string[] = [];
    for (let i = 0; i < r.pages.length; i++) {
      const f = join(outDir, `slide-${String(i + 1).padStart(4, '0')}.png`);
      await copyFile(r.pages[i]!, f);
      out.push(f);
    }
    return { pages: out, styled: r.styled, notes: r.notes };
  } catch (e) {
    return { pages: [], styled: 0, notes: [`failed: ${(e as Error).message}`] };
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** SSIM of each page against the other renderer's (0 where it drew none), for the slides `keep` keeps. */
async function scoreAll(
  lo: string[],
  other: string[],
  keep: (n: number) => boolean = () => true,
): Promise<(number | undefined)[]> {
  const out: (number | undefined)[] = [];
  for (let i = 0; i < lo.length; i++)
    out.push(!keep(i + 1) ? undefined : other[i] ? await ssim(lo[i]!, other[i]!) : 0);
  return out;
}

const defined = <T>(xs: (T | undefined)[]): T[] => xs.filter((x): x is T => x !== undefined);

/** A deck name as the run and a manifest both spell it: folders as `__`, no extension, safe characters. */
function deckKey(name: string): string {
  return name
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('__')
    .replace(DECK_RE, '')
    .replace(/[^\p{L}\p{M}\p{N}_.-]+/gu, '_')
    .toLowerCase();
}

type ManifestEntry = { worship: boolean; features: string[] };

/**
 * A suite manifest: a list of `{name | file | path, features, worshipRelevance | worship | why}`, or an
 * object of such entries by deck name. Each entry is found by its full name and by its file name.
 */
async function loadManifest(file: string): Promise<Map<string, ManifestEntry>> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
  const list: [string | undefined, Record<string, unknown>][] = Array.isArray(raw)
    ? raw.map((e) => [undefined, e as Record<string, unknown>])
    : Object.entries(raw as Record<string, Record<string, unknown>>);
  const out = new Map<string, ManifestEntry>();
  for (const [key, e] of list) {
    if (!e || typeof e !== 'object') continue;
    const why = Array.isArray(e.why) ? e.why : [];
    const entry: ManifestEntry = {
      worship: e.worshipRelevance === 'high' || e.worship === true || why.includes('worship'),
      features: Array.isArray(e.features) ? e.features.filter((f): f is string => typeof f === 'string') : [],
    };
    const names = [key, e.name, e.file, e.path].filter((n): n is string => typeof n === 'string');
    for (const n of names) {
      if (n !== e.path && !out.has(deckKey(n))) out.set(deckKey(n), entry);
      const base = deckKey(basename(n.replace(/\\/g, '/')));
      if (!out.has(base)) out.set(base, entry);
    }
  }
  return out;
}

/** An all-black PNG of a size, made once per run: the floor every renderer has to beat. */
const blackFiles = new Map<string, string>();
async function blackPng(dir: string, w: number, h: number): Promise<string> {
  const key = `${w}x${h}`;
  let f = blackFiles.get(key);
  if (!f) {
    await mkdir(dir, { recursive: true });
    f = join(dir, `black-${key}.png`);
    await writeFile(
      f,
      png(w, h, () => [0, 0, 0, 255]),
    );
    blackFiles.set(key, f);
  }
  return f;
}

/**
 * The SSIM of an all-black frame against each LibreOffice page, kept next to the pages
 * (`libreoffice/black-ssim.json`) so a run that reuses the pages does not score black again. An entry is
 * keyed by the page's name, size on disk and modification time, and the black frame's size.
 */
async function blackScores(loDir: string): Promise<{
  get: (page: string, w: number, h: number, black: () => Promise<string>) => Promise<number>;
  save: () => Promise<void>;
}> {
  const file = join(loDir, 'black-ssim.json');
  const known = new Map<string, number>();
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (raw && typeof raw === 'object')
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'number') known.set(k, v);
  } catch {
    /* none yet */
  }
  let changed = false;
  return {
    async get(page, w, h, black) {
      const st = await stat(page);
      const key = `${basename(page)}|${st.size}|${Math.round(st.mtimeMs)}|${w}x${h}`;
      let v = known.get(key);
      if (v === undefined) {
        v = await ssim(page, await black());
        known.set(key, v);
        changed = true;
      }
      return v;
    },
    async save() {
      if (changed) await writeFile(file, JSON.stringify(Object.fromEntries(known)));
    },
  };
}

/** What the native column is asked for (the run's flags). */
type NativeOpts = {
  only?: ReadonlySet<number>;
  loCompat: boolean;
  standIns: boolean;
  before?: 'hub' | 'paste';
  noLibreOffice: boolean;
  hubBudget: boolean;
  /** The deck file's SHA-256 (`exceptions.ts`). */
  sha256?: string;
};

/**
 * The native column for one deck: convert, draw, score against LibreOffice's pages. Fills the deck's
 * native fields and returns one score per slide (LibreOffice's pages, plus shown slides it did not draw).
 */
async function nativeColumn(
  deck: string,
  dir: string,
  out: string,
  lo: string[],
  renderer: () => Promise<NativeRenderer>,
  beforeHub: () => BeforeHub,
  opts: NativeOpts,
): Promise<{ fields: Partial<DeckScore>; perSlide: SlideScore[] }> {
  const t0 = performance.now();
  const nd = join(dir, 'native');
  await rm(nd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(nd, { recursive: true });
  const converted = await convertDeckIsolated(deck, nd, {
    loCompat: opts.loCompat,
    noLibreOffice: opts.noLibreOffice,
  });
  const notes = [...converted.notes];
  // Each slide's class once the hub's budgets ran (`census.ts`), by deck index, on the slides as emitted.
  const hub = hubClasses(converted.slides, converted.geoms ?? []);
  const hubOf = new Map(converted.slides.map((s, k) => [s.index, hub[k]!]));
  const conv = opts.hubBudget
    ? withHubBudget(
        converted,
        hub.map((h) => h.hub),
      )
    : converted;
  // Without LibreOffice (M9): what the hub stores of each slide emitted that way, drawn where it differs.
  if (opts.noLibreOffice) {
    const drawnOf = (s: (typeof conv.slides)[number]) =>
      (opts.loCompat ? s.compatSlide : undefined) ?? s.slide;
    const input = conv.slides.map((s) => ({
      class: s.noLoClass ?? s.class,
      slide: s.noLoSlide ?? drawnOf(s),
      notes: s.notes,
    }));
    const stored = hubClasses(input, conv.geoms ?? []);
    for (const [k, s] of conv.slides.entries()) {
      const nl = hubStoredSlide(input[k]!.slide, stored[k]!.hub);
      if (drawingKey(nl) !== drawingKey(drawnOf(s))) s.noLoDraw = nl;
    }
  }
  const shown = conv.slides.filter((s) => s.shown !== undefined).sort((a, b) => a.shown! - b.shown!);
  // `--slides` numbers are 1-based; the renderer's are shown indexes.
  const only = opts.only ? new Set([...opts.only].map((n) => n - 1)) : undefined;
  let drawn: RenderedDeck = { slides: [], notes: [], ms: 0 };
  if (shown.some((s) => !only || only.has(s.shown!))) {
    try {
      drawn = await (await renderer()).renderDeck(conv, nd, {
        only,
        loCompat: opts.loCompat,
        standIns: opts.standIns,
        noLo: opts.noLibreOffice,
      });
    } catch (e) {
      notes.push(`not drawn: ${(e as Error).message.slice(0, 300)}`);
    }
  }
  notes.push(...drawn.notes);
  const nativeMs = Math.round(performance.now() - t0);
  if (lo.length && !conv.error && shown.length !== lo.length)
    notes.push(`${shown.length} shown slide(s) where LibreOffice drew ${lo.length} page(s)`);
  const pics = new Map(drawn.slides.map((r) => [r.shown, r]));
  const blacks = await blackScores(join(dir, 'libreoffice'));
  const pasted = join(nd, '.beforehub.png');
  const n = Math.max(lo.length, shown.length);
  const rect = conv.slideRect;
  // What the hub showed (`beforehub.ts`), for the slides it does not store as the native column draws them;
  // a shown slide the converter did not emit is a LibreOffice picture there.
  const before = (i: number): HubBefore | undefined => {
    const s = shown[i];
    const h = s ? hubOf.get(s.index) : undefined;
    return s && h
      ? { hub: h.hub, ...(s.art ? { art: s.art } : {}), ...(s.metafiles ? { metafiles: s.metafiles } : {}) }
      : undefined;
  };
  const asked = new Set<number>();
  for (let i = 0; i < n; i++) if (lo[i] && (!only || only.has(i)) && needsHub(before(i))) asked.add(i);
  let fromHub: HubScores = { scores: new Map(), failed: new Set(), notes: [] };
  if (opts.before === 'hub' && asked.size)
    fromHub = await beforeHub().score({
      deck,
      shown: asked,
      lo,
      rect,
      renderer: await renderer(),
      work: join(nd, '.hub'),
    });
  notes.push(...fromHub.notes);
  const perSlide: SlideScore[] = [];
  for (let i = 0; i < n; i++) {
    if (only && !only.has(i)) continue;
    const s = shown[i];
    const r = pics.get(i);
    const pic = r?.png ? join(nd, r.png) : undefined;
    const policyPic = r?.policyPng ? join(nd, r.policyPng) : undefined;
    const noLoPic = r?.noLoPng ? join(nd, r.noLoPng) : undefined;
    const score: SlideScore = {
      n: i + 1,
      ...(lo[i] ? { libreoffice: relative(out, lo[i]!) } : {}),
      ...(pic ? { native: relative(out, pic) } : {}),
      ...(policyPic ? { nativePolicy: relative(out, policyPic) } : {}),
      ...(noLoPic ? { nativeNoLo: relative(out, noLoPic) } : {}),
    };
    const h = s ? hubOf.get(s.index) : undefined;
    if (lo[i]) {
      score.nativeSsim = pic ? await ssim(lo[i]!, pic) : 0;
      if (policyPic) score.policySsim = await ssim(lo[i]!, policyPic);
      const w = r?.width ?? Math.max(1, Math.round(rect.w));
      const ht = r?.height ?? Math.max(1, Math.round(rect.h));
      const black = () => blackPng(join(out, '.black'), w, ht);
      score.blackSsim = await blacks.get(lo[i]!, w, ht, black);
      if (opts.noLibreOffice) score.noLoSsim = noLoPic ? await ssim(lo[i]!, noLoPic) : score.nativeSsim;
      if (opts.before) {
        const b = before(i);
        if (!asked.has(i)) score.beforeHubSsim = score.nativeSsim;
        else {
          // A slide the converter did not emit is a LibreOffice picture in the hub.
          const paste = await pasteSsim(b ?? { hub: 'picture' }, {
            lo: lo[i]!,
            native: pic ?? (await black()),
            nativeSsim: score.nativeSsim,
            rect,
            scratch: pasted,
          });
          score.beforeHubPaste = paste;
          const real = fromHub.scores.get(i);
          score.beforeHubSsim = real ?? paste;
          score.beforeHubFrom = real !== undefined ? 'hub' : 'paste';
          if (real !== undefined && fromHub.failed.has(i)) score.beforeHubFailed = true;
        }
      }
    }
    if (s) {
      score.tier = s.tier;
      score.class = s.class;
      if (h && h.hub !== s.class) score.hub = h.hub;
      score.reasons = s.reasons;
      score.convertMs = Math.round(s.convertMs * 100) / 100;
      if (s.textFeatures.length) score.textFeatures = s.textFeatures;
      if (s.xmlFeatures?.length) score.xmlFeatures = s.xmlFeatures;
      if (s.compat.length) score.compat = s.compat;
      if (s.metafiles?.length) score.metafiles = s.metafiles.length;
      if (s.missing?.length) score.missing = s.missing;
    }
    if (opts.sha256) Object.assign(score, exceptionMarks(opts.sha256, i + 1));
    if (r?.rasterMs) score.rasterMs = r.rasterMs;
    if (r?.coldMs) score.coldMs = r.coldMs;
    if (r?.maxObjectMs) score.maxObjectMs = r.maxObjectMs;
    if (r?.maxObjectId) score.maxObjectId = r.maxObjectId;
    perSlide.push(score);
  }
  await blacks.save();
  await rm(pasted, { force: true });
  const scored = perSlide.filter((p) => p.nativeSsim !== undefined);
  return {
    fields: {
      nativeSlides: shown.length,
      ...(scored.length ? { nativeSsim: mean(scored.map((p) => p.nativeSsim!)) } : {}),
      ...(opts.before && scored.length
        ? { beforeHubSsim: mean(scored.map((p) => p.beforeHubSsim ?? p.nativeSsim!)) }
        : {}),
      ...(opts.noLibreOffice && scored.length
        ? { noLoSsim: mean(scored.map((p) => p.noLoSsim ?? p.nativeSsim!)) }
        : {}),
      ...(opts.loCompat && scored.length
        ? { nativePolicySsim: mean(scored.map((p) => p.policySsim ?? p.nativeSsim!)) }
        : {}),
      ...(conv.textFeatures.length ? { textFeatures: conv.textFeatures } : {}),
      ...(conv.xmlFeatures?.length ? { xmlFeatures: conv.xmlFeatures } : {}),
      nativeMs,
      convertMs: Math.round(conv.extractMs + conv.parseMs + conv.emitMs),
      ...(conv.embeddedFonts ? { embeddedFonts: true } : {}),
      nativeNotes: notes,
    },
    perSlide,
  };
}

/** Merge two per-slide lists by slide number (pptx-preview's and native's scores of the same pages). */
function mergeSlides(a: SlideScore[], b: SlideScore[]): SlideScore[] {
  const by = new Map<number, SlideScore>();
  for (const s of [...a, ...b]) by.set(s.n, { ...by.get(s.n), ...s });
  return [...by.values()].sort((x, y) => x.n - y.n);
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  // Stopped from outside: exit, so the 'exit' handlers stop the hub `--before hub` started.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => process.exit(130));
  const out = resolve(a.out);
  await mkdir(out, { recursive: true });
  const chromium = await findChromium(a.chromium);
  const decks = await decksIn(a.decks);
  if (a.corpus)
    decks.unshift(...(await buildCorpus(join(out, 'corpus'))).map((f) => ({ file: f, name: basename(f) })));
  if (!decks.length) throw new Error('no decks: pass .pptx files or folders, or --corpus');
  const manifest = a.manifest ? await loadManifest(a.manifest) : undefined;
  const ppvOn = a.engines.has('ppv');
  const nativeOn = a.engines.has('native');

  // Chromium for the native column starts with the first deck that needs it, once for the run.
  let nativeRenderer: Promise<NativeRenderer> | undefined;
  let rendererReady: NativeRenderer | undefined;
  const renderer = () => {
    nativeRenderer ??= NativeRenderer.start(chromium).then((r) => {
      rendererReady = r;
      return r;
    });
    return nativeRenderer;
  };
  // `--before hub`: this checkout's hub, LibreOffice present, started with the first deck that needs it.
  let hubBefore: BeforeHub | undefined;
  const beforeHub = () =>
    (hubBefore ??= new BeforeHub({ dir: join(out, '.hub'), entry: hubEntry(a.hub ?? 'source') }));

  const scores: DeckScore[] = [];
  const summaryOf = (tables = false): Summary => {
    const ppv = scores.filter((s) => s.ssim !== undefined);
    const nat = scores.filter((s) => s.nativeSsim !== undefined);
    const counted = nat.filter((s) => !s.embeddedFonts);
    const worship = scores.filter((d) => d.worship);
    return {
      createdAt: new Date().toISOString(),
      chromium,
      engines: [...a.engines],
      ...(ppv.length ? { mean: mean(ppv.map((s) => s.ssim!)) } : {}),
      ...(nat.length
        ? {
            nativeMean: mean(counted.map((s) => s.nativeSsim!)),
            nativeMeanAll: mean(nat.map((s) => s.nativeSsim!)),
          }
        : {}),
      ...(nativeOn && a.loCompat
        ? {
            loCompat: true,
            nativePolicyMean: mean(counted.map((s) => s.nativePolicySsim ?? s.nativeSsim!)),
          }
        : {}),
      ...(nativeOn && a.before
        ? { before: a.before, beforeHubMean: mean(counted.map((s) => s.beforeHubSsim ?? s.nativeSsim!)) }
        : {}),
      ...(nativeOn && a.noLibreOffice
        ? { noLibreOffice: true, noLoMean: mean(counted.map((s) => s.noLoSsim ?? s.nativeSsim!)) }
        : {}),
      ...(nativeOn && a.hubBudget ? { hubBudget: true } : {}),
      ...(a.slides.length
        ? { slides: a.slides.map((x) => ({ ...(x.deck ? { deck: x.deck } : {}), slides: [...x.slides] })) }
        : {}),
      ...(tables && nativeOn
        ? {
            native: {
              all: nativeTables(scores),
              ...(worship.length ? { worship: nativeTables(worship) } : {}),
            },
          }
        : {}),
      ...(nativeOn && rendererReady ? { scriptFallbacks: rendererReady.scriptFallbacks() } : {}),
      decks: scores,
    };
  };
  // Letters of any script stay (decks named only in Burmese or Arabic would all be "_"), and each name is
  // unique in the run: a deck's folder keeps its LibreOffice pictures for the next run to reuse.
  const taken = new Set<string>();
  try {
    for (const { file: deck, name: given } of decks) {
      const base = given.replace(DECK_RE, '').replace(/[^\p{L}\p{M}\p{N}_.-]+/gu, '_');
      let name = base;
      for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}_${i}`;
      taken.add(name.toLowerCase());
      const only = slidesFor(a.slides, name);
      if (only && !only.size) continue; // --slides names other decks
      const keep = (n: number) => !only || only.has(n);
      const dir = join(out, name);
      const loDir = join(dir, 'libreoffice');
      let lo = await pngsIn(loDir);
      const loNotes: string[] = [];
      if (!lo.length || a.freshLo) {
        await rm(loDir, { recursive: true, force: true });
        await mkdir(loDir, { recursive: true });
        // One deck LibreOffice cannot draw must not end the run: it is a finding.
        try {
          lo = await drawWithLibreOffice(deck, loDir);
        } catch (e) {
          lo = [];
          loNotes.push(`libreoffice failed: ${(e as Error).message.slice(0, 300)}`);
        }
      }
      const m = manifest?.get(deckKey(given)) ?? manifest?.get(deckKey(basename(deck)));
      const sha256 = await deckHash(deck).catch(() => undefined);
      const s: DeckScore = {
        name,
        ...(sha256 ? { sha256 } : {}),
        slides: lo.length,
        notes: loNotes,
        perSlide: lo.map((f, i) => ({ n: i + 1, libreoffice: relative(out, f) })).filter((p) => keep(p.n)),
        ...(m ? { worship: m.worship, features: m.features } : {}),
      };
      if (ppvOn) {
        const ppvDir = join(dir, 'pptx-preview');
        await rm(ppvDir, { recursive: true, force: true });
        await mkdir(ppvDir, { recursive: true });
        const t0 = performance.now();
        const ppv = await drawWithPptxPreview(deck, ppvDir, chromium, true);
        const ms = performance.now() - t0;
        let raw: { pages: string[]; notes: string[] } | undefined;
        if (a.raw) {
          const rawDir = join(dir, 'raw');
          await rm(rawDir, { recursive: true, force: true });
          await mkdir(rawDir, { recursive: true });
          raw = await drawWithPptxPreview(deck, rawDir, chromium, false);
        }
        const fixed = await scoreAll(lo, ppv.pages, keep);
        const rawScores = raw ? await scoreAll(lo, raw.pages, keep) : undefined;
        Object.assign(s, {
          ppvSlides: ppv.pages.length,
          ssim: mean(defined(fixed)),
          ...(rawScores ? { rawSsim: mean(defined(rawScores)) } : {}),
          ms: Math.round(ms),
          styled: ppv.styled,
        });
        s.notes.push(...ppv.notes);
        s.perSlide = lo
          .map((f, i) => ({
            n: i + 1,
            ssim: fixed[i]!,
            ...(rawScores ? { raw: rawScores[i]! } : {}),
            libreoffice: relative(out, f),
            ppv: ppv.pages[i] ? relative(out, ppv.pages[i]!) : undefined,
            ...(raw?.pages[i] ? { rawPpv: relative(out, raw.pages[i]!) } : {}),
          }))
          .filter((p) => keep(p.n));
      }
      if (nativeOn) {
        // Whatever the converter or the page does with this deck, the run goes on.
        try {
          const n = await nativeColumn(deck, dir, out, lo, renderer, beforeHub, {
            ...(only ? { only } : {}),
            loCompat: a.loCompat,
            standIns: a.scriptStandIns,
            ...(a.before ? { before: a.before } : {}),
            noLibreOffice: a.noLibreOffice,
            hubBudget: a.hubBudget,
            ...(sha256 ? { sha256 } : {}),
          });
          Object.assign(s, n.fields);
          s.perSlide = mergeSlides(s.perSlide, n.perSlide);
        } catch (e) {
          s.nativeSlides = 0;
          s.nativeNotes = [`native column failed: ${(e as Error).message.slice(0, 300)}`];
        }
      }
      scores.push(s);
      // The scores so far, after every deck: a long run that is stopped still leaves its results.
      await writeFile(join(out, 'summary.partial.json'), JSON.stringify(summaryOf()));
      const cols = [
        s.ssim !== undefined ? `ppv ${s.ssim.toFixed(3)}` : '',
        s.rawSsim !== undefined ? `unmodified ${s.rawSsim.toFixed(3)}` : '',
        s.ms !== undefined ? `${s.ms} ms` : '',
        s.nativeSsim !== undefined ? `native ${s.nativeSsim.toFixed(3)}` : '',
        s.nativePolicySsim !== undefined ? `(ordo's policies ${s.nativePolicySsim.toFixed(3)})` : '',
        s.beforeHubSsim !== undefined ? `before hub ${s.beforeHubSsim.toFixed(3)}` : '',
        s.noLoSsim !== undefined ? `without LibreOffice ${s.noLoSsim.toFixed(3)}` : '',
        s.nativeMs !== undefined ? `${s.nativeMs} ms` : '',
        s.nativeSlides !== undefined && s.nativeSsim === undefined ? `native: ${s.nativeSlides} slides` : '',
      ].filter(Boolean);
      console.log(`${name.padEnd(40)} ${String(s.slides).padStart(3)} slides  ${cols.join('  ')}`);
    }
  } finally {
    if (nativeRenderer) await (await nativeRenderer.catch(() => undefined))?.close();
    await hubBefore?.close().catch(() => undefined);
  }
  const summary = summaryOf(true);
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  if (nativeOn)
    await writeFile(
      join(out, 'native-baseline.json'),
      JSON.stringify(
        {
          createdAt: summary.createdAt,
          chromium,
          ...(a.loCompat ? { loCompat: true } : {}),
          decks: scores.map((d) => ({
            name: d.name,
            ...(d.worship !== undefined ? { worship: d.worship } : {}),
            ...(d.nativeSsim !== undefined ? { nativeSsim: d.nativeSsim } : {}),
            ...(d.nativePolicySsim !== undefined ? { nativePolicySsim: d.nativePolicySsim } : {}),
            perSlide: d.perSlide.flatMap((p) =>
              p.nativeSsim !== undefined
                ? [
                    {
                      n: p.n,
                      nativeSsim: p.nativeSsim,
                      ...(p.policySsim !== undefined ? { policySsim: p.policySsim } : {}),
                    },
                  ]
                : [],
            ),
          })),
        },
        null,
        1,
      ),
    );
  await writeReport(join(out, 'report.html'), summary);
  const means = [
    summary.mean !== undefined ? `pptx-preview ${summary.mean.toFixed(3)}` : '',
    summary.nativeMean !== undefined ? `native ${summary.nativeMean.toFixed(3)}` : '',
    summary.nativePolicyMean !== undefined
      ? `native with ordo's policies ${summary.nativePolicyMean.toFixed(3)}`
      : '',
    summary.beforeHubMean !== undefined ? `before hub ${summary.beforeHubMean.toFixed(3)}` : '',
    summary.noLoMean !== undefined ? `without LibreOffice ${summary.noLoMean.toFixed(3)}` : '',
  ].filter(Boolean);
  console.log(
    `\nmean ssim ${means.join(', ') || '-'} over ${scores.length} deck(s); report: ${join(out, 'report.html')}`,
  );
  if (nativeOn) {
    const st = nativeStats(scores);
    const tiers = st.tiers.map((t) => `${t.key} ${(t.share * 100).toFixed(1)}% (${t.native.toFixed(3)})`);
    console.log(
      `native: ${st.slides} shown slides, beats black on ${(st.beatsBlack * 100).toFixed(1)}%; ${tiers.join(', ')}`,
    );
    console.log(
      `native raster p95 ${st.rasterMs['1920'].p95.toFixed(1)} ms at 1920, ${st.rasterMs['3840'].p95.toFixed(1)} ms at 3840 (cold, pictures prepared + first draw: ${st.coldMs['1920'].p95.toFixed(1)} / ${st.coldMs['3840'].p95.toFixed(1)} ms); convert p95 ${st.convertMs.p95.toFixed(2)} ms per slide`,
    );
    console.log(
      `native largest object (cold): p95 ${st.maxObjectMs['1920'].p95.toFixed(1)} / ${st.maxObjectMs['3840'].p95.toFixed(1)} ms, max ${st.maxObjectMs['1920'].max.toFixed(1)} / ${st.maxObjectMs['3840'].max.toFixed(1)} ms at 1920 / 3840`,
    );
    const causes = summary.native?.all.causes ?? [];
    if (causes.length)
      console.log(
        `F by cause (slides: before-harness / before-hub${a.noLibreOffice ? ' / without LibreOffice' : ''}): ${causes
          .map(
            (c) =>
              `${c.key} ${c.count} ${c.harness.toFixed(3)} / ${c.hub !== undefined ? c.hub.toFixed(3) : '-'}${a.noLibreOffice && c.noLo !== undefined ? ` / ${c.noLo.toFixed(3)}` : ''}`,
          )
          .join(', ')}`,
      );
    const rows = (summary.native?.all.textFeatures ?? []).filter((r) => r.beatsBlack !== undefined);
    if (rows.length)
      console.log(
        `text features (slides: native${summary.mean !== undefined ? ' / pptx-preview' : ''}; target): ${rows
          .map(
            (r) =>
              `${r.key} ${r.count} ${r.native.toFixed(3)}${r.ppv !== undefined ? ` / ${r.ppv.toFixed(3)}` : ''}${r.target !== undefined ? `; ${r.target.toFixed(2)}` : ''}`,
          )
          .join(', ')}`,
      );
  }
  if (a.baseline) {
    const base = JSON.parse(await readFile(a.baseline, 'utf8')) as { decks: BaselineDeck[] };
    const worship = new Set(scores.filter((d) => d.worship).map((d) => d.name));
    const gated = (name: string) => (manifest ? worship.has(name) : true);
    const cmp = compareBaseline(scores, base.decks, a.maxDrop, gated, (name) => slidesFor(a.slides, name));
    for (const line of cmp.lines) console.log(line);
    if (cmp.failed.length)
      console.error(
        `\nnative SSIM dropped by more than ${a.maxDrop} on ${cmp.failed.length} deck(s): ${cmp.failed.join(', ')}`,
      );
    if (cmp.failed.length && nativeOn) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
