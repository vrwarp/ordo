/**
 * The operator's side of the native PowerPoint import (design/27 §2, §3.4, §5, §10, §11; M3 item H): the
 * import screen's choice and form fields, the import card's reading of a `pptx-native` job, and what the
 * editor's PowerPoint card says about a slide.
 *
 * Job results reach the operator as `unknown` and are read defensively: a hub of another version, an older
 * job or a failed one shows less on the card, never breaks it. Deck-derived strings (notes, font names) are
 * only ever rendered as text, and are bounded here once more.
 */
import {
  type MissingKind,
  missingKinds,
  missingLabel,
  type Presentation,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import type { HubCapabilities, Job } from '@ordo/protocol';
import { metricCompatible } from '@ordo/renderer';

// ── The import screen ───────────────────────────────────────────────────────────────────────────────────

/** 'Editable (recommended)': the native import; 'Pictures (LibreOffice)': one picture per slide. */
export type PptxImportMode = 'native' | 'libreoffice';
export type PptxImportChoice = { mode: PptxImportMode; extendBackgrounds: boolean };

/** This device's last choice (a convenience, design/15 "State"); the hub defaults to the native import. */
export const PPTX_IMPORT_KEY = 'ordo.pptxImport';
export const PPTX_EXTEND_KEY = 'ordo.pptxExtendBackgrounds';
export const DEFAULT_PPTX_CHOICE: PptxImportChoice = { mode: 'native', extendBackgrounds: true };

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** The choice this device made last; the defaults when it made none or storage is unavailable. */
export function readImportChoice(store: Store | undefined): PptxImportChoice {
  try {
    return {
      mode: store?.getItem(PPTX_IMPORT_KEY) === 'libreoffice' ? 'libreoffice' : 'native',
      extendBackgrounds: store?.getItem(PPTX_EXTEND_KEY) !== '0',
    };
  } catch {
    return DEFAULT_PPTX_CHOICE;
  }
}

/** Remember the choice on this device; without storage it lasts this visit. */
export function writeImportChoice(store: Store | undefined, c: PptxImportChoice): void {
  try {
    store?.setItem(PPTX_IMPORT_KEY, c.mode);
    store?.setItem(PPTX_EXTEND_KEY, c.extendBackgrounds ? '1' : '0');
  } catch {
    /* storage unavailable: the choice lasts this visit */
  }
}

/** A PowerPoint file the import reads: a deck, a show (.ppsx), a template (.potx), a macro deck (.pptm). */
export const isPptxName = (name: string) => /\.(pptx|ppsx|potx|pptm)$/i.test(name);

/**
 * Whether the 'Pictures (LibreOffice)' choice applies: the hub says it has LibreOffice (design/27 M9). Unknown
 * (no answer yet, or the hub could not be asked): not offered, so the import screen (`PptxImportChoices`,
 * which shows a remembered 'Pictures' choice as 'Editable' until then) and the upload (`documentFields`) follow
 * one rule, and a file dropped before the answer imports as the screen showed it. A hub from before M9
 * answers 404, read as `LEGACY_CAPABILITIES` (pictures offered).
 */
export function picturesOffered(caps: HubCapabilities | undefined): boolean {
  return caps?.pptx.pictures === true;
}

/**
 * Whether the hub's import has LibreOffice to draw what ordo cannot, as the hub decides it for a native import
 * (`nativeJob.ts`: only LibreOffice known absent or turned off means it has none). A deck parsed on the
 * client is parsed for that (`PptxClientOptions.libreoffice`), so the hub uses the parse. Unknown (no answer
 * yet): with it, as a hub from before M9 always had it.
 */
export function hubHasLibreOffice(caps: HubCapabilities | undefined): boolean {
  const state = caps?.libreoffice.state;
  return state !== 'absent' && state !== 'off';
}

/**
 * The form fields `POST /import/document` gets for one file: only a PowerPoint carries the PowerPoint choice
 * (`renderer`; `extendBackgrounds` for the native import). A PDF is always pictures. A stored 'Pictures
 * (LibreOffice)' choice on a hub without LibreOffice, or before the hub said it has it (`picturesOffered`),
 * imports as editable slides, as the screen shows it.
 */
export function documentFields(
  fileName: string,
  c: PptxImportChoice,
  caps?: HubCapabilities,
): [string, string][] {
  if (!isPptxName(fileName)) return [];
  if (c.mode === 'libreoffice' && picturesOffered(caps)) return [['renderer', 'libreoffice']];
  return [
    ['renderer', 'native'],
    ['extendBackgrounds', c.extendBackgrounds ? '1' : '0'],
  ];
}

/** The files the import screen's drop zone takes: what the hub accepts (`HubCapabilities.documents`). */
export function documentAccept(caps: HubCapabilities | undefined): string {
  const exts = caps?.documents.filter((d) => /^[a-z0-9]{1,8}$/.test(d)) ?? ['pptx', 'pdf'];
  return exts.map((d) => `.${d}`).join(',');
}

// ── The import jobs list ────────────────────────────────────────────────────────────────────────────────

/** The native import's job kind (the hub's `PPTX_JOBS.native`). */
export const PPTX_NATIVE_JOB = 'pptx-native';
/**
 * Jobs the import screen lists. The native import's follow-ups (`pptx-lo`, `pptx-reference`) and the
 * one-shot text repair are not imports: the LibreOffice follow-up shows inside its import's card.
 */
export function isImportJob(kind: string): boolean {
  return kind === PPTX_NATIVE_JOB || kind === 'document' || kind === 'pro7-import' || /^import/.test(kind);
}

/** A readable title for a job the operator did not start in this visit. */
export function importJobTitle(job: Pick<Job, 'kind' | 'createdAt'>): string {
  const what =
    job.kind === PPTX_NATIVE_JOB
      ? 'PowerPoint'
      : job.kind === 'document'
        ? 'PowerPoint or PDF (pictures)'
        : job.kind === 'pro7-import'
          ? 'ProPresenter'
          : job.kind;
  const at = new Date(job.createdAt);
  return Number.isNaN(at.getTime()) ? what : `${what} · ${at.toLocaleString()}`;
}

// ── The import card ─────────────────────────────────────────────────────────────────────────────────────

/** The `pptx-native` result as the card reads it (the hub's `PptxNativeResult`). */
export type NativeImportResult = {
  presentationId: string;
  slides: number;
  native: number;
  hybrid: number;
  picture: number;
  /** Slides made compact pictures to keep the presentation small enough for every screen (§3.4). */
  compact: number;
  /** Slides waiting for LibreOffice (`Slide.pptx.pending`). */
  pending: number;
  loJobId?: string;
  missingFonts: string[];
  notes: string[];
  /** M9: slides with something ordo cannot draw (`Slide.pptx.missing`); absent from an older hub. */
  missing?: number;
  /** M9: whether the hub had LibreOffice; undefined from an older hub (which always had it). */
  libreoffice?: boolean;
};
/** The `pptx-native` result when the deck went to the picture import instead (the CPU pool could not start). */
export type NativeImportFallback = { jobId: string; reason: string };

const MAX_NOTES = 20;
const MAX_FONTS = 20;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100_000, Math.round(v))) : 0;
const id = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : undefined);
/** At most `max` strings, each without control characters and cut to `len`. */
function texts(v: unknown, max: number, len: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== 'string') continue;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
    const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
    if (t) out.push(t.length > len ? `${t.slice(0, len - 1)}…` : t);
    if (out.length >= max) break;
  }
  return out;
}

