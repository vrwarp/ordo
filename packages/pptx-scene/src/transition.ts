/**
 * Slide transitions and timings (design/27 §4 "Church mappings", §9 "Slide transitions"; M3 item B). Clip
 * timing and builds (`p:timing`) are `timing.ts` (M5), not this module.
 *
 * - `p:transition` (read through `mc:AlternateContent`, whose PowerPoint 2010 branch carries `p14:dur`):
 *   `p:fade` and `p:dissolve` → a crossfade; `p:cut` → a cut; a transition element with no effect (PowerPoint
 *   shows the slide without one) → a cut; any other effect (push, wipe, the `p14:` and `p15:` effects) → a
 *   crossfade, noted. The duration is `p14:dur` (ms), else `spd` (fast 500, med 750, slow 1,000 ms), else
 *   700 ms, at most 10 s (the schema's bound). A slide without `p:transition` has none: the presentation's or
 *   the service's applies (`item ?? slide ?? presentation`).
 * - `advTm` → the slide's duration (ms, at most a day).
 * - `p:showPr loop` in the presentation properties: the show loops until Esc. With every shown slide timed,
 *   the import makes the presentation a loop.
 *
 * `readSlideTransition` reads a slide part's tail only (what follows `p:cSld`: the colour map override, the
 * transition, the timing tree, extensions) under the part's own root start tag, so a slide the converter has
 * already read is not parsed a second time whole; the tail goes through the same normalisation as
 * `Package.xml` (prefixes, alternate content).
 *
 * Owned by M3 item B (pipeline).
 */
import { chooseAlternate, normalizePart, STRICT_ROOT } from './markup.ts';
import { decodeText, type Package } from './opc.ts';
import { child, num, parseXml, rootOf, rootTag, type XNode } from './xml.ts';

/** A slide transition, the shape of `@ordo/domain` `Transition`. */
export type SlideTransition = { kind: 'cut' } | { kind: 'crossfade'; ms: number };

export interface TransitionInfo {
  /** Undefined when the slide has no `p:transition`. */
  transition?: SlideTransition;
  /** `advTm`: the slide advances by itself after this many ms. */
  advanceMs?: number;
  /** What was approximated (a short note), e.g. 'a push transition is shown as a crossfade'. */
  note?: string;
}

/** A crossfade's duration when the deck gives none (design/27 §4). */
export const DEFAULT_TRANSITION_MS = 700;
/** The longest transition ordo stores (`Transition` in `@ordo/domain`). */
export const MAX_TRANSITION_MS = 10_000;
/** The longest slide duration read (`MAX.ms` of `@ordo/domain`). */
export const MAX_ADVANCE_MS = 86_400_000;

/** `spd` in ms, as PowerPoint plays it. */
const SPEED_MS: ReadonlyMap<string, number> = new Map([
  ['fast', 500],
  ['med', 750],
  ['slow', 1_000],
]);

/** Children of `p:transition` that are not its effect. */
const NOT_EFFECT: ReadonlySet<string> = new Set(['p:sndAc', 'p:extLst', '#text']);

/** The slide's `p:transition`, directly or inside the branch of an `mc:AlternateContent` that is read. */
function transitionOf(slide: XNode): XNode | undefined {
  for (const c of slide.children) {
    if (c.name === 'p:transition') return c;
    if (c.name === 'mc:AlternateContent') {
      const t = child(chooseAlternate(c), 'p:transition');
      if (t) return t;
    }
  }
  return undefined;
}

/** A local name for a note: letters and digits only, at most 30 characters. */
function effectName(name: string): string {
  const local = name.slice(name.indexOf(':') + 1);
  let out = '';
  for (const ch of local.slice(0, 100)) {
    if (out.length >= 30) break;
    if (/[A-Za-z0-9]/.test(ch)) out += ch;
  }
  return out || 'unknown';
}

const flag = (v: string | undefined) => v === '1' || v === 'true';

/** The transition and timing of a slide (`p:sld` root, read through `Package.xml`). */
export function readTransition(slide: XNode): TransitionInfo {
  const t = transitionOf(slide);
  if (!t) return {};
  const out: TransitionInfo = {};
  const adv = num(t.attrs.advTm);
  if (adv !== undefined && adv >= 0) out.advanceMs = Math.min(MAX_ADVANCE_MS, Math.round(adv));
  const dur = num(t.attrs['p14:dur']);
  const ms = Math.round(
    Math.min(
      MAX_TRANSITION_MS,
      Math.max(
        0,
        dur !== undefined && dur >= 0
          ? dur
          : (SPEED_MS.get(t.attrs.spd?.trim() ?? '') ?? DEFAULT_TRANSITION_MS),
      ),
    ),
  );
  const effect = t.children.find((c) => !NOT_EFFECT.has(c.name));
  if (!effect || effect.name === 'p:cut') {
    out.transition = { kind: 'cut' };
    if (effect && flag(effect.attrs.thruBlk)) out.note = 'a cut through black is shown as a cut';
    return out;
  }
  out.transition = { kind: 'crossfade', ms };
  if (effect.name === 'p:fade') {
    if (flag(effect.attrs.thruBlk)) out.note = 'a fade through black is shown as a crossfade';
  } else if (effect.name !== 'p:dissolve') {
    out.note = `a ${effectName(effect.name)} transition is shown as a crossfade`;
  }
  return out;
}

/** Bytes of a slide part searched for its root start tag (as `deck.ts` reads the show flag). */
const HEAD_CHARS = 64 * 1024;

/** An attribute value written back into a start tag. */
function attr(v: string): string {
  return v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}

/**
 * The transition and timing of the slide part `part`, from its tail only (see the module comment). Empty
 * when the part is missing, has no `p:cSld` end tag, or its tail cannot be read.
 */
export function readSlideTransition(pkg: Package, part: string): TransitionInfo {
  const real = pkg.find(part);
  const b = real === undefined ? undefined : pkg.bytes(real);
  if (!b?.length) return {};
  try {
    const text = decodeText(b);
    const head = rootTag(text.slice(0, HEAD_CHARS));
    if (!head) return {};
    const colon = head.name.indexOf(':');
    const close = `</${colon >= 0 ? head.name.slice(0, colon + 1) : ''}cSld>`;
    const at = text.lastIndexOf(close);
    if (at < 0) return {};
    let start = `<${head.name}`;
    for (const [k, v] of Object.entries(head.attrs)) start += ` ${k}="${attr(v)}"`;
    const mini = `${start}>${text.slice(at + close.length)}`;
    const root = rootOf(parseXml(mini, 'slide tail'));
    if (!root) return {};
    normalizePart(root, { strict: mini.includes(STRICT_ROOT), percents: false });
    return root.name === 'p:sld' ? readTransition(root) : {};
  } catch {
    return {}; // a tail that cannot be read has no transition (the slide itself is read by the converter)
  }
}

/**
 * Whether the show loops until Esc (`p:showPr loop` in the presentation properties part). False when the
 * part is missing or cannot be read.
 */
export function showLoops(pkg: Package): boolean {
  const pres = pkg.relOfType('', 'officeDocument')?.target ?? pkg.find('ppt/presentation.xml');
  if (pres === undefined) return false;
  const props = pkg.relOfType(pres, 'presProps')?.target;
  if (props === undefined) return false;
  try {
    const root = pkg.xml(props, { keep: false });
    if (root?.name !== 'p:presentationPr') return false;
    return flag(child(root, 'p:showPr')?.attrs.loop?.trim());
  } catch {
    return false;
  }
}
