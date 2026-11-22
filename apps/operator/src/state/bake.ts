import { create } from 'zustand';

/**
 * The status of the pictures of heavy slides, as this computer knows it (design/29 section 1.4, "As built in
 * sub-wave 3 (bake-worker)"; design/15 "Pictures of heavy slides: the bake service").
 *
 * THIS FILE IS A CONTRACT. The bake service (services/bake.ts) writes it; the editor's status line and the Go-live
 * check read it, and so do the words of the import report. It imports zustand and TYPES only (a test reads the
 * file's import lines), so any layout, the phone's compact one included, may import it. After the contract commit
 * the type names, the selectors and the action signatures change only by an ADDITIVE field and a line to the
 * orchestrator.
 *
 * Reading: `useBake((s) => pictureOf(s, presentationId, slideId))` (never undefined), `progressOf(s, ids?)` for
 * "5 of 12", `useBake((s) => s.gate)` for the words about this device, `s.hold` for why nothing is being made now.
 * The actions (refresh, makeNow, makeAgain, focus) are in services/bakeBoot.ts, which loads the service on demand;
 * their TYPES are here so a reader can type them without importing the boot module.
 *
 * Seams for Q24.c (plates): a plate is keyed `${presentationId}/${slideId}#plate:<n>` (`bakeId`), and every entry
 * whose key holds a `#` is left out of `totals`, of the presentations' counts and of `progressOf`, so a reader of
 * slide pictures keeps reading slide pictures.
 */

/** The seven states of a slide's picture. `none`: no record, or not scanned yet. */
export const BAKE_STATES = ['none', 'queued', 'making', 'ready', 'failed', 'off', 'unsupported'] as const;
export type BakeState = (typeof BAKE_STATES)[number];

/**
 * This DEVICE: `ready` = it may make pictures and the hub's switch is on; `off` = the hub's switch is off or this
 * is the Pages demo; `unsupported` = this device cannot make pictures (a phone, an iPad, a browser that is not
 * Chrome or Edge on a desktop, a page over plain http); `unknown` = before the hub's answer.
 */
export const BAKE_GATES = ['unknown', 'ready', 'off', 'unsupported'] as const;
export type BakeGate = (typeof BAKE_GATES)[number];

/** Why nothing is being made now. */
export const BAKE_HOLDS = ['starting', 'service', 'go-live', 'resume-wait', 'hub', 'disk'] as const;
export type BakeHold = (typeof BAKE_HOLDS)[number];

/**
 * Why no picture was made: the renderer's `BakeReason` (profile, busy, animated, cut, files, font, coverage, media,
 * draw, fonts, frame, canvas, blank, time, cancelled, size, verify; the test reads the renderer's own list) and
 * the four of this service: `budget` and `disk` (the hub's 507s), `kind` (a job kind this build does not make) and
 * `unknown` (a reason text this build does not know).
 */
export const BAKE_CODES = [
  'profile',
  'busy',
  'animated',
  'cut',
  'files',
  'font',
  'coverage',
  'media',
  'draw',
  'fonts',
  'frame',
  'canvas',
  'blank',
  'time',
  'cancelled',
  'size',
  'verify',
  'budget',
  'disk',
  'kind',
  'unknown',
] as const;
export type BakeCode = (typeof BAKE_CODES)[number];

/**
 * What a failure asks of someone: `again` = Make picture again may help (a time-out, a cancel, a busy worker, a
 * font that was not loaded yet); `fix` = something named must be fixed first (a font, a character, a file, room on
 * the hub); `slide` = the slide should not have a record (it moves, or it is cut, or it is too big); `ordo` = a
 * fault of ordo, logged.
 */
export type BakeFix = 'again' | 'fix' | 'slide' | 'ordo';

/** Why a queued slide is not being made yet. */
export type BakeWaiting = 'hub-key' | 'pending' | 'hold' | 'turn';