/** The native import's numbers and notes, or undefined when the result is not one. */
export function readNativeResult(result: unknown): NativeImportResult | undefined {
  if (!isObj(result)) return undefined;
  const presentationId = id(result.presentationId);
  if (!presentationId || typeof result.slides !== 'number') return undefined;
  const loJobId = id(result.loJobId);
  return {
    presentationId,
    slides: count(result.slides),
    native: count(result.native),
    hybrid: count(result.hybrid),
    picture: count(result.picture),
    compact: count(result.compact),
    pending: count(result.pending),
    ...(loJobId ? { loJobId } : {}),
    missingFonts: texts(result.missingFonts, MAX_FONTS, 100),
    notes: texts(result.notes, MAX_NOTES, 300),
    ...(result.missing !== undefined ? { missing: count(result.missing) } : {}),
    ...(typeof result.libreoffice === 'boolean' ? { libreoffice: result.libreoffice } : {}),
  };
}

/** The picture import the deck went to instead, when the native import could not run. */
export function readNativeFallback(result: unknown): NativeImportFallback | undefined {
  if (!isObj(result) || result.fallback !== 'libreoffice') return undefined;
  const jobId = id(result.jobId);
  if (!jobId) return undefined;
  return { jobId, reason: texts([result.reason], 1, 300)[0] ?? '' };
}

