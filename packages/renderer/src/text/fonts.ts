import { DEFAULT_FONT, SCRIPT_FALLBACK_FONTS } from '@ordo/domain';

import type { FaceRequest, FontEnv } from './types.ts';

/*
 * The font resolver (design/27 §10). Owner: fonts (E).
 *
 * Each drawer (the outputs' asset worker, the operator's thumbnail worker and the editor page) installs one
 * `FontResolver` as its `FontEnv`:
 * - Every face is registered as FontFace('o' + hash8(scope + family + sorted face keys), data,
 *   {weight, style, unicodeRange}), and no internal name is ever registered twice. A worker that measured a
 *   family string before the face was added keeps the fallback width for that string (the verified probe),
 *   while a family name never resolved before takes the new face; so a changed face set (a late, retried or
 *   added face) registers the whole family again under a fresh name and it takes effect without a restart.
 * - A family enters font strings only once all its faces of that round have loaded and been added; then
 *   `generation` changes, which invalidates memoised layouts (rich.ts), and the width cache never sees the
 *   new string before (its key is the font string).
 * - Font strings are built only from loaded internal names, in this order: the exact library face, the
 *   style's `fallbackFonts`, the script fallback for `FaceRequest.script` (SCRIPT_FALLBACK_FONTS), then the
 *   original family name (last resort: the asset worker reports it), ordo's default face (Inter, once
 *   shipped) and today's generic chain.
 * - A face whose file cannot be read or parsed is retried with backoff (2 s doubling to 5 min) and at once on
 *   the next `sync`; the rest of its family loads without it meanwhile.
 * - The legacy `fontString` (text2d.ts) uses the installed resolver too, so legacy and rich objects resolve
 *   families identically in every drawer; with no resolver installed (`LEGACY_FONT_ENV`) it is byte for byte
 *   today's string.
 *
 * Bundled substitutes and script fallbacks (M3) are ordinary faces to the resolver: once the hub lists them
 * in the output-config fonts they load like any other and their families appear in the stacks above. They
 * should carry their script's `unicodeRange`, so a script fallback never draws Latin text ahead of the
 * original family name.
 */

/** Today's generic chain after the requested family (`fontString` in text2d.ts). */
const LEGACY_TAIL = ['"Inter"', '"Segoe UI"', 'Arial', 'sans-serif'] as const;
/** Today's fallback chain after the requested family, as one CSS family list. */
export const LEGACY_FALLBACK = LEGACY_TAIL.join(', ');

/** A CSS family name, quoted. Callers pass clamped names (no quotes, backslashes or newlines). */
export function quoteFamily(family: string): string {
  return `"${family}"`;
}

/** The CSS font shorthand for `req` with this family list. */
export function cssFont(req: FaceRequest, families: string): string {
  const style = req.italic ? 'italic ' : '';
  const variant = req.smallCaps ? 'small-caps ' : '';
  return `${style}${variant}${req.weight} ${req.sizePx}px ${families}`;
}

/** Family names straight from the request, then today's chain: what drawers did before the resolver. */
export const LEGACY_FONT_ENV: FontEnv = {
  generation: 0,
  font(req) {
    const families = [req.family, ...req.fallbacks].filter((f) => f).map(quoteFamily);
    return cssFont(req, families.length ? `${families.join(', ')}, ${LEGACY_FALLBACK}` : LEGACY_FALLBACK);
  },
};

let installed: FontEnv = LEGACY_FONT_ENV;

/** Install the drawer's font environment (once per worker or page; the editor and both workers do). */
export function installFontEnv(env: FontEnv): void {
  installed = env;
}

/** The installed font environment (`LEGACY_FONT_ENV` until a drawer installs one). */
export function currentFontEnv(): FontEnv {
  return installed;
}

/** FNV-1a (32 bit) of the UTF-16 units of `s`, as 8 lower-case hex digits. */
export function hash8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** One font file to register: a library `Font` (upload, google, bundled) as the drawers receive it. */
export type FontFile = {
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** SHA-256 of the file: what the drawer reads it by. */
  hash: string;
  /** CSS unicode-range of a subset face (Google Fonts subsets, M3). */
  unicodeRange?: string;
  /** A deck-embedded face: only that presentation's objects use it (M8). '' or absent: the library. */
  scope?: string;
};

/** What a face needs to be once created: a FontFace, or a test double. */
export type FaceLike = { load(): Promise<unknown> };

