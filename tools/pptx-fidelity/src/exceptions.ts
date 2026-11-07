/**
 * Named exceptions of the M9 fidelity gates (the M9 plan §6.2 gate 3): slides allowed below their before-hub
 * score, each with its reason. A deck is named by a prefix of its file's SHA-256 (`deckHash`), never by its
 * name: the exit set holds private decks, and a hash says nothing about them. A slide is its 1-based shown
 * number, as the harness numbers it.
 *
 * The plan's known groups are added by the tracks that decide them:
 * - slides that still fall to the `plain` level of the budget ladder (text-heavy, decision 14; `ladder`);
 * - holo-gradients slide 16, if its cold time is not fixed (decision 8; `decor-render`);
 * - warp presets LibreOffice draws with its own geometry (`warp-paint`, `warp-exceptions.ts`);
 * - cache-less SmartArt frames, where LibreOffice's own layout engine is the reference (`dgm-core`).
 *
 * A run (`main.ts`) hashes every deck, writes `sha256` per deck and, on each slide an entry names, `exception`
 * (the reason) and `exceptionGate: 'all'` when the entry lifts both gates (`exceptionMarks`); `exit_ssim.py`
 * leaves those slides out of gate 2 (and of gate 1 too for 'all') and counts them per group.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Which gate an exception lifts: against before-hub (gate 2, the usual one) or both gates. */
export type ExceptionGate = 'hub' | 'all';

export type NamedException = {
  /** The first 12 to 64 lower-case hex digits of the deck file's SHA-256. */
  deck: string;
  /** The slide's 1-based shown number. */
  slide: number;
  /** Why the slide may score below the gate, in a sentence (no deck names, no slide text). */
  reason: string;
  /** Default 'hub': the slide must still reach its before-harness score. */
  gate?: ExceptionGate;
};

/** The exceptions in force (none at the start of M9; each track adds its own with the reason). */
export const EXCEPTIONS: readonly NamedException[] = [];

export const MIN_HASH_DIGITS = 12;
export const MAX_REASON_CHARS = 300;

/** What is wrong with one entry (empty when it is well formed). */
export function exceptionProblems(e: unknown): string[] {
  const out: string[] = [];
  const x = (e && typeof e === 'object' ? e : {}) as Partial<Record<keyof NamedException, unknown>>;
  if (typeof x.deck !== 'string' || !new RegExp(`^[0-9a-f]{${MIN_HASH_DIGITS},64}$`).test(x.deck))
    out.push(`deck must be ${MIN_HASH_DIGITS} to 64 lower-case hex digits of the deck's SHA-256`);
  if (typeof x.slide !== 'number' || !Number.isInteger(x.slide) || x.slide < 1 || x.slide > 100_000)
    out.push('slide must be a 1-based shown slide number');
  if (typeof x.reason !== 'string' || !x.reason.trim()) out.push('reason must say why');
  else if (x.reason.length > MAX_REASON_CHARS)
    out.push(`reason is longer than ${MAX_REASON_CHARS} characters`);
  if (x.gate !== undefined && x.gate !== 'hub' && x.gate !== 'all') out.push("gate must be 'hub' or 'all'");
  return out;
}

/** The list checked whole: every entry well formed, no deck and slide named twice. Throws on the first fault. */
export function checkExceptions(list: readonly unknown[]): NamedException[] {
  const seen = new Set<string>();
  return list.map((e, i) => {
    const bad = exceptionProblems(e);
    if (bad.length) throw new Error(`exception ${i + 1}: ${bad.join('; ')}`);
    const x = e as NamedException;
    const key = `${x.deck}#${x.slide}`;
    for (const k of seen) {
      const [d, n] = k.split('#');
      if (n === String(x.slide) && (d!.startsWith(x.deck) || x.deck.startsWith(d!)))
        throw new Error(`exception ${i + 1}: deck ${x.deck} slide ${x.slide} is named twice`);
    }
    seen.add(key);
    return x;
  });
}

/** The exception for a slide of the deck whose SHA-256 is `sha256`, if one names it. */
export function exceptionFor(
  sha256: string,
  slide: number,
  list: readonly NamedException[] = EXCEPTIONS,
): NamedException | undefined {
  const h = sha256.toLowerCase();
  return list.find((e) => e.slide === slide && h.startsWith(e.deck));
}

/**
 * What a run writes on a slide an exception names (`SlideScore.exception`, `exceptionGate`): the reason, and
 * the gate only when it is 'all' (the usual 'hub' entry still holds the slide to its before-harness score).
 * Empty when no entry names the slide.
 */
export function exceptionMarks(
  sha256: string,
  slide: number,
  list: readonly NamedException[] = EXCEPTIONS,
): { exception?: string; exceptionGate?: 'all' } {
  const e = exceptionFor(sha256, slide, list);
  if (!e) return {};
  return { exception: e.reason, ...(e.gate === 'all' ? { exceptionGate: 'all' as const } : {}) };
}

/** The SHA-256 of a file, hex, read as a stream. */
export function deckHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (b) => h.update(b))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