export type SlideClass = 'native' | 'hybrid' | 'picture';
export type ClassCount = { cls: SlideClass; count: number; text: string; tone: 'green' | 'amber' | 'red' };

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The per-class counts the card shows (native, hybrid, picture), as text: '15 editable', '1 partly a picture'.
 * An import without LibreOffice (`libreoffice: false`) has no art: its hybrid slides are 'partly drawn'.
 */
export function classCounts(
  r: Pick<NativeImportResult, SlideClass> & { libreoffice?: boolean },
): ClassCount[] {
  return [
    { cls: 'native', count: r.native, text: `${r.native} editable`, tone: 'green' },
    {
      cls: 'hybrid',
      count: r.hybrid,
      text:
        r.libreoffice === false
          ? `${r.hybrid} partly drawn`
          : plural(r.hybrid, 'partly a picture', 'partly pictures'),
      tone: 'amber',
    },
    { cls: 'picture', count: r.picture, text: plural(r.picture, 'picture'), tone: 'red' },
  ];
}

export type ApproximatedSlide = { slideId: string; number: number; hidden: boolean; notes: string[] };

/**
 * The slides whose import approximated something (`Slide.pptx.notes`), numbered as the editor's slide list
 * numbers them (in section order, from 1); at most `max`, and `more` counts the rest.
 */
export function approximatedSlides(
  p: Pick<Presentation, 'sections'>,
  max = 50,
): { slides: ApproximatedSlide[]; more: number } {
  const slides: ApproximatedSlide[] = [];
  let more = 0;
  let n = 0;
  for (const sec of p.sections)
    for (const sl of sec.slides) {
      n++;
      const notes = texts(sl.pptx?.notes, 16, 200);
      if (!notes.length) continue;
      if (slides.length >= max) more++;
      else slides.push({ slideId: sl.id, number: n, hidden: !!sl.hidden, notes });
    }
  return { slides, more };
}

/** A job's newest log line without its time ('HH:MM:SS msg'), for a status line under a progress bar. */
export function lastLogLine(job: Pick<Job, 'log'> | undefined): string | undefined {
  const line = job?.log.at(-1);
  if (!line) return undefined;
  return texts([line.replace(/^\d\d:\d\d:\d\d /, '')], 1, 200)[0];
}

/** Slides the LibreOffice follow-up could not draw (`failed` of a `pptx-lo` result), 0 when unknown. */
export function loFailed(lo: Pick<Job, 'result'> | undefined): number {
  return isObj(lo?.result) ? count(lo.result.failed) : 0;
}

/** What the card says about the LibreOffice follow-up of an import. */
export function loStatus(
  pending: number,
  lo: Pick<Job, 'state' | 'progress' | 'log' | 'error' | 'result'> | undefined,
): { tone: 'amber' | 'green' | 'red'; text: string; detail?: string } | undefined {
  if (!pending) return undefined;
  const what = plural(pending, 'slide');
  const failed = lo?.state === 'done' ? Math.min(pending, loFailed(lo)) : 0;
  if (failed)
    return {
      tone: failed === pending ? 'red' : 'amber',
      text:
        `LibreOffice could not draw ${plural(failed, 'slide')}: ${failed === 1 ? 'it shows' : 'they show'} only ` +
        `what ordo rebuilt. Re-import the deck to try again.`,
      detail: lastLogLine(lo as Pick<Job, 'log'>),
    };
  if (!lo || lo.state === 'queued')
    return {
      tone: 'amber',
      text: `LibreOffice will draw what ordo cannot on ${what}.`,
      detail: lastLogLine(lo),
    };
  if (lo.state === 'running')
    return {
      tone: 'amber',
      text: `LibreOffice is drawing what ordo cannot on ${what} (${Math.round(lo.progress * 100)}%).`,
      detail: lastLogLine(lo),
    };
  if (lo.state === 'done') return { tone: 'green', text: `LibreOffice finished ${what}.` };
  return {
    tone: 'red',
    text: `LibreOffice could not finish ${what}: ${pending === 1 ? 'it shows only its' : 'they show only their'} editable parts.`,
    detail: lo.error ? texts([lo.error], 1, 300)[0] : undefined,
  };
}

