import { writeFile } from 'node:fs/promises';
import { COMPAT_RULE_TEXT, COMPAT_RULES, type CompatRule } from './compat.ts';
import { M2_FEATURE_TARGETS, TEXT_FEATURES } from './features.ts';
import type { ScriptFace } from './fonts.ts';

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
  /** Native SSIM as drawn: with `--lo-compat`, the slide drawn as LibreOffice would. */
  nativeSsim?: number;
  /** With `--lo-compat`, on a slide a policy rule changes: the slide drawn as ordo does, and its SSIM. */
  nativePolicy?: string;
  policySsim?: number;
  /** LibreOffice policy rules that change how the slide is drawn (`compat.ts`), whether applied or not. */
  compat?: string[];
  /** Text features of the slide's own XML (`features.ts`). */
  textFeatures?: string[];
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
  /** With `--lo-compat`: the mean with every slide drawn as ordo does. */
  nativePolicySsim?: number;
  /** Text features of any slide (and the presentation part), as the suite's inventory reads a deck. */
  textFeatures?: string[];
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
  /** Mean native SSIM over decks without embedded fonts, and over every deck (as drawn). */
  nativeMean?: number;
  nativeMeanAll?: number;
  /** Native slides drawn as LibreOffice would where the policies differ (`--lo-compat`). */
  loCompat?: boolean;
  /** With `--lo-compat`: `nativeMean` with every slide drawn as ordo does. */
  nativePolicyMean?: number;
  /** The native column's tables (`nativeTables`): all decks, and worship decks when a manifest says. */
  native?: { all: NativeTables; worship?: NativeTables };
  /** How this machine served each script fallback family (`fonts.ts`). */
  scriptFallbacks?: ScriptFace[];
  /** `--slides`: only these slides were scored. */
  slides?: { deck?: string; slides: number[] }[];
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
  /** With `--lo-compat`: the mean with every slide drawn as ordo does. */
  meanPolicy?: number;
  convertMs: { p50: number; p95: number };
  rasterMs: { '1920': { p50: number; p95: number }; '3840': { p50: number; p95: number } };
  tiers: GroupRow[];
  /** T1 and T2 together (the M2 exit compares them with pptx-preview). */
  t1t2?: GroupRow;
  classes: GroupRow[];
  reasons: GroupRow[];
};

/** One tier's slides with a text feature. */
export type TierCell = { count: number; native: number; ppv?: number };

/** A text feature (`features.ts`) over the shown slides that have it, per tier, and over decks. */
export type TextFeatureRow = GroupRow & {
  /** By tier, in tier order: count and means of the slides with the feature. */
  tiers: Record<string, TierCell>;
  /** With `--lo-compat`: the mean with those slides drawn as ordo does. */
  policy?: number;
  /** Decks with the feature anywhere (left out: embedded fonts), and their mean deck SSIM. */
  decks: number;
  deckNative: number;
  deckPpv?: number;
  /** pptx-preview's mean on the suite's worship decks: the M2 exit target (`M2_FEATURE_TARGETS`). */
  target?: number;
};

/** A LibreOffice policy rule (`compat.ts`) over the shown slides it changes. */
export type PolicyRow = GroupRow & {
  key: CompatRule;
  text: string;
  /** With `--lo-compat`: the same slides drawn as ordo does (`native` is then LibreOffice's way). */
  policy?: number;
};

export type NativeTables = {
  stats: NativeStats;
  textFeatures: TextFeatureRow[];
  policy: PolicyRow[];
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

/** A native picture this close to LibreOffice's page matches it, even where black matches it as well. */
export const MATCH_SSIM = 0.999;

/**
 * Whether a slide's native picture beats an all-black frame: it scores higher, or it matches the page (an
 * all-black page drawn all black ties with black at 1.000, and that is not a loss).
 */
export function beatsBlack(s: SlideScore): boolean {
  return s.nativeSsim !== undefined && (s.nativeSsim > s.blackSsim! || s.nativeSsim >= MATCH_SSIM);
}

function beats(scored: SlideScore[]): number {
  const b = scored.filter((s) => s.blackSsim !== undefined);
  return b.length ? b.filter(beatsBlack).length / b.length : 0;
}

/**
 * The native column's numbers over `decks`: counts, tier shares and timings over every shown slide, SSIM
 * means over the slides of decks without embedded fonts.
 */
export function nativeStats(decks: DeckScore[]): NativeStats {
  const slides = shownSlides(decks);
  const scored = scoredOf(slides);
  const ppv = scored.filter((s) => s.ssim !== undefined);
  const t1t2 = groupRows(slides, (s) => (s.tier === 'T1' || s.tier === 'T2' ? ['T1+T2'] : []));
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
    ...(scored.some((s) => s.policySsim !== undefined) ? { meanPolicy: mean(scored.map(policyOf)) } : {}),
    convertMs: { p50: quantile(conv, 0.5), p95: quantile(conv, 0.95) },
    rasterMs: { '1920': raster('1920'), '3840': raster('3840') },
    tiers: groupRows(slides, (s) => [s.tier!], TIER_ORDER),
    ...(t1t2[0] ? { t1t2: t1t2[0] } : {}),
    classes: groupRows(slides, (s) => [s.class ?? '?'], ['native', 'hybrid', 'picture', '?']),
    reasons: groupRows(slides, (s) => (s.reasons?.length ? s.reasons : ['(none)'])),
  };
}