/** Where faces come from and go to; each drawer passes its own. */
export type FontHost = {
  /** The face set font strings resolve against: `self.fonts` in a worker, `document.fonts` on a page. */
  set: { add(face: FaceLike): unknown; delete(face: FaceLike): unknown } | undefined;
  /** The face's file: its bytes, or a URL the browser fetches (`url(...)`). Throws when unavailable. */
  data(file: FontFile): Promise<ArrayBuffer | string>;
  /** Create a face (default: `new FontFace(name, data, descriptors)`). */
  face?(name: string, data: ArrayBuffer | string, descriptors: FontFaceDescriptors): FaceLike;
  /** Run `fn` after `ms`; returns a cancel function (default: setTimeout). */
  timer?(fn: () => void, ms: number): () => void;
  /** Milliseconds, monotonic enough for backoff (default: Date.now). */
  now?(): number;
  /** Retry backoff of a face that failed: first delay, doubling up to max. */
  retry?: { firstMs: number; maxMs: number };
};

/** A change of the resolved faces: these families (lower-case) draw differently from now on. */
export type FontChange = {
  families: string[];
  /** True when a retry loaded them, outside any `sync`: content drawn before used a fallback for them. */
  late: boolean;
};

export type FontSyncResult = {
  /** Faces of the listed families that are loaded. */
  loaded: number;
  /** One line per listed face that is not loaded: family, weight (i = italic) and the reason. */
  failed: string[];
  /** Families (lower-case) whose faces changed during this sync: content drawn before used others. */
  ready: string[];
};

/** The identity of a face within its family: its file and its descriptors. */
export function faceKey(f: FontFile): string {
  return `${f.hash}|${f.weight}|${f.style}|${f.unicodeRange ?? ''}`;
}

/** 'o' + hash8 of the scope, the family and its sorted face keys: the base of a family's internal name. */
export function internalFamilyName(scope: string, family: string, keys: readonly string[]): string {
  return `o${hash8(`${scope}\u0000${family.trim().toLowerCase()}\u0000${[...keys].sort().join('\u0001')}`)}`;
}

const familyKey = (scope: string, family: string) => `${scope}\u0000${family.trim().toLowerCase()}`;

const DEFAULT_RETRY = { firstMs: 2000, maxMs: 300_000 };

function defaultFace(name: string, data: ArrayBuffer | string, descriptors: FontFaceDescriptors): FaceLike {
  if (typeof FontFace === 'undefined') throw new Error('FontFace is not available here');
  return new FontFace(name, typeof data === 'string' ? `url(${JSON.stringify(data)})` : data, descriptors);
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
}

type Active = { name: string; keys: string[]; files: FontFile[]; faces: FaceLike[] };

type Family = {
  key: string;
  /** The family as first listed (lower-cased in reports). */
  family: string;
  scope: string;
  /** Faces the drawer wants, by face key: the latest `sync` that listed the family. */
  want: Map<string, FontFile>;
  /** The registered face set, or null before the first load. */
  active: Active | null;
  /** Faces that failed, by face key: when they may be tried again, and why. */
  failed: Map<string, { attempts: number; next: number; error: string }>;
  cancel: (() => void) | null;
  /** Loading rounds run one after another per family. */
  chain: Promise<void>;
};

/** How many wanted faces of `families` are loaded, and why each other one is not. */
function report(families: Iterable<Family>): { loaded: number; failed: string[] } {
  let loaded = 0;
  const failed: string[] = [];
  for (const fam of families)
    for (const [k, f] of fam.want) {
      if (fam.active?.keys.includes(k)) loaded++;
      else {
        const why = fam.failed.get(k)?.error ?? 'not loaded';
        failed.push(`${f.family} ${f.weight}${f.style === 'italic' ? 'i' : ''}: ${why}`);
      }
    }
  return { loaded, failed };
}

/**
 * The drawers' font resolver: registers faces under internal names, retries failed ones and builds font
 * strings from what has loaded. `new FontResolver()` without a host only resolves families announced with
 * `loaded()` (tests, and drawers that register faces themselves).
 */
export class FontResolver implements FontEnv {
  #generation = 0;
  readonly #host: FontHost | undefined;
  readonly #families = new Map<string, Family>();
  /** Every internal name ever handed out: none is used twice. */
  readonly #used = new Set<string>();
  readonly #listeners = new Set<(c: FontChange) => void>();
  #disposed = false;