// ── What nothing draws (design/27 M9) ───────────────────────────────────────────────────────────────────

/** The kinds a slide lists as not drawn (`Slide.pptx.missing`), read defensively. */
export function slideMissing(slide: Pick<Slide, 'pptx'>): MissingKind[] {
  return missingKinds(slide.pptx?.missing);
}

/** 'Not drawn: a chart, a vector picture', or undefined when nothing is missing. */
export function missingText(kinds: readonly MissingKind[]): string | undefined {
  if (!kinds.length) return undefined;
  return `Not drawn: ${kinds.map(missingLabel).join(', ')}.`;
}

/**
 * The slides of a presentation with something nothing draws, and the kinds over all of them (first seen
 * first): what the import card names.
 */
export function missingSummary(p: Pick<Presentation, 'sections'>): { slides: number; kinds: MissingKind[] } {
  let slides = 0;
  const kinds: MissingKind[] = [];
  for (const sec of p.sections)
    for (const sl of sec.slides) {
      const k = slideMissing(sl);
      if (!k.length) continue;
      slides++;
      for (const x of k) if (!kinds.includes(x)) kinds.push(x);
    }
  return { slides, kinds };
}

/** The import card's line about what ordo could not draw, or undefined when nothing is missing. */
export function missingLine(count: number, kinds: readonly MissingKind[] = []): string | undefined {
  if (!count) return undefined;
  const what = kinds.length ? `: ${kinds.map(missingLabel).join(', ')}` : '';
  return `${plural(count, 'slide')} ${count === 1 ? 'has' : 'have'} something ordo cannot draw${what}. It is left out; open ${count === 1 ? 'it' : 'them'} in the editor to see what.`;
}

// ── The editor's PowerPoint card ────────────────────────────────────────────────────────────────────────

/**
 * What the card says about a slide's class (design/27 §5). `missing`: the slide lists what nothing draws
 * (M9, a hub without LibreOffice): a hybrid slide then has no picture of its own.
 */
export function slideClassText(
  cls: SlideClass,
  missing = false,
): {
  label: string;
  tone: 'green' | 'amber' | 'red';
  text: string;
} {
  if (cls === 'hybrid' && missing)
    return {
      label: 'Partly drawn',
      tone: 'amber',
      text: 'ordo draws everything on this slide but what is listed below, which is left out. Everything it draws is editable.',
    };
  if (cls === 'picture' && missing)
    return {
      label: 'Not drawn',
      tone: 'red',
      text: 'ordo could not rebuild this slide, and this hub has no LibreOffice to draw it: only its text is kept, for search.',
    };
  if (cls === 'hybrid')
    return {
      label: 'Partly a picture',
      tone: 'amber',
      text: 'What ordo cannot edit (a chart, SmartArt, 3D or WordArt) is a picture drawn by LibreOffice. Everything else is editable.',
    };
  if (cls === 'picture')
    return {
      label: 'Picture',
      tone: 'red',
      text: 'ordo could not rebuild this slide: it is a picture of the PowerPoint slide. Its text is kept for search.',
    };
  return {
    label: 'Editable',
    tone: 'green',
    text: 'Every part of this slide is an ordo object you can edit.',
  };
}

/** The PowerPoint picture of a slide ('Show original'), when LibreOffice has drawn it. */
export function originalMediaId(slide: Pick<Slide, 'pptx'>): string | undefined {
  return slide.pptx?.refMediaId || undefined;
}

/**
 * Whether LibreOffice can draw this slide's original: the reference job draws the deck's shown slides only
 * (a hidden slide has no page), and only on a hub with LibreOffice (design/27 M9; unknown: assumed).
 */
export function canDrawOriginal(slide: Pick<Slide, 'pptx' | 'hidden'>, caps?: HubCapabilities): boolean {
  return (
    !!slide.pptx && slide.pptx.shown !== undefined && !slide.hidden && (caps ? caps.pptx.reference : true)
  );
}