/** A slide's score as ordo draws it: its policy drawing's under `--lo-compat`, else the one drawn. */
const policyOf = (s: SlideScore) => s.policySsim ?? s.nativeSsim!;

/**
 * Each text feature (`TEXT_FEATURES` order, only those present) over the shown slides that have it: counts
 * and shares over every such slide, means over those that count (no embedded fonts), per tier as well; and
 * over the decks that have it anywhere, as the suite's numbers (and the M2 targets) were taken.
 */
export function textFeatureRows(decks: DeckScore[]): TextFeatureRow[] {
  const slides = shownSlides(decks);
  const counted = decks.filter((d) => !d.embeddedFonts && d.nativeSsim !== undefined);
  return TEXT_FEATURES.flatMap((f): TextFeatureRow[] => {
    const g = slides.filter((x) => x.s.textFeatures?.includes(f));
    const dg = counted.filter((d) => d.textFeatures?.includes(f));
    if (!g.length && !dg.length) return [];
    const scored = scoredOf(g);
    const ppv = scored.filter((s) => s.ssim !== undefined);
    const tiers: Record<string, TierCell> = {};
    for (const t of TIER_ORDER) {
      const tg = g.filter((x) => x.s.tier === t);
      if (!tg.length) continue;
      const ts = scoredOf(tg);
      const tp = ts.filter((s) => s.ssim !== undefined);
      tiers[t] = {
        count: tg.length,
        native: mean(ts.map((s) => s.nativeSsim!)),
        ...(tp.length ? { ppv: mean(tp.map((s) => s.ssim!)) } : {}),
      };
    }
    const dppv = dg.filter((d) => d.ssim !== undefined);
    const target = M2_FEATURE_TARGETS[f];
    return [
      {
        key: f,
        count: g.length,
        share: slides.length ? g.length / slides.length : 0,
        native: mean(scored.map((s) => s.nativeSsim!)),
        ...(ppv.length ? { ppv: mean(ppv.map((s) => s.ssim!)) } : {}),
        ...(scored.length ? { beatsBlack: beats(scored) } : {}),
        ...(scored.some((s) => s.policySsim !== undefined) ? { policy: mean(scored.map(policyOf)) } : {}),
        tiers,
        decks: dg.length,
        deckNative: mean(dg.map((d) => d.nativeSsim!)),
        ...(dppv.length ? { deckPpv: mean(dppv.map((d) => d.ssim!)) } : {}),
        ...(target !== undefined ? { target } : {}),
      },
    ];
  });
}

/** Each LibreOffice policy rule over the shown slides it changes (whether the run applied it or not). */
export function policyRows(decks: DeckScore[]): PolicyRow[] {
  const slides = shownSlides(decks);
  return COMPAT_RULES.flatMap((rule): PolicyRow[] => {
    const g = slides.filter((x) => x.s.compat?.includes(rule));
    if (!g.length) return [];
    const scored = scoredOf(g);
    const ppv = scored.filter((s) => s.ssim !== undefined);
    return [
      {
        key: rule,
        text: COMPAT_RULE_TEXT[rule],
        count: g.length,
        share: slides.length ? g.length / slides.length : 0,
        native: mean(scored.map((s) => s.nativeSsim!)),
        ...(ppv.length ? { ppv: mean(ppv.map((s) => s.ssim!)) } : {}),
        ...(scored.length ? { beatsBlack: beats(scored) } : {}),
        ...(scored.some((s) => s.policySsim !== undefined) ? { policy: mean(scored.map(policyOf)) } : {}),
      },
    ];
  });
}

