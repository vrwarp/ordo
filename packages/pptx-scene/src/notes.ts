/**
 * Speaker notes (design/27 §4 "Church mappings": notesSlide body → `Slide.notes`; M3 item B).
 *
 * The notes of a slide are the text of the body placeholder(s) of its notes slide (`p:notes`, related to the
 * slide as `notesSlide`): paragraphs on their own lines, `a:br` a line break, fields by their stored text.
 * The slide image placeholder, header, footer, date and slide number are not notes. Bounded: at most
 * `MAX_NOTES_CHARS` characters (the importers' `IMPORT_LIMITS.notes`), read paragraph by paragraph so a huge
 * notes part costs no more than the characters kept; control characters other than tab and line break are
 * removed (the stage and the editor show the text as it is).
 *
 * Owned by M3 item B (pipeline).
 */
import { clean } from './log.ts';
import type { Package } from './opc.ts';
import { chooseAlternate } from './markup.ts';
import { child, path, textOf, type XNode } from './xml.ts';

/** Longest notes text kept per slide (`@ordo/importers` `IMPORT_LIMITS.notes`). */
export const MAX_NOTES_CHARS = 10_000;
/** Shapes looked at in a notes slide's tree, groups included. */
const MAX_NOTES_SHAPES = 500;
/** Group levels followed in a notes slide's tree. */
const MAX_NOTES_DEPTH = 8;

/** Control characters except tab (U+0009) and line feed (U+000A). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

/** The body placeholders of a notes slide, in document order (groups and alternate content followed). */
function bodies(tree: XNode): XNode[] {
  const out: XNode[] = [];
  let seen = 0;
  const stack: [XNode, number][] = [];
  for (let i = tree.children.length - 1; i >= 0; i--) stack.push([tree.children[i]!, 0]);
  while (stack.length && seen < MAX_NOTES_SHAPES) {
    const [n, depth] = stack.pop()!;
    let el: XNode | undefined = n;
    if (n.name === 'mc:AlternateContent') el = chooseAlternate(n)?.children.find((c) => c.name !== '#text');
    if (!el) continue;
    if (el.name === 'p:sp') {
      seen++;
      if (path(el, 'p:nvSpPr', 'p:nvPr', 'p:ph')?.attrs.type === 'body') out.push(el);
    } else if (el.name === 'p:grpSp' && depth < MAX_NOTES_DEPTH) {
      for (let i = el.children.length - 1; i >= 0; i--) stack.push([el.children[i]!, depth + 1]);
    }
  }
  return out;
}

/** The text of a text body, paragraphs on their own lines, cut once `budget` characters are read. */
function bodyText(txBody: XNode | undefined, budget: number): string {
  if (!txBody) return '';
  const lines: string[] = [];
  let n = 0;
  for (const p of txBody.children) {
    if (p.name !== 'a:p') continue;
    let line = '';
    for (const r of p.children) {
      if (r.name === 'a:r' || r.name === 'a:fld') line += textOf(child(r, 'a:t'));
      else if (r.name === 'a:br') line += '\n';
      if (n + line.length > budget) break;
    }
    lines.push(line);
    n += line.length + 1;
    if (n > budget) break;
  }
  return lines.join('\n');
}

/**
 * The speaker notes of `slidePart`, or undefined when it has none (no notes slide, an empty body, or a notes
 * part that cannot be read, which is logged).
 */
export function readNotes(pkg: Package, slidePart: string): string | undefined {
  const rel = pkg.relOfType(slidePart, 'notesSlide');
  if (!rel) return undefined;
  let root: XNode | undefined;
  try {
    // Read once: notes parts are not kept in the parse cache.
    root = pkg.xml(rel.target, { keep: false });
  } catch (e) {
    pkg.log(`the notes of ${clean(slidePart)} could not be read: ${clean((e as Error).message)}`);
    return undefined;
  }
  if (root?.name !== 'p:notes') return undefined;
  const tree = path(root, 'p:cSld', 'p:spTree');
  if (!tree) return undefined;
  const parts: string[] = [];
  let left = MAX_NOTES_CHARS;
  for (const sp of bodies(tree)) {
    const t = bodyText(child(sp, 'p:txBody'), left);
    if (!t.trim()) continue;
    parts.push(t);
    left -= t.length + 1;
    if (left <= 0) break;
  }
  const text = parts
    .join('\n')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(/[ \t]+$/gm, '')
    .trim()
    .slice(0, MAX_NOTES_CHARS);
  return text || undefined;
}