/**
 * Whether the card offers 'Add PowerPoint's pictures (PDF)…' instead: no picture yet, no LibreOffice to draw
 * one, and the hub can read PowerPoint's PDF export (poppler-utils).
 */
export function offersReferencePdf(slide: Pick<Slide, 'pptx'>, caps: HubCapabilities | undefined): boolean {
  return !!slide.pptx && !originalMediaId(slide) && !!caps && !caps.pptx.reference && caps.pptx.referencePdf;
}

/** Whether a slide is set to show its PowerPoint picture instead of its objects (`Slide.pptx.show`). */
export function showsPicture(slide: Pick<Slide, 'pptx'>): boolean {
  return slide.pptx?.show === 'picture' && !!slide.pptx.refMediaId;
}

/** The slide set back to show its objects (`Slide.pptx.show` cleared). */
export function showObjects(slide: Slide): Slide {
  if (!slide.pptx?.show) return slide;
  const { show: _show, ...pptx } = slide.pptx;
  return { ...slide, pptx };
}

/**
 * The slide set to show its PowerPoint picture on every screen instead of its objects (`Slide.pptx.show`
 * 'picture'; objects added in ordo still draw over it, `slideContent`). The slide itself when it has no
 * picture yet or already shows it.
 */
export function showPicture(slide: Slide): Slide {
  if (!slide.pptx?.refMediaId || slide.pptx.show === 'picture') return slide;
  return { ...slide, pptx: { ...slide.pptx, show: 'picture' } };
}

// ── M4 item F: the editor's PowerPoint card and import report ──────────────────────────────────────────

/**
 * The digest the hub writes in `Slide.pptx.digest` (`@ordo/pptx-scene` `digestOf`: two FNV-1a lanes over
 * the objects' JSON, 16 hex digits). Kept identical to it (tested), so the editor can tell an edited slide.
 */
