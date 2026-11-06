import { writeFile } from 'node:fs/promises';

export type SlideScore = {
  n: number;
  /** LibreOffice's page (undefined when LibreOffice drew fewer pages than the deck shows). */
  libreoffice?: string;
  // pptx-preview
  ssim?: number;
  raw?: number;
  ppv?: string;
  rawPpv?: string;
  // native (design/27 §14.1)
  native?: string;
  nativeSsim?: number;
  /** An all-black frame scored the same way: the floor native has to beat. */
  blackSsim?: number;
  tier?: string;
  class?: string;
  reasons?: string[];
  /** Reading and emitting the slide, in ms. */
  convertMs?: number;
  /** Median `drawSlide2D` time (draw and flush) at 1920 and 3840 px wide, in ms. */
  rasterMs?: { '1920': number; '3840': number };
};

export type DeckScore = {
  name: string;
  /** Pages LibreOffice drew. */
  slides: number;
  ppvSlides?: number;
  /** Mean pptx-preview SSIM over LibreOffice's pages. */
  ssim?: number;
  rawSsim?: number;
  ms?: number;
  styled?: number;
  /** Shown slides the native converter emitted, and their mean SSIM over LibreOffice's pages. */
  nativeSlides?: number;
  nativeSsim?: number;
  /** The whole native column for this deck (convert, fonts, draw), and the converter alone, in ms. */
  nativeMs?: number;
  convertMs?: number;
  /** Font files in the deck: left out of means (LibreOffice 24.2 ignores them, design/27 §14.1). */
  embeddedFonts?: boolean;
  /** From `--manifest`: a worship deck (worshipRelevance high), and the deck's features. */
  worship?: boolean;
  features?: string[];
  notes: string[];
  nativeNotes?: string[];
  perSlide: SlideScore[];
};