/** The native column's tables over `decks`, as `summary.json` keeps them. */
export function nativeTables(decks: DeckScore[]): NativeTables {
  return { stats: nativeStats(decks), textFeatures: textFeatureRows(decks), policy: policyRows(decks) };
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

/** Text features: slides, means, per-tier means, and the deck-level means the M2 targets are. */
function textFeatureTable(rows: TextFeatureRow[], ppv: boolean): string {
  if (!rows.length) return '';
  const tiers = TIER_ORDER.filter((t) => rows.some((r) => r.tiers[t]));
  const policy = rows.some((r) => r.policy !== undefined);
  const cell = (c: TierCell | undefined) =>
    c ? `${f3(c.native)}${ppv && c.ppv !== undefined ? ` / ${f3(c.ppv)}` : ''} (${c.count})` : '';
  const head =
    '<tr><th>feature</th><th>slides</th><th>share</th><th>native</th>' +
    (ppv ? '<th>pptx-preview</th>' : '') +
    (policy ? "<th>ordo's policies</th>" : '') +
    '<th>beats black</th>' +
    tiers.map((t) => `<th>${esc(t)}</th>`).join('') +
    `<th>decks</th><th>deck native</th>${ppv ? '<th>deck pptx-preview</th>' : ''}<th>M2 target</th></tr>`;
  const body = rows
    .map(
      (r) =>
        // A feature only some deck has (its slides left out by --slides, or not scored) has no slide means.
        `<tr><td>${esc(r.key)}</td><td>${r.count}</td><td>${pct(r.share)}</td><td>${r.beatsBlack !== undefined ? f3(r.native) : ''}</td>` +
        (ppv ? `<td>${f3(r.ppv)}</td>` : '') +
        (policy ? `<td>${f3(r.policy)}</td>` : '') +
        `<td>${pct(r.beatsBlack)}</td>` +
        tiers.map((t) => `<td>${cell(r.tiers[t])}</td>`).join('') +
        `<td>${r.decks}</td><td>${r.decks ? f3(r.deckNative) : ''}</td>${ppv ? `<td>${f3(r.deckPpv)}</td>` : ''}<td>${f3(r.target)}</td></tr>`,
    )
    .join('');
  return (
    `<div><h3>Text features (slide XML; per tier: native${ppv ? ' / pptx-preview' : ''} (slides))</h3>` +
    `<table>${head}${body}</table></div>`
  );
}

/** LibreOffice policy rules: the slides each changes, and their means drawn either way. */
function policyTable(rows: PolicyRow[], ppv: boolean, loCompat: boolean): string {
  if (!rows.length) return '';
  const policy = rows.some((r) => r.policy !== undefined);
  const head =
    `<tr><th>rule</th><th>slides</th><th>share</th><th>${loCompat ? "native (LibreOffice's way)" : 'native'}</th>` +
    (policy ? "<th>ordo's way</th><th>gain</th>" : '') +
    `${ppv ? '<th>pptx-preview</th>' : ''}<th class="text">what LibreOffice does</th></tr>`;
  const body = rows
    .map(
      (r) =>
        `<tr><td>${esc(r.key)}</td><td>${r.count}</td><td>${pct(r.share)}</td><td>${f3(r.native)}</td>` +
        (policy
          ? `<td>${f3(r.policy)}</td><td>${r.policy !== undefined ? signed(r.native - r.policy) : ''}</td>`
          : '') +
        `${ppv ? `<td>${f3(r.ppv)}</td>` : ''}<td class="text">${esc(r.text)}</td></tr>`,
    )
    .join('');
  const note = loCompat
    ? 'Drawn as LibreOffice would (--lo-compat); "ordo\'s way" is the same slides as ordo draws them.'
    : 'Drawn as ordo does; --lo-compat draws these slides as LibreOffice would and reports both.';
  return `<div><h3>LibreOffice policy rules (${esc(note)})</h3><table>${head}${body}</table></div>`;
}

const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;

function statsHtml(title: string, decks: DeckScore[], loCompat: boolean): string {
  const st = nativeStats(decks);
  if (!st.slides) return '';
  const ppv = st.meanPpv !== undefined;
  const r = st.rasterMs;
  const t = st.t1t2;
  return (
    `<h2>${esc(title)}</h2>` +
    `<p>${st.slides} shown slides, ${st.scored} scored · native ${f3(st.meanNative)}${st.meanPolicy !== undefined ? ` (ordo's policies ${f3(st.meanPolicy)})` : ''}${ppv ? ` · pptx-preview ${f3(st.meanPpv)}` : ''} · beats an all-black frame on ${pct(st.beatsBlack)}${t ? ` · T1+T2 ${t.count} slides: native ${f3(t.native)}${t.ppv !== undefined ? `, pptx-preview ${f3(t.ppv)}` : ''}` : ''} · convert p50 ${ms(st.convertMs.p50)} ms, p95 ${ms(st.convertMs.p95)} ms · raster 1920 p50 ${ms(r['1920'].p50)} ms, p95 ${ms(r['1920'].p95)} ms · 3840 p50 ${ms(r['3840'].p50)} ms, p95 ${ms(r['3840'].p95)} ms</p>` +
    `<div class="tables">${table('Tiers', 'tier', st.tiers, ppv)}${table('Classes', 'class', st.classes, ppv)}${table('Reasons (classifier features), worst first', 'reason', st.reasons, ppv)}</div>` +
    `<div class="tables">${textFeatureTable(textFeatureRows(decks), ppv)}</div>` +
    `<div class="tables">${policyTable(policyRows(decks), ppv, loCompat)}</div>`
  );
}

/** The script fallback faces the run used, and which were stand-ins. */
function fontsHtml(faces: ScriptFace[] | undefined): string {
  if (!faces?.length) return '';
  const items = faces.map(
    (f) =>
      `${esc(f.family)} (${esc(f.scripts.join(', '))}): ${
        f.served === 'missing'
          ? "not installed, the browser's fallback draws it"
          : `${esc(f.host ?? '')}${f.served === 'stand-in' ? ' standing in' : ''}`
      }`,
  );
  return `<p class="notes">Script fallbacks of the text on this machine: ${items.join('; ')}.</p>`;
}

/** What the run was asked for besides the decks: `--lo-compat`, `--slides`. */
function runHtml(s: Summary): string {
  const parts: string[] = [];
  if (s.loCompat)
    parts.push(
      `Native slides drawn as LibreOffice would where the policies differ (--lo-compat): ${COMPAT_RULES.map((r) => `${r}: ${COMPAT_RULE_TEXT[r]}`).join('; ')}. The means with ordo's own policies are given next to them.`,
    );
  if (s.slides?.length)
    parts.push(
      `Only some slides were scored (--slides): ${s.slides.map((x) => `${x.deck ? `${x.deck}: ` : ''}${x.slides.join(', ')}`).join('; ')}.`,
    );
  return parts.map((p) => `<p class="notes">${esc(p)}</p>`).join('');
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
            p.policySsim !== undefined ? `ordo's policies ${f3(p.policySsim)}` : '',
            p.blackSsim !== undefined ? `black ${f3(p.blackSsim)}` : '',
            p.ssim !== undefined ? `pptx-preview ${f3(p.ssim)}` : '',
            p.raw !== undefined ? `unmodified ${f3(p.raw)}` : '',
            p.tier
              ? `${p.tier} ${p.class ?? ''}${p.reasons?.length ? ` (${p.reasons.join(', ')})` : ''}`
              : '',
            p.textFeatures?.length ? `text: ${p.textFeatures.join(', ')}` : '',
            p.compat?.length ? `LibreOffice policies: ${p.compat.join(', ')}` : '',
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
            (d.nativeSlides !== undefined
              ? img(
                  p.native,
                  p.nativePolicy
                    ? 'native, drawn as LibreOffice would (--lo-compat)'
                    : 'native (pptx-scene + drawSlide2D)',
                )
              : '') +
            (p.nativePolicy ? img(p.nativePolicy, 'native, drawn as ordo does') : '') +
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
        d.nativePolicySsim !== undefined ? `ordo's policies ${f3(d.nativePolicySsim)}` : '',
        d.textFeatures?.length ? `text: ${d.textFeatures.join(', ')}` : '',
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
      (worship.length
        ? statsHtml(`Native, worship decks (${worship.length})`, worship, s.loCompat === true)
        : '') +
      statsHtml(`Native, all decks (${s.decks.length})`, s.decks, s.loCompat === true) +
      (worship.length
        ? `<div class="tables">${table('Manifest features, worship decks, worst first', 'feature', featureRows(worship), hasPpv)}</div>`
        : '') +
      `<div class="tables">${table('Manifest features, all decks, worst first', 'feature', featureRows(s.decks), hasPpv)}</div>` +
      (left ? `<p class="notes">${left} deck(s) with embedded fonts are left out of the means.</p>` : '') +
      fontsHtml(s.scriptFallbacks);
  }
  const means = [
    s.nativeMean !== undefined ? `native ${f3(s.nativeMean)}` : '',
    s.nativePolicyMean !== undefined ? `native with ordo's policies ${f3(s.nativePolicyMean)}` : '',
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
th:first-child,td:first-child,.text{text-align:left}
</style>
<h1>PowerPoint fidelity</h1>
<p>Renderers scored against LibreOffice, slide by slide: SSIM of greyscale pictures at 960×540, 1 = identical.${means ? ` Mean ${means}.` : ''} ${esc(s.createdAt)}</p>${runHtml(s)}
${native}${body}</html>`;
  await writeFile(file, html);
}