  constructor(host?: FontHost) {
    this.#host = host;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * Register the drawer's faces: the whole list it should have (the output's config and service fonts, the
   * library). A listed family whose face set changed loads again under a fresh name; failed faces are tried
   * again now. Families absent from the list keep their faces (content still on screen may use them) but
   * are no longer retried. Resolves once this round of loads has settled; retries continue in the
   * background and are announced through `onChange`.
   */
  async sync(files: readonly FontFile[]): Promise<FontSyncResult> {
    const groups = new Map<string, FontFile[]>();
    for (const f of files) {
      if (!f || typeof f.family !== 'string' || !f.family.trim() || typeof f.hash !== 'string' || !f.hash)
        continue;
      const key = familyKey(f.scope ?? '', f.family);
      const g = groups.get(key);
      if (g) g.push(f);
      else groups.set(key, [f]);
    }
    for (const fam of this.#families.values()) {
      if (groups.has(fam.key)) continue;
      fam.cancel?.();
      fam.cancel = null;
      fam.failed.clear();
      fam.want = new Map((fam.active?.files ?? []).map((f) => [faceKey(f), f]));
    }
    const now = this.#now();
    const ready = new Set<string>();
    const rounds: Promise<void>[] = [];
    for (const [key, list] of groups) {
      let fam = this.#families.get(key);
      if (!fam) {
        fam = {
          key,
          family: list[0]!.family.trim(),
          scope: list[0]!.scope ?? '',
          want: new Map(),
          active: null,
          failed: new Map(),
          cancel: null,
          chain: Promise.resolve(),
        };
        this.#families.set(key, fam);
      }
      fam.want = new Map(list.map((f) => [faceKey(f), f]));
      for (const [k, x] of fam.failed) {
        if (fam.want.has(k)) x.next = now;
        else fam.failed.delete(k);
      }
      rounds.push(this.#enqueue(fam, ready));
    }
    await Promise.all(rounds);
    return { ...report([...groups.keys()].map((k) => this.#families.get(k)!)), ready: [...ready] };
  }

  /**
   * Announce faces registered elsewhere under `internal` (a name never resolved before): the family resolves
   * to it from now on.
   */
  loaded(f: { family: string; internal: string; scope?: string }): void {
    const key = familyKey(f.scope ?? '', f.family);
    let fam = this.#families.get(key);
    if (!fam) {
      fam = {
        key,
        family: f.family.trim(),
        scope: f.scope ?? '',
        want: new Map(),
        active: null,
        failed: new Map(),
        cancel: null,
        chain: Promise.resolve(),
      };
      this.#families.set(key, fam);
    }
    fam.active = { name: f.internal, keys: [], files: [], faces: [] };
    this.#used.add(f.internal);
    this.#changed([fam.family.toLowerCase()], false);
  }

  /** Whether `family` has loaded faces (case-insensitive): text in it draws in its own face. */
  isLoaded(family: string, scope = ''): boolean {
    return this.#name(family, scope) !== undefined;
  }

  /** The internal name `family` resolves to, or undefined while none of its faces has loaded. */
  nameOf(family: string, scope = ''): string | undefined {
    return this.#name(family, scope);
  }

  /** Every listed face: how many are loaded, and why each other one is not. */
  stats(): { loaded: number; failed: string[] } {
    return report(this.#families.values());
  }

  /** Called after every change of the resolved faces (generation bumped). Returns the unsubscribe. */
  onChange(fn: (c: FontChange) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Stop retrying (tests, a drawer going away). Faces already registered stay. */
  dispose(): void {
    this.#disposed = true;
    for (const fam of this.#families.values()) {
      fam.cancel?.();
      fam.cancel = null;
    }
  }

  font(req: FaceRequest): string {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (css: string) => {
      const k = css.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      out.push(css);
    };
    const pushLoaded = (family: string) => {
      const name = this.#name(family, '');
      if (name) push(quoteFamily(name));
    };
    const exact = req.family ? this.#name(req.family, '') : undefined;
    if (exact) push(quoteFamily(exact));
    for (const f of req.fallbacks) pushLoaded(f);
    if (req.script && Object.hasOwn(SCRIPT_FALLBACK_FONTS, req.script))
      for (const f of SCRIPT_FALLBACK_FONTS[req.script]!) pushLoaded(f);
    if (!exact && req.family.trim()) push(quoteFamily(req.family));
    pushLoaded(DEFAULT_FONT);
    for (const t of LEGACY_TAIL) push(t);
    return cssFont(req, out.join(', '));
  }

  #name(family: string, scope: string): string | undefined {
    if (typeof family !== 'string' || !family) return undefined;
    return this.#families.get(familyKey(scope, family))?.active?.name;
  }

  #now(): number {
    return this.#host?.now?.() ?? Date.now();
  }

  #changed(families: string[], late: boolean): void {
    this.#generation++;
    for (const fn of [...this.#listeners]) {
      try {
        fn({ families, late });
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  #enqueue(fam: Family, ready?: Set<string>): Promise<void> {
    fam.chain = fam.chain.then(() => this.#round(fam, ready)).catch(() => undefined);
    return fam.chain;
  }

  /** A name for `keys` of `fam` that was never handed out before (reserved at once). */
  #freshName(fam: Family, keys: readonly string[]): string {
    let name = internalFamilyName(fam.scope, fam.family, keys);
    for (let n = 1; this.#used.has(name); n++) name = `o${hash8(`${name}#${n}`)}`;
    this.#used.add(name);
    return name;
  }

  /**
   * One loading round: every wanted face that is not backing off is loaded under a fresh name; when all of
   * them load, the family switches to that name. Faces that fail back off and the round tries again without
   * them, so a family never waits for its broken face.
   */
  async #round(fam: Family, ready: Set<string> | undefined): Promise<void> {
    for (let guard = 0; guard <= fam.want.size && !this.#disposed; guard++) {
      const now = this.#now();
      const target = [...fam.want.entries()].filter(([k]) => (fam.failed.get(k)?.next ?? 0) <= now);
      if (!target.length) break;
      const keys = target.map(([k]) => k).sort();
      if (
        fam.active &&
        fam.active.keys.length === keys.length &&
        fam.active.keys.every((k, i) => k === keys[i])
      )
        break;
      const name = this.#freshName(fam, keys);
      const results = await Promise.all(target.map(([k, f]) => this.#loadFace(name, k, f)));
      if (this.#disposed) return;
      let bad = 0;
      for (const r of results) {
        if (r.face) continue;
        bad++;
        this.#fail(fam, r.key, r.error);
      }
      if (bad) continue;
      this.#activate(fam, name, results as { key: string; file: FontFile; face: FaceLike }[], ready);
      break;
    }
    this.#schedule(fam);
  }

  async #loadFace(
    name: string,
    key: string,
    file: FontFile,
  ): Promise<{ key: string; file: FontFile; face?: FaceLike; error: string }> {
    try {
      const host = this.#host;
      if (!host?.set) throw new Error('no font face set here');
      const data = await host.data(file);
      const descriptors: FontFaceDescriptors = { weight: String(file.weight), style: file.style };
      if (file.unicodeRange) descriptors.unicodeRange = file.unicodeRange;
      const face = (host.face ?? defaultFace)(name, data, descriptors);
      await face.load();
      return { key, file, face, error: '' };
    } catch (err) {
      return { key, file, error: String((err as Error)?.message ?? err).slice(0, 200) || 'failed' };
    }
  }

  #fail(fam: Family, key: string, error: string): void {
    const retry = this.#host?.retry ?? DEFAULT_RETRY;
    const prev = fam.failed.get(key);
    const attempts = (prev?.attempts ?? 0) + 1;
    const delay = Math.min(retry.maxMs, retry.firstMs * 2 ** Math.min(30, attempts - 1));
    fam.failed.set(key, { attempts, next: this.#now() + delay, error });
  }

  #activate(
    fam: Family,
    name: string,
    loaded: { key: string; file: FontFile; face: FaceLike }[],
    ready: Set<string> | undefined,
  ): void {
    const set = this.#host?.set;
    if (!set) return;
    for (const r of loaded) {
      set.add(r.face);
      fam.failed.delete(r.key);
    }
    const old = fam.active;
    fam.active = {
      name,
      keys: loaded.map((r) => r.key).sort(),
      files: loaded.map((r) => r.file),
      faces: loaded.map((r) => r.face),
    };
    // The old name is never used again: its faces only cost memory now.
    for (const f of old?.faces ?? []) {
      try {
        set.delete(f);
      } catch {
        /* already gone */
      }
    }
    const family = fam.family.toLowerCase();
    ready?.add(family);
    this.#changed([family], ready === undefined);
  }

  /** Retry the family's failed faces when the first of them is due. */
  #schedule(fam: Family): void {
    fam.cancel?.();
    fam.cancel = null;
    if (this.#disposed || !this.#host?.set) return;
    let due = Number.POSITIVE_INFINITY;
    for (const [k, x] of fam.failed) if (fam.want.has(k)) due = Math.min(due, x.next);
    if (due === Number.POSITIVE_INFINITY) return;
    const timer = this.#host?.timer ?? defaultTimer;
    fam.cancel = timer(
      () => {
        fam.cancel = null;
        void this.#enqueue(fam);
      },
      Math.max(0, due - this.#now()),
    );
  }
}
