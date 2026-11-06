/**
 * PowerPoint fidelity: draw decks with LibreOffice (the ground truth for now), with pptx-preview (with and
 * without ordo's corrections) and natively (`@ordo/pptx-scene` drawn by `@ordo/renderer`, design/27
 * §14.1), score every slide against LibreOffice, and write a report.
 *
 *   pnpm --filter @ordo/pptx-fidelity start -- [--engine ppv|native|both] [--no-ppv] [--corpus]
 *        [--out DIR] [--chromium PATH] [--raw] [--fresh-lo] [--manifest FILE] [--baseline FILE]
 *        [--max-drop 0.02] [deck.pptx | dir]...
 *
 * Folders are searched with their subfolders for .pptx/.pptm/.ppsx/.potx decks; a deck any renderer cannot
 * draw is recorded in its notes and the run goes on.
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
 *               SSIM drops by more than --max-drop (default 0.02) fails the run
 *
 * Real decks stay outside the repository: pass their paths. The score is SSIM of greyscale pictures at
 * 960x540 (1 = identical), computed by ffmpeg. A native run also writes <out>/native-baseline.json.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { pptxForRendering } from '@ordo/importers';
import { renderWithPptxPreview } from '@ordo/pptx-render';
import { pdfToPngs, pptxToPdf } from '../../../apps/hub/src/media/ffmpeg.ts';
import { run } from '../../../apps/hub/src/media/tools.ts';
import { buildCorpus } from './corpus.ts';
import { convertDeckIsolated, NativeRenderer, type RenderedDeck } from './native.ts';
import { png } from './png.ts';
import { type DeckScore, mean, nativeStats, type SlideScore, type Summary, writeReport } from './report.ts';

type Engine = 'ppv' | 'native';

type Args = {
  out: string;
  corpus: boolean;
  raw: boolean;
  freshLo: boolean;
  engines: Set<Engine>;
  chromium?: string;
  baseline?: string;
  manifest?: string;
  maxDrop: number;
  decks: string[];
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    out: 'tmp/pptx-fidelity',
    corpus: false,
    raw: false,
    freshLo: false,
    engines: new Set(['ppv']),
    maxDrop: 0.02,
    decks: [],
  };
  let noPpv = false;
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--out') a.out = argv[++i]!;
    else if (v === '--corpus') a.corpus = true;
    else if (v === '--raw') a.raw = true;
    else if (v === '--fresh-lo') a.freshLo = true;
    else if (v === '--chromium') a.chromium = argv[++i];
    else if (v === '--baseline') a.baseline = argv[++i];
    else if (v === '--manifest') a.manifest = argv[++i];
    else if (v === '--no-ppv') noPpv = true;
    else if (v === '--max-drop') {
      a.maxDrop = Number(argv[++i]);
      if (!(a.maxDrop >= 0)) throw new Error('--max-drop takes a number ≥ 0');
    } else if (v === '--engine') {
      const e = argv[++i];
      if (e === 'ppv' || e === 'native') a.engines = new Set([e]);
      else if (e === 'both') a.engines = new Set(['ppv', 'native']);
      else throw new Error('--engine takes native, ppv or both');
    } else if (v === '--') continue;
    else if (v.startsWith('--')) throw new Error(`unknown option ${v}`);
    else a.decks.push(v);
  }
  if (noPpv) a.engines.delete('ppv');
  return a;
}

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

/** PresentationML files: decks, slide shows, templates, macro-enabled decks. */
const DECK_RE = /\.(pptx|pptm|ppsx|ppsm|potx|potm)$/i;

/** Decks given as files, or found in folders (and their subfolders), each with a name unique in the run. */
async function decksIn(paths: string[]): Promise<{ file: string; name: string }[]> {
  const out: { file: string; name: string }[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const f of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (f.isDirectory()) await walk(join(dir, f.name), `${prefix}${f.name}__`);
      else if (DECK_RE.test(f.name)) out.push({ file: join(dir, f.name), name: prefix + f.name });
    }
  };
  for (const p of paths) {
    if ((await stat(p)).isDirectory()) await walk(p, '');
    else out.push({ file: p, name: basename(p) });
  }
  // A link whose deck is gone is not a deck the converter failed on: it is left out of the run and its means.
  const missing = out.filter((d) => !existsSync(d.file));
  for (const d of missing) console.log(`skipped ${d.name}: the deck file is missing`);
  return out.filter((d) => existsSync(d.file));
}