export function objectsDigest(objects: readonly SlideObject[]): string {
  const s = JSON.stringify(objects);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Whether a PowerPoint slide was edited since the hub last wrote it: its imported objects (those with an
 * `origin`) no longer match `Slide.pptx.digest`, as the re-import tests it (`reimport.ts` `unedited`).
 * Objects added in ordo do not count. A copy (no digest) counts as edited; a slide not from PowerPoint never.
 */
export function slideEdited(slide: Pick<Slide, 'objects' | 'pptx'>): boolean {
  const d = slide.pptx?.digest;
  if (!slide.pptx) return false;
  if (!d) return true;
  return objectsDigest(slide.objects) !== d && objectsDigest(slide.objects.filter((o) => o.origin)) !== d;
}

/** Families every output draws as they are. */
const GENERIC_FAMILIES: ReadonlySet<string> = new Set(['sans-serif', 'serif', 'monospace', 'system-ui']);
/** A family name as the card shows it: no control characters, at most 100 characters. */
function familyName(f: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  const t = f.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t.length > 100 ? `${t.slice(0, 99)}…` : t;
}

/**
 * The font families a slide's text asks for that the hub's fonts do not draw with their own widths: neither
 * the family nor, among the box's fallback fonts, a metric-compatible one (Carlito for Calibri) is in
 * `library`. The card offers 'Upload font' for these (design/27 §10, §11 item 12). In first-use order, each
 * once (case-insensitive), at most `max`.
 */
export function missingSlideFonts(
  slides: readonly Pick<Slide, 'objects'>[],
  library: Iterable<string>,
  max = 20,
): string[] {
  const have = new Set<string>();
  for (const f of library) have.add(f.trim().toLowerCase());
  const out: string[] = [];
  const seen = new Set<string>();
  const check = (family: string | undefined, fallbacks: readonly string[]) => {
    if (!family || out.length >= max) return;
    const name = familyName(family);
    const k = name.toLowerCase();
    if (!name || seen.has(k)) return;
    if (have.has(k) || GENERIC_FAMILIES.has(k)) {
      seen.add(k);
      return;
    }
    // A metric-compatible face the box falls back to, when the hub has it, keeps PowerPoint's line breaks.
    if (fallbacks.some((f) => have.has(f.trim().toLowerCase()) && metricCompatible(family, f))) return;
    seen.add(k);
    out.push(name);
  };
  for (const s of slides)
    for (const o of s.objects) {
      if (o.type !== 'text') continue;
      const fallbacks = o.style.fallbackFonts ?? [];
      check(o.style.fontFamily, fallbacks);
      for (const r of o.runs ?? []) check(r.fontFamily, fallbacks);
    }
  return out;
}

/** What the Presentation panel's PowerPoint report shows (design/27 §11 item 12, §15 M4). */
export type ImportReport = {
  /** The native import's counts (`source.native`), or the legacy picture import's. */
  native?: { slides: number; native: number; hybrid: number; picture: number; version: number };
  /** Legacy picture pages still in the presentation (`Slide.imported` without `pptx`). */
  pages: number;
  /** PowerPoint slides waiting for LibreOffice, and those it could not draw. */
  pending: number;
  failed: number;
  /** M9: slides with something nothing draws (`Slide.pptx.missing`). */
  missing: number;
  hidden: number;
  /** Slides edited since the import (their objects no longer match the digest). */
  edited: number;
  /** What drew a legacy import's pictures. */
  renderer?: string;
  /** `source.log` lines, at most `LOG_LINES` of the newest, each a warning or not. */
  log: { text: string; warn: boolean }[];
  /** Log lines left out (older ones). */
  logMore: number;
  /**
   * The deck is an announcement loop (PowerPoint plays it looping with every slide timed, design/27 §8): the
   * report says what a loop does on the screens and offers 'Treat as slides' (`treatAsSlides`).
   */
  loop?: boolean;
};

/** Import log lines the report shows. */
export const LOG_LINES = 200;

/** The report of a PowerPoint presentation; undefined for any other presentation. */
export function importReport(
  p: Pick<Presentation, 'source' | 'sections'> & { kind?: Presentation['kind'] },
): ImportReport | undefined {
  const src = p.source;
  if (src?.kind !== 'pptx') return undefined;
  let pages = 0;
  let pending = 0;
  let failed = 0;
  let missing = 0;
  let hidden = 0;
  let edited = 0;
  for (const sec of p.sections)
    for (const sl of sec.slides) {
      if (sl.hidden) hidden++;
      if (sl.imported && !sl.pptx) pages++;
      if (sl.pptx?.pending) pending++;
      if (sl.pptx?.failed) failed++;
      if (slideMissing(sl).length) missing++;
      if (sl.pptx && slideEdited(sl)) edited++;
    }
  const all = (src.log ?? '').split('\n').filter((l) => l.trim());
  const lines = texts(all.slice(-LOG_LINES), LOG_LINES, 400);
  const n = src.native;
  return {
    ...(n
      ? {
          native: {
            slides: count(n.slides),
            native: count(n.native),
            hybrid: count(n.hybrid),
            picture: count(n.picture),
            version: count(n.version),
          },
        }
      : {}),
    pages,
    pending,
    failed,
    missing,
    hidden,
    edited,
    ...(src.renderer ? { renderer: src.renderer } : {}),
    log: lines.map((t) =>
      t.startsWith('[warn] ') ? { text: t.slice(7), warn: true } : { text: t, warn: false },
    ),
    logMore: Math.max(0, all.length - LOG_LINES),
    ...(p.kind === 'loop' ? { loop: true } : {}),
  };
}

/**
 * An announcement loop made a slide deck ('Treat as slides' in the import report): the operator moves through
 * it, and its words show on the Stage and the Bottom-Third Stream, which a loop leaves on standby and empty.
 * The slides' own timings stay stored (a slide deck does not advance by them; 'loop' again would). Pure.
 */
export function treatAsSlides(p: Presentation): Presentation {
  if (p.kind !== 'loop') return p;
  const { loop: _loop, ...rest } = p;
  return { ...rest, kind: 'slides' };
}

/**
 * `draft` with the reference pictures (and picture settings) of `latest`, slide by slide; nothing else, and
 * its own `rev` (a save still meets the hub's revision check). Slides the draft no longer has, or that are
 * not from a PowerPoint, are left alone.
 */
export function withReferences(draft: Presentation, latest: Presentation): Presentation {
  const refs = new Map<string, NonNullable<Slide['pptx']>>();
  for (const sec of latest.sections)
    for (const sl of sec.slides) if (sl.pptx?.refMediaId) refs.set(sl.id, sl.pptx);
  if (!refs.size) return draft;
  return {
    ...draft,
    sections: draft.sections.map((sec) => ({
      ...sec,
      slides: sec.slides.map((sl) => {
        const r = refs.get(sl.id);
        return r ? withReference(sl, r) : sl;
      }),
    })),
  };
}

function withReference(sl: Slide, r: NonNullable<Slide['pptx']>): Slide {
  if (!sl.pptx || sl.pptx.fileId !== r.fileId || !r.refMediaId) return sl;
  const pptx = { ...sl.pptx, refMediaId: r.refMediaId };
  if (r.show) pptx.show = r.show;
  return { ...sl, pptx };
}

/**
 * `savedBy` of the revisions the hub's PowerPoint jobs save (version 2, reference pictures, text repair, and
 * 'Re-import from PowerPoint': its revision is taken over like a follow-up's, slide by slide, so a volunteer's
 * unsaved edit of a slide stays and every other slide shows what the re-import made).
 */
export const PPTX_JOB_SAVERS: ReadonlySet<string> = new Set([
  'pptx-lo',
  'pptx-reference',
  'pptx-text-repair',
  'pptx-reimport',
]);

/**
 * Whether every revision after `since` up to `upTo` was saved by a PowerPoint job, at least one: an editor
 * then takes them over (`rebaseOnJobs`) instead of calling them someone else's.
 */
export function onlyJobSaves(
  revisions: readonly { rev: number; savedBy?: string }[],
  since: number,
  upTo: number,
): boolean {
  if (!(upTo > since) || upTo - since > 1_000) return false;
  const newer = revisions.filter((r) => r.rev > since && r.rev <= upTo);
  const revs = new Set(newer.map((r) => r.rev));
  // Every revision in between must be listed (the hub keeps the newest 50 at least).
  for (let r = since + 1; r <= upTo; r++) if (!revs.has(r)) return false;
  return newer.length > 0 && newer.every((r) => !!r.savedBy && PPTX_JOB_SAVERS.has(r.savedBy));
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The editor's draft moved onto `latest` when only PowerPoint jobs saved since `base` (version 2 of an import,
 * reference pictures, the text repair): a three-way merge, slide by slide. A slide the draft has not changed
 * from `base` becomes `latest`'s (art, page pictures, `pending` cleared); a slide it changed keeps the
 * volunteer's edit and takes only the reference picture (the hub's follow-up gives a still-`pending` slide
 * its art when it is saved). Presentation fields follow the same rule; the draft's sections and slide order
 * stay. The result carries `latest.rev`, so the next save does not overwrite the jobs' work.
 */