export type Summary = {
  createdAt: string;
  chromium?: string;
  engines?: string[];
  /** Mean pptx-preview SSIM over decks. */
  mean?: number;
  /** Mean native SSIM over decks without embedded fonts, and over every deck. */
  nativeMean?: number;
  nativeMeanAll?: number;
  decks: DeckScore[];
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

/** One row of a group table: how many, and the mean native (and pptx-preview) SSIM. */
export type GroupRow = {
  key: string;
  count: number;
  /** Share of the slides (or decks) in the table. */
  share: number;
  native: number;
  ppv?: number;
  /** Share of the scored slides where native beats an all-black frame. */
  beatsBlack?: number;
};

export type NativeStats = {
  slides: number;
  scored: number;
  beatsBlack: number;
  meanNative: number;
  meanPpv?: number;
  convertMs: { p50: number; p95: number };
  rasterMs: { '1920': { p50: number; p95: number }; '3840': { p50: number; p95: number } };
  tiers: GroupRow[];
  classes: GroupRow[];
  reasons: GroupRow[];
};

const TIER_ORDER = ['T1', 'T2', 'T3', 'T4', 'T5', 'fallback'];

/** A shown slide, and whether it counts in means (its deck has no embedded fonts). */
type Counted = { s: SlideScore; counted: boolean };

function shownSlides(decks: DeckScore[]): Counted[] {
  return decks.flatMap((d) =>
    d.perSlide.filter((s) => s.tier !== undefined).map((s) => ({ s, counted: !d.embeddedFonts })),
  );
}

/** Scored slides that count in means. */
const scoredOf = (xs: Counted[]) =>
  xs.filter((x) => x.counted && x.s.nativeSsim !== undefined).map((x) => x.s);

/** Counts and shares over every shown slide; SSIM means over the slides that count. */
function groupRows(slides: Counted[], keysOf: (s: SlideScore) => string[], order?: string[]): GroupRow[] {
  const groups = new Map<string, Counted[]>();
  for (const x of slides)
    for (const k of keysOf(x.s)) {
      const g = groups.get(k) ?? [];
      g.push(x);
      groups.set(k, g);
    }
  const rows = [...groups].map(([key, g]) => {
    const scored = scoredOf(g);
    const ppv = scored.filter((s) => s.ssim !== undefined);
    return {
      key,
      count: g.length,
      share: slides.length ? g.length / slides.length : 0,
      native: mean(scored.map((s) => s.nativeSsim!)),
      ...(ppv.length ? { ppv: mean(ppv.map((s) => s.ssim!)) } : {}),
      ...(scored.length ? { beatsBlack: beats(scored) } : {}),
    };
  });
  if (order) rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  else rows.sort((a, b) => a.native - b.native);
  return rows;
}

function beats(scored: SlideScore[]): number {
  const b = scored.filter((s) => s.blackSsim !== undefined);
  return b.length ? b.filter((s) => s.nativeSsim! > s.blackSsim!).length / b.length : 0;
}

/**
 * The native column's numbers over `decks`: counts, tier shares and timings over every shown slide, SSIM
 * means over the slides of decks without embedded fonts.
 */
export function nativeStats(decks: DeckScore[]): NativeStats {
  const slides = shownSlides(decks);
  const scored = scoredOf(slides);
  const ppv = scored.filter((s) => s.ssim !== undefined);
  const raster = (w: '1920' | '3840') => {
    const xs = slides.flatMap((x) => (x.s.rasterMs ? [x.s.rasterMs[w]] : []));
    return { p50: quantile(xs, 0.5), p95: quantile(xs, 0.95) };
  };
  const conv = slides.flatMap((x) => (x.s.convertMs !== undefined ? [x.s.convertMs] : []));
  return {
    slides: slides.length,
    scored: scored.length,
    beatsBlack: beats(scored),
    meanNative: mean(scored.map((s) => s.nativeSsim!)),
    ...(ppv.length ? { meanPpv: mean(ppv.map((s) => s.ssim!)) } : {}),
    convertMs: { p50: quantile(conv, 0.5), p95: quantile(conv, 0.95) },
    rasterMs: { '1920': raster('1920'), '3840': raster('3840') },
    tiers: groupRows(slides, (s) => [s.tier!], TIER_ORDER),
    classes: groupRows(slides, (s) => [s.class ?? '?'], ['native', 'hybrid', 'picture', '?']),
    reasons: groupRows(slides, (s) => (s.reasons?.length ? s.reasons : ['(none)'])),
  };
}

/** Mean native SSIM per manifest feature, over decks (decks with embedded fonts left out). */
export function featureRows(decks: DeckScore[]): GroupRow[] {
  const counted = decks.filter((d) => !d.embeddedFonts && d.nativeSsim !== undefined);
  const groups = new Map<string, DeckScore[]>();
  for (const d of counted)
    for (const f of d.features ?? []) {
      const g = groups.get(f) ?? [];
      g.push(d);
      groups.set(f, g);
    }
  return [...groups]
    .map(([key, g]) => {
      const ppv = g.filter((d) => d.ssim !== undefined);
      return {
        key,
        count: g.length,
        share: counted.length ? g.length / counted.length : 0,
        native: mean(g.map((d) => d.nativeSsim!)),
        ...(ppv.length ? { ppv: mean(ppv.map((d) => d.ssim!)) } : {}),
      };
    })
    .sort((a, b) => a.native - b.native);
}

const f3 = (v: number | undefined) => (v === undefined ? '' : v.toFixed(3));
const pct = (v: number | undefined) => (v === undefined ? '' : `${(v * 100).toFixed(1)}%`);
const ms = (v: number) => (v < 10 ? v.toFixed(2) : v.toFixed(1));

function table(title: string, unit: string, rows: GroupRow[], ppv: boolean): string {
  if (!rows.length) return '';
  const black = rows.some((r) => r.beatsBlack !== undefined);
  const head = `<tr><th>${esc(unit)}</th><th>count</th><th>share</th><th>native</th>${ppv ? '<th>pptx-preview</th>' : ''}${black ? '<th>beats black</th>' : ''}</tr>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.key)}</td><td>${r.count}</td><td>${pct(r.share)}</td><td>${f3(r.native)}</td>${ppv ? `<td>${f3(r.ppv)}</td>` : ''}${black ? `<td>${pct(r.beatsBlack)}</td>` : ''}</tr>`,
    )
    .join('');
  return `<div><h3>${esc(title)}</h3><table>${head}${body}</table></div>`;
}

function statsHtml(title: string, decks: DeckScore[]): string {
  const st = nativeStats(decks);
  if (!st.slides) return '';
  const ppv = st.meanPpv !== undefined;
  const r = st.rasterMs;
  return (
    `<h2>${esc(title)}</h2>` +
    `<p>${st.slides} shown slides, ${st.scored} scored · native ${f3(st.meanNative)}${ppv ? ` · pptx-preview ${f3(st.meanPpv)}` : ''} · beats an all-black frame on ${pct(st.beatsBlack)} · convert p50 ${ms(st.convertMs.p50)} ms, p95 ${ms(st.convertMs.p95)} ms · raster 1920 p50 ${ms(r['1920'].p50)} ms, p95 ${ms(r['1920'].p95)} ms · 3840 p50 ${ms(r['3840'].p50)} ms, p95 ${ms(r['3840'].p95)} ms</p>` +
    `<div class="tables">${table('Tiers', 'tier', st.tiers, ppv)}${table('Classes', 'class', st.classes, ppv)}${table('Reasons (classifier features), worst first', 'reason', st.reasons, ppv)}</div>`
  );
}

/**
 * A static HTML report: the native column's tables (per tier, class, reason and manifest feature, worship
 * decks first), then decks worst first, each deck's slides worst first, pictures side by side.
 */