async function pngsIn(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  return (await readdir(dir))
    .filter((f) => /^slide-\d+\.png$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** LibreOffice, as the hub draws a deck: outline repair, PDF export, 144 dpi pages. */
async function drawWithLibreOffice(deck: string, outDir: string): Promise<string[]> {
  const work = join(outDir, '.work');
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(work, { recursive: true });
  const input = join(work, 'slides.pptx');
  const prepared = await pptxForRendering(new Uint8Array(await readFile(deck)));
  await writeFile(input, prepared.bytes);
  const pdf = await pptxToPdf(input, work, { timeoutMs: 300_000 });
  const pages = await pdfToPngs(pdf, work, { timeoutMs: 300_000 });
  const out: string[] = [];
  for (let i = 0; i < pages.length; i++) {
    const f = join(outDir, `slide-${String(i + 1).padStart(4, '0')}.png`);
    await rename(pages[i]!, f);
    out.push(f);
  }
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return out;
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

/** A PNG's size from its header. */
async function pngSize(file: string): Promise<{ w: number; h: number } | undefined> {
  const b = await readFile(file);
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/**
 * SSIM of two pictures in greyscale at 960x540 (ffmpeg). The reference is first cut to the other's
 * proportions: LibreOffice rounds a slide up to a whole pixel (1921x1080, 1440x811), a blank last column
 * or row.
 */
async function ssim(a: string, b: string): Promise<number> {
  const size = await pngSize(b);
  const ratio = size ? `${size.w}/${size.h}` : '';
  const crop = size ? `crop='min(iw,trunc(ih*${ratio}+0.5))':'min(ih,trunc(iw/(${ratio})+0.5))':0:0,` : '';
  const r = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-i',
      a,
      '-i',
      b,
      '-lavfi',
      `[0:v]${crop}scale=960:540:flags=area,format=gray[a];[1:v]scale=960:540:flags=area,format=gray[b];[a][b]ssim`,
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 60_000 },
  );
  const m = /All:([0-9.]+)/.exec(r.stderr);
  return m ? Number(m[1]) : 0;
}

async function scoreAll(lo: string[], other: string[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < lo.length; i++) out.push(other[i] ? await ssim(lo[i]!, other[i]!) : 0);
  return out;
}

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
): Promise<{ fields: Partial<DeckScore>; perSlide: SlideScore[] }> {
  const t0 = performance.now();
  const nd = join(dir, 'native');
  await rm(nd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await mkdir(nd, { recursive: true });
  const conv = await convertDeckIsolated(deck, nd);
  const notes = [...conv.notes];
  const shown = conv.slides.filter((s) => s.shown !== undefined).sort((a, b) => a.shown! - b.shown!);
  let drawn: RenderedDeck = { slides: [], notes: [], ms: 0 };
  if (shown.length) {
    try {
      drawn = await (await renderer()).renderDeck(conv, nd);
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
  const perSlide: SlideScore[] = [];
  const n = Math.max(lo.length, shown.length);
  const rect = conv.slideRect;
  for (let i = 0; i < n; i++) {
    const s = shown[i];
    const r = pics.get(i);
    const pic = r?.png ? join(nd, r.png) : undefined;
    const score: SlideScore = {
      n: i + 1,
      ...(lo[i] ? { libreoffice: relative(out, lo[i]!) } : {}),
      ...(pic ? { native: relative(out, pic) } : {}),
    };
    if (lo[i]) {
      score.nativeSsim = pic ? await ssim(lo[i]!, pic) : 0;
      const w = r?.width ?? Math.max(1, Math.round(rect.w));
      const h = r?.height ?? Math.max(1, Math.round(rect.h));
      score.blackSsim = await blacks.get(lo[i]!, w, h, () => blackPng(join(out, '.black'), w, h));
    }
    if (s) {
      score.tier = s.tier;
      score.class = s.class;
      score.reasons = s.reasons;
      score.convertMs = Math.round(s.convertMs * 100) / 100;
    }
    if (r?.rasterMs) score.rasterMs = r.rasterMs;
    perSlide.push(score);
  }
  await blacks.save();
  const scored = perSlide.filter((p) => p.nativeSsim !== undefined).map((p) => p.nativeSsim!);
  return {
    fields: {
      nativeSlides: shown.length,
      ...(scored.length ? { nativeSsim: mean(scored) } : {}),
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

type BaselineDeck = { name: string; ssim?: number; nativeSsim?: number };

/** Print the change per deck against a baseline; true when a native score dropped past `maxDrop`. */
function compareBaseline(
  scores: DeckScore[],
  base: BaselineDeck[],
  maxDrop: number,
  gated: (d: DeckScore) => boolean,
): boolean {
  const fmt = (b: number, c: number) =>
    `${b.toFixed(3)} -> ${c.toFixed(3)} (${c >= b ? '+' : ''}${(c - b).toFixed(3)})`;
  const failed: string[] = [];
  for (const s of scores) {
    const b = base.find((d) => d.name === s.name);
    if (!b) continue;
    const parts: string[] = [];
    if (b.ssim !== undefined && s.ssim !== undefined) parts.push(`pptx-preview ${fmt(b.ssim, s.ssim)}`);
    if (b.nativeSsim !== undefined && s.nativeSsim !== undefined) {
      parts.push(`native ${fmt(b.nativeSsim, s.nativeSsim)}`);
      if (b.nativeSsim - s.nativeSsim > maxDrop && gated(s)) failed.push(s.name);
    }
    if (parts.length) console.log(`${s.name.padEnd(40)} ${parts.join('  ')}`);
  }
  if (failed.length)
    console.error(
      `\nnative SSIM dropped by more than ${maxDrop} on ${failed.length} deck(s): ${failed.join(', ')}`,
    );
  return failed.length > 0;
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
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
  const renderer = () => {
    nativeRenderer ??= NativeRenderer.start(chromium);
    return nativeRenderer;
  };

  const scores: DeckScore[] = [];
  const summaryOf = (): Summary => {
    const ppv = scores.filter((s) => s.ssim !== undefined);
    const nat = scores.filter((s) => s.nativeSsim !== undefined);
    return {
      createdAt: new Date().toISOString(),
      chromium,
      engines: [...a.engines],
      ...(ppv.length ? { mean: mean(ppv.map((s) => s.ssim!)) } : {}),
      ...(nat.length
        ? {
            nativeMean: mean(nat.filter((s) => !s.embeddedFonts).map((s) => s.nativeSsim!)),
            nativeMeanAll: mean(nat.map((s) => s.nativeSsim!)),
          }
        : {}),
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
      const s: DeckScore = {
        name,
        slides: lo.length,
        notes: loNotes,
        perSlide: lo.map((f, i) => ({ n: i + 1, libreoffice: relative(out, f) })),
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
        const fixed = await scoreAll(lo, ppv.pages);
        const rawScores = raw ? await scoreAll(lo, raw.pages) : undefined;
        Object.assign(s, {
          ppvSlides: ppv.pages.length,
          ssim: mean(fixed),
          ...(rawScores ? { rawSsim: mean(rawScores) } : {}),
          ms: Math.round(ms),
          styled: ppv.styled,
        });
        s.notes.push(...ppv.notes);
        s.perSlide = lo.map((f, i) => ({
          n: i + 1,
          ssim: fixed[i]!,
          ...(rawScores ? { raw: rawScores[i]! } : {}),
          libreoffice: relative(out, f),
          ppv: ppv.pages[i] ? relative(out, ppv.pages[i]!) : undefined,
          ...(raw?.pages[i] ? { rawPpv: relative(out, raw.pages[i]!) } : {}),
        }));
      }
      if (nativeOn) {
        // Whatever the converter or the page does with this deck, the run goes on.
        try {
          const n = await nativeColumn(deck, dir, out, lo, renderer);
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
        s.nativeMs !== undefined ? `${s.nativeMs} ms` : '',
        s.nativeSlides !== undefined && s.nativeSsim === undefined ? `native: ${s.nativeSlides} slides` : '',
      ].filter(Boolean);
      console.log(`${name.padEnd(40)} ${String(s.slides).padStart(3)} slides  ${cols.join('  ')}`);
    }
  } finally {
    if (nativeRenderer) await (await nativeRenderer.catch(() => undefined))?.close();
  }
  const summary = summaryOf();
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
  if (nativeOn)
    await writeFile(
      join(out, 'native-baseline.json'),
      JSON.stringify(
        {
          createdAt: summary.createdAt,
          chromium,
          decks: scores.map((d) => ({
            name: d.name,
            ...(d.worship !== undefined ? { worship: d.worship } : {}),
            ...(d.nativeSsim !== undefined ? { nativeSsim: d.nativeSsim } : {}),
            perSlide: d.perSlide.flatMap((p) =>
              p.nativeSsim !== undefined ? [{ n: p.n, nativeSsim: p.nativeSsim }] : [],
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
      `native raster p95 ${st.rasterMs['1920'].p95.toFixed(1)} ms at 1920, ${st.rasterMs['3840'].p95.toFixed(1)} ms at 3840; convert p95 ${st.convertMs.p95.toFixed(2)} ms per slide`,
    );
  }
  if (a.baseline) {
    const base = JSON.parse(await readFile(a.baseline, 'utf8')) as { decks: BaselineDeck[] };
    const gated = (d: DeckScore) => (manifest ? d.worship === true : true);
    if (compareBaseline(scores, base.decks, a.maxDrop, gated) && nativeOn) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