export type SlideBake = {
  presentationId: string;
  slideId: string;
  /** Slide pictures only today; a plate (Q24.c) adds a member, never a field of this one. */
  kind: 'slide';
  state: BakeState;
  /** The slide's CURRENT local key. */
  key?: string;
  /** The sizes (widths) the hub holds for that key. */
  sizes?: number[];
  /** For `failed`: the hub's text (`<code>: <detail>`, at most 200 characters, never slide text). */
  reason?: string;
  code?: BakeCode;
  fix?: BakeFix;
  /** For `queued`: why it is not being made yet. */
  waiting?: BakeWaiting;
  /** When the state was set, ms since the epoch. */
  at?: number;
  /** For a picture this computer made: the time it took and its bytes. */
  ms?: number;
  bytes?: number;
  attempts?: number;
  madeBy?: string;
};

/** The counts of one presentation's record slides (derived from the slides by the writers, never set by hand). */
export type PresentationBake = {
  id: string;
  heavy: number;
  ready: number;
  making: number;
  queued: number;
  failed: number;
  /** When the hub's listing was read, ms since the epoch. */
  listedAt?: number;
  usedBytes?: number;
  limitBytes?: number;
};

export type BakeTotals = { heavy: number; ready: number; making: number; queued: number; failed: number };

export type BakeRunning = {
  presentationId: string;
  slideId: string;
  key: string;
  since: number;
  phase: 'files' | 'drawing' | 'encoding' | 'uploading';
};

export type BakeStore = {
  gate: BakeGate;
  hold?: BakeHold;
  /** When a timed hold ends, ms since the epoch. */
  holdUntil?: number;
  running?: BakeRunning;
  /** By `bakeId`. */
  slides: Record<string, SlideBake>;
  presentations: Record<string, PresentationBake>;
  /** Over the entries without a `#` in their key. `heavy` counts every state but `none`. */
  totals: BakeTotals;
  /** One more for every write that changed anything. */
  seq: number;
};

// ---- the actions' types (the functions are in services/bakeBoot.ts) ----

/** Which presentations to look at first or to make now. */
export type BakeScope = { playlistId?: string; presentationId?: string };
export type BakeFocus = BakeScope | undefined;
export type MakeNow = (
  scope?: BakeScope,
) => Promise<
  | { ok: true; queued: number }
  | { ok: false; why: 'service' | 'go-live' | 'unsupported' | 'off' | 'hub' | 'nothing' }
>;
export type MakeAgain = (
  presentationId: string,
  slideId: string,
) => Promise<{ ok: true } | { ok: false; why: 'service' | 'hub' | 'unknown-key' }>;
export type RefreshBake = (presentationId: string, options?: { force?: boolean }) => Promise<void>;
export type BakeActions = {
  refresh: RefreshBake;
  makeNow: MakeNow;
  makeAgain: MakeAgain;
  focus: (focus: BakeFocus) => Promise<void>;
};

// ---- ids ----

/** The key of `slides`. A later plate is `${bakeId(p, s)}#plate:<n>`. */
export function bakeId(presentationId: string, slideId: string): string {
  return `${presentationId}/${slideId}`;
}

/** An entry that stands for a slide's picture (a plate's key holds a `#`). */
function countsAsSlide(id: string): boolean {
  return !id.includes('#');
}

// ---- the store ----

function initial(): BakeStore {
  return {
    gate: 'unknown',
    slides: {},
    presentations: {},
    totals: { heavy: 0, ready: 0, making: 0, queued: 0, failed: 0 },
    seq: 0,
  };
}

/** The store. Readers use the selectors; the writers below are the service's. */
export const useBake = create<BakeStore>(() => initial());

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return false;
}

/** Equal field by field; a field that is `undefined` is the same as an absent one. */
function sameFields(a: object, b: object): boolean {
  const ea = Object.entries(a).filter(([, v]) => v !== undefined);
  const eb = Object.entries(b).filter(([, v]) => v !== undefined);
  if (ea.length !== eb.length) return false;
  const rb = b as Record<string, unknown>;
  return ea.every(([k, v]) => sameValue(v, rb[k]));
}

