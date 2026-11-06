/**
 * The operator's side of the native PowerPoint import (design/27 §2, §3.4, §5, §10, §11; M3 item H): the
 * import screen's choice and form fields, the import card's reading of a `pptx-native` job, and what the
 * editor's PowerPoint card says about a slide.
 *
 * Job results reach the operator as `unknown` and are read defensively: a hub of another version, an older
 * job or a failed one shows less on the card, never breaks it. Deck-derived strings (notes, font names) are
 * only ever rendered as text, and are bounded here once more.
 */
import type { Presentation, Slide } from '@ordo/domain';
import type { Job } from '@ordo/protocol';

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

export const isPptxName = (name: string) => /\.pptx$/i.test(name);

/**
 * The form fields `POST /import/document` gets for one file: only a .pptx carries the PowerPoint choice
 * (`renderer`; `extendBackgrounds` for the native import). A PDF is always pictures.
 */
export function documentFields(fileName: string, c: PptxImportChoice): [string, string][] {
  if (!isPptxName(fileName)) return [];
  if (c.mode === 'libreoffice') return [['renderer', 'libreoffice']];
  return [
    ['renderer', 'native'],
    ['extendBackgrounds', c.extendBackgrounds ? '1' : '0'],
  ];
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

/** The per-class counts the card shows (native, hybrid, picture), as text: '15 editable', '1 partly a picture'. */
export function classCounts(r: Pick<NativeImportResult, SlideClass>): ClassCount[] {
  return [
    { cls: 'native', count: r.native, text: `${r.native} editable`, tone: 'green' },
    {
      cls: 'hybrid',
      count: r.hybrid,
      text: plural(r.hybrid, 'partly a picture', 'partly pictures'),
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

/** What the card says about the LibreOffice follow-up of an import. */
export function loStatus(
  pending: number,
  lo: Pick<Job, 'state' | 'progress' | 'log' | 'error'> | undefined,
): { tone: 'amber' | 'green' | 'red'; text: string; detail?: string } | undefined {
  if (!pending) return undefined;
  const what = plural(pending, 'slide');
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

// ── The editor's PowerPoint card ────────────────────────────────────────────────────────────────────────

/** What the card says about a slide's class (design/27 §5). */
export function slideClassText(cls: SlideClass): {
  label: string;
  tone: 'green' | 'amber' | 'red';
  text: string;
} {
  if (cls === 'hybrid')
    return {
      label: 'Partly a picture',
      tone: 'amber',
      text: 'What ordo cannot edit (a chart, SmartArt, 3D or WordArt) is a locked picture drawn by LibreOffice. Everything else is editable.',
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
 * (a hidden slide has no page).
 */
export function canDrawOriginal(slide: Pick<Slide, 'pptx' | 'hidden'>): boolean {
  return !!slide.pptx && slide.pptx.shown !== undefined && !slide.hidden;
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
 * `draft` with the reference pictures (and picture settings) of `latest`, slide by slide: the
 * `pptx-reference` job changes nothing else, so an editor with unsaved edits takes them over instead of
 * meeting a conflict on its next save. Slides the draft no longer has, or that are not from a PowerPoint,
 * are left alone.
 */
export function withReferences(draft: Presentation, latest: Presentation): Presentation {
  const refs = new Map<string, NonNullable<Slide['pptx']>>();
  for (const sec of latest.sections)
    for (const sl of sec.slides) if (sl.pptx?.refMediaId) refs.set(sl.id, sl.pptx);
  if (!refs.size) return { ...draft, rev: latest.rev };
  return {
    ...draft,
    rev: latest.rev,
    sections: draft.sections.map((sec) => ({
      ...sec,
      slides: sec.slides.map((sl) => {
        const r = refs.get(sl.id);
        if (!r || !sl.pptx || sl.pptx.fileId !== r.fileId) return sl;
        const pptx = { ...sl.pptx, refMediaId: r.refMediaId };
        if (r.show) pptx.show = r.show;
        return { ...sl, pptx };
      }),
    })),
  };
}