export async function writeReport(file: string, s: Summary): Promise<void> {
  const score = (d: DeckScore) => d.nativeSsim ?? d.ssim ?? 0;
  const decks = [...s.decks].sort((a, b) => score(a) - score(b));
  const hasNative = s.decks.some((d) => d.nativeSlides !== undefined);
  const hasPpv = s.decks.some((d) => d.ppvSlides !== undefined);
  const img = (src: string | undefined, label: string) =>
    src
      ? `<figure><img loading="lazy" src="${esc(src)}" alt="${esc(label)}"><figcaption>${esc(label)}</figcaption></figure>`
      : `<figure class="missing"><div>not drawn</div><figcaption>${esc(label)}</figcaption></figure>`;
  const slideScore = (p: SlideScore) => p.nativeSsim ?? p.ssim ?? 0;
  const body = decks
    .map((d) => {
      const rows = [...d.perSlide]
        .sort((a, b) => slideScore(a) - slideScore(b))
        .map((p) => {
          const head = [
            `Slide ${p.n}`,
            p.nativeSsim !== undefined ? `native ${f3(p.nativeSsim)}` : '',
            p.blackSsim !== undefined ? `black ${f3(p.blackSsim)}` : '',
            p.ssim !== undefined ? `pptx-preview ${f3(p.ssim)}` : '',
            p.raw !== undefined ? `unmodified ${f3(p.raw)}` : '',
            p.tier
              ? `${p.tier} ${p.class ?? ''}${p.reasons?.length ? ` (${p.reasons.join(', ')})` : ''}`
              : '',
            p.convertMs !== undefined ? `convert ${ms(p.convertMs)} ms` : '',
            p.rasterMs ? `raster ${ms(p.rasterMs['1920'])} / ${ms(p.rasterMs['3840'])} ms` : '',
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            `<section class="slide"><h3>${esc(head)}</h3><div class="row">` +
            img(p.libreoffice, 'LibreOffice (ground truth)') +
            (d.ppvSlides !== undefined ? img(p.ppv, 'pptx-preview + ordo') : '') +
            (p.raw !== undefined ? img(p.rawPpv, 'pptx-preview unmodified') : '') +
            (d.nativeSlides !== undefined ? img(p.native, 'native (pptx-scene + drawSlide2D)') : '') +
            '</div></section>'
          );
        })
        .join('');
      const allNotes = [...d.notes, ...(d.nativeNotes ?? []).map((n) => `native: ${n}`)];
      const notes = allNotes.length
        ? `<ul class="notes">${allNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
        : '';
      const head = [
        `<b>${esc(d.name)}</b>`,
        `${d.slides} slides`,
        d.nativeSsim !== undefined ? `native ${f3(d.nativeSsim)}` : '',
        d.ssim !== undefined
          ? `pptx-preview ${f3(d.ssim)}${d.rawSsim !== undefined ? ` (unmodified ${f3(d.rawSsim)})` : ''}`
          : '',
        d.styled !== undefined ? `${d.styled} runs corrected` : '',
        d.ms !== undefined ? `pptx-preview ${d.ms} ms` : '',
        d.nativeMs !== undefined ? `native ${d.nativeMs} ms (convert ${d.convertMs ?? 0} ms)` : '',
        d.worship ? 'worship' : '',
        d.embeddedFonts ? 'embedded fonts (left out of means)' : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<details${d === decks[0] ? ' open' : ''}><summary>${head}</summary>${notes}${rows}</details>`;
    })
    .join('');
  let native = '';
  if (hasNative) {
    const worship = s.decks.filter((d) => d.worship);
    const left = s.decks.filter((d) => d.embeddedFonts).length;
    native =
      (worship.length ? statsHtml(`Native, worship decks (${worship.length})`, worship) : '') +
      statsHtml(`Native, all decks (${s.decks.length})`, s.decks) +
      (worship.length
        ? `<div class="tables">${table('Manifest features, worship decks, worst first', 'feature', featureRows(worship), hasPpv)}</div>`
        : '') +
      `<div class="tables">${table('Manifest features, all decks, worst first', 'feature', featureRows(s.decks), hasPpv)}</div>` +
      (left ? `<p class="notes">${left} deck(s) with embedded fonts are left out of the means.</p>` : '');
  }
  const means = [
    s.nativeMean !== undefined ? `native ${f3(s.nativeMean)}` : '',
    s.mean !== undefined ? `pptx-preview ${f3(s.mean)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PowerPoint fidelity</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d}}
body{margin:0;padding:16px;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
details{border:1px solid var(--line);border-radius:8px;margin:0 0 12px;padding:8px 12px}
summary{cursor:pointer}.notes{color:var(--muted)}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}
figure{margin:0}img{width:100%;border:1px solid var(--line)}figcaption{color:var(--muted);font-size:12px}
.missing div{aspect-ratio:16/9;display:grid;place-items:center;border:1px dashed var(--line)}
h3{font-size:14px;margin:16px 0 6px}
.tables{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
table{border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--line);padding:2px 8px;text-align:right}
th:first-child,td:first-child{text-align:left}
</style>
<h1>PowerPoint fidelity</h1>
<p>Renderers scored against LibreOffice, slide by slide: SSIM of greyscale pictures at 960×540, 1 = identical.${means ? ` Mean ${means}.` : ''} ${esc(s.createdAt)}</p>
${native}${body}</html>`;
  await writeFile(file, html);
}