function tally(slides: Record<string, SlideBake>): {
  totals: BakeTotals;
  byPresentation: Map<string, BakeTotals>;
} {
  const totals: BakeTotals = { heavy: 0, ready: 0, making: 0, queued: 0, failed: 0 };
  const byPresentation = new Map<string, BakeTotals>();
  for (const [id, s] of Object.entries(slides)) {
    if (!countsAsSlide(id)) continue;
    let p = byPresentation.get(s.presentationId);
    if (!p) {
      p = { heavy: 0, ready: 0, making: 0, queued: 0, failed: 0 };
      byPresentation.set(s.presentationId, p);
    }
    for (const t of [totals, p]) {
      if (s.state !== 'none') t.heavy++;
      if (s.state === 'ready') t.ready++;
      else if (s.state === 'making') t.making++;
      else if (s.state === 'queued') t.queued++;
      else if (s.state === 'failed') t.failed++;
    }
  }
  return { totals, byPresentation };
}

/** One notification for the whole write: the slides, the presentations' counts and the totals are made together. */
function commit(
  cur: BakeStore,
  slides: Record<string, SlideBake>,
  meta: Record<string, PresentationBake>,
): void {
  const t = tally(slides);
  const totals = sameFields(cur.totals, t.totals) ? cur.totals : t.totals;
  const presentations: Record<string, PresentationBake> = {};
  const ids = new Set<string>([...t.byPresentation.keys(), ...Object.keys(meta)]);
  for (const id of ids) {
    const c = t.byPresentation.get(id) ?? { heavy: 0, ready: 0, making: 0, queued: 0, failed: 0 };
    const m = meta[id];
    const made: PresentationBake = {
      id,
      ...c,
      ...(m?.listedAt !== undefined ? { listedAt: m.listedAt } : {}),
      ...(m?.usedBytes !== undefined ? { usedBytes: m.usedBytes } : {}),
      ...(m?.limitBytes !== undefined ? { limitBytes: m.limitBytes } : {}),
    };
    const old = cur.presentations[id];
    presentations[id] = old && sameFields(old, made) ? old : made;
  }
  useBake.setState({ slides, presentations, totals, seq: cur.seq + 1 });
}

/** Set or replace the entries (`bakeId` of each) and remove the ids named; one notification, none if nothing changed. */
export function setSlides(entries: readonly SlideBake[], remove: readonly string[] = []): void {
  const cur = useBake.getState();
  let next: Record<string, SlideBake> | undefined;
  for (const id of remove) {
    if (!(id in (next ?? cur.slides))) continue;
    next ??= { ...cur.slides };
    delete next[id];
  }
  for (const e of entries) {
    const id = bakeId(e.presentationId, e.slideId);
    const old = (next ?? cur.slides)[id];
    if (old && sameFields(old, e)) continue;
    next ??= { ...cur.slides };
    next[id] = e;
  }
  if (!next) return;
  commit(cur, next, cur.presentations);
}

/** The hub-side facts of one presentation (when it was listed, its bytes and limit); the counts follow the slides. */
export function setPresentation(
  id: string,
  meta: { listedAt?: number; usedBytes?: number; limitBytes?: number },
): void {
  const cur = useBake.getState();
  const old = cur.presentations[id];
  const merged = { ...(old ?? { id, heavy: 0, ready: 0, making: 0, queued: 0, failed: 0 }), ...meta };
  if (old && sameFields(old, merged)) return;
  commit(cur, cur.slides, { ...cur.presentations, [id]: merged });
}

/** Forget a presentation that left the library: its entries, its counts and its hub-side facts. */
export function dropPresentation(id: string): void {
  const cur = useBake.getState();
  const gone = Object.entries(cur.slides)
    .filter(([, s]) => s.presentationId === id)
    .map(([k]) => k);
  if (gone.length === 0 && !(id in cur.presentations)) return;
  const slides = { ...cur.slides };
  for (const k of gone) delete slides[k];
  const meta = { ...cur.presentations };
  delete meta[id];
  commit(cur, slides, meta);
}

export function setGate(gate: BakeGate): void {
  const cur = useBake.getState();
  if (cur.gate === gate) return;
  useBake.setState({ gate, seq: cur.seq + 1 });
}

export function setHold(hold?: BakeHold, holdUntil?: number): void {
  const cur = useBake.getState();
  if (cur.hold === hold && cur.holdUntil === holdUntil) return;
  useBake.setState({ hold, holdUntil, seq: cur.seq + 1 });
}

export function setRunning(running?: BakeRunning): void {
  const cur = useBake.getState();
  if (cur.running === running || (cur.running && running && sameFields(cur.running, running))) return;
  useBake.setState({ running, seq: cur.seq + 1 });
}