export function rebaseOnJobs(base: Presentation, draft: Presentation, latest: Presentation): Presentation {
  const slidesOf = (p: Presentation) => new Map(p.sections.flatMap((s) => s.slides.map((sl) => [sl.id, sl])));
  const before = slidesOf(base);
  const after = slidesOf(latest);
  const out: Record<string, unknown> = { ...draft };
  for (const k of new Set([...Object.keys(draft), ...Object.keys(latest)])) {
    if (k === 'sections' || k === 'rev') continue;
    const d = (draft as Record<string, unknown>)[k];
    if (same(d, (base as Record<string, unknown>)[k])) {
      const l = (latest as Record<string, unknown>)[k];
      if (l === undefined) delete out[k];
      else out[k] = l;
    }
  }
  out.rev = latest.rev;
  out.sections = draft.sections.map((sec) => ({
    ...sec,
    slides: sec.slides.map((sl) => {
      const l = after.get(sl.id);
      if (!l) return sl;
      const b = before.get(sl.id);
      if (b && same(sl, b)) return l;
      return l.pptx ? withReference(sl, l.pptx) : sl;
    }),
  }));
  return out as Presentation;
}

/** The hidden slides of a presentation (`Slide.hidden`): Next skips their cues, a click shows them. */
export function hiddenCount(p: Pick<Presentation, 'sections'>): number {
  let n = 0;
  for (const sec of p.sections) for (const sl of sec.slides) if (sl.hidden) n++;
  return n;
}