/** Back to the first state (tests). */
export function resetBake(): void {
  useBake.setState(initial(), true);
}

// ---- selectors ----

/** The picture of one slide. Never undefined: a slide the store does not hold is `none`. */
export function pictureOf(s: Pick<BakeStore, 'slides'>, presentationId: string, slideId: string): SlideBake {
  return (
    s.slides[bakeId(presentationId, slideId)] ?? { presentationId, slideId, kind: 'slide', state: 'none' }
  );
}

export type BakeProgress = { total: number; done: number; making: number; queued: number; failed: number };

/**
 * "5 of 12" over the slides that have a record, of the presentations named (all when omitted): `total` counts the
 * entries whose state is not `none`, `done` the ready ones.
 */
export function progressOf(s: Pick<BakeStore, 'slides'>, ids?: readonly string[]): BakeProgress {
  const want = ids ? new Set(ids) : undefined;
  const p: BakeProgress = { total: 0, done: 0, making: 0, queued: 0, failed: 0 };
  for (const [id, e] of Object.entries(s.slides)) {
    if (!countsAsSlide(id) || e.state === 'none') continue;
    if (want && !want.has(e.presentationId)) continue;
    p.total++;
    if (e.state === 'ready') p.done++;
    else if (e.state === 'making') p.making++;
    else if (e.state === 'queued') p.queued++;
    else if (e.state === 'failed') p.failed++;
  }
  return p;
}

// ---- reasons ----

/** What the hub keeps of a failure: one line of at most this many characters (apps/hub routes: 1 to 200). */
export const REASON_MAX = 200;
/** The most a `coverage` detail may carry: never more of a slide's text than the renderer allows. */
export const COVERAGE_DETAIL_MAX = 32;

const FIX: Record<BakeCode, BakeFix> = {
  time: 'again',
  cancelled: 'again',
  busy: 'again',
  fonts: 'again',
  unknown: 'again',
  font: 'fix',
  coverage: 'fix',
  media: 'fix',
  files: 'fix',
  budget: 'fix',
  disk: 'fix',
  animated: 'slide',
  cut: 'slide',
  size: 'slide',
  draw: 'ordo',
  frame: 'ordo',
  canvas: 'ordo',
  blank: 'ordo',
  verify: 'ordo',
  profile: 'ordo',
  kind: 'ordo',
};

/** The fix class of a code. */
export function fixOf(code: BakeCode): BakeFix {
  return FIX[code];
}

const CODES: ReadonlySet<string> = new Set(BAKE_CODES);

/** One line: any run of white space is one space, the ends are trimmed, the length is cut. */
function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/**
 * Read a failure text back: `<code>` or `<code>: <detail>` (what `reasonFor` writes and the renderer's
 * `failureText` gives) is that code, its detail and its fix class; any other text is `unknown` (try again) with the
 * text, cut to one line of at most 200 characters. Never throws.
 */
export function describeFailure(reason: string): { code: BakeCode; fix: BakeFix; detail: string } {
  const text = typeof reason === 'string' ? oneLine(reason, REASON_MAX) : '';
  const m = /^([a-z]+)(?::\s*(.*))?$/.exec(text);
  const code = m?.[1];
  if (code && CODES.has(code))
    return { code: code as BakeCode, fix: FIX[code as BakeCode], detail: m?.[2] ?? '' };
  return { code: 'unknown', fix: 'again', detail: text };
}

/**
 * The text the service posts: `<code>: <detail>`, one line of at most 200 characters. `text` is the renderer's
 * `failureText` (it begins with `<code>`) or a plain detail; a `coverage` detail is cut to 32 characters.
 */
export function reasonFor(code: BakeCode, text?: string): string {
  let detail = oneLine(typeof text === 'string' ? text : '', REASON_MAX);
  if (detail === code) detail = '';
  else if (detail.startsWith(`${code}:`)) detail = detail.slice(code.length + 1).trim();
  if (code === 'coverage') detail = oneLine(detail, COVERAGE_DETAIL_MAX);
  const out = detail ? `${code}: ${detail}` : code;
  return out.length <= REASON_MAX ? out : `${out.slice(0, REASON_MAX - 1)}…`;
}
