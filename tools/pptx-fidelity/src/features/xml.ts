/** Linear reads of a part's XML that the feature families share. Deck strings are only tested, never kept. */

/** The longest start tag read for its attributes; a longer one is not taken as a tag. */
const MAX_TAG_CHARS = 4_096;

/**
 * The attributes of each `<name ...>` start tag in `xml` (name followed by whitespace, '/' or '>'), up to
 * its own '>', and whether it closes itself. Linear: each tag is read once, at most `MAX_TAG_CHARS` long.
 */
export function* startTags(
  xml: string,
  name: string,
): Generator<{ attrs: string; at: number; end: number; empty: boolean }> {
  const open = `<${name}`;
  let at = 0;
  // The next '>' found so far: starts before it share it, so each part of `xml` is searched once.
  let gt = -1;
  for (;;) {
    const start = xml.indexOf(open, at);
    if (start < 0) return;
    at = start + open.length;
    const next = xml.charCodeAt(at);
    // The name must end here (`<a:rPr` is not `<a:rPrX`).
    if (!(next === 0x3e || next === 0x2f || next === 0x20 || next === 0x09 || next === 0x0a || next === 0x0d))
      continue;
    if (gt < at) gt = xml.indexOf('>', at);
    if (gt < 0) return;
    if (gt - at > MAX_TAG_CHARS) continue;
    const empty = xml.charCodeAt(gt - 1) === 0x2f;
    yield { attrs: xml.slice(at, empty ? gt - 1 : gt), at: start, end: gt + 1, empty };
    at = gt + 1;
  }
}

/** Relationships read from one `.rels` part at most (a slide names a few dozen). */
export const MAX_RELS = 1_000;

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The attributes of one start tag's text (`startTags`' `attrs`), by name. */
export function attributes(attrs: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of attrs.matchAll(ATTR_RE)) out.set(m[1]!, m[2] ?? m[3] ?? '');
  return out;
}

/** `part`'s relationship part: `ppt/slides/slide3.xml` → `ppt/slides/_rels/slide3.xml.rels`. */
export function relsPartOf(part: string): string {
  const cut = part.lastIndexOf('/');
  return `${part.slice(0, cut + 1)}_rels/${part.slice(cut + 1)}.rels`;
}

/**
 * A relationship's target as a part name: relative to `part`'s folder (`../charts/chart1.xml`), or from the
 * package root when it starts with '/'. Undefined when it climbs out of the package or is not a plain name.
 */
export function resolveTarget(part: string, target: string): string | undefined {
  if (!target || target.length > 1_000 || /^[a-z][a-z0-9+.-]*:/i.test(target)) return undefined;
  const base = target.startsWith('/') ? [] : part.split('/').slice(0, -1);
  for (const seg of target.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!base.length) return undefined;
      base.pop();
    } else base.push(seg);
  }
  return base.length ? base.join('/') : undefined;
}

/**
 * The internal targets `part` names with a relationship whose type ends with `typeSuffix` (`/chart`,
 * `/diagramData`), in document order, from the XML of its `.rels` part (`relsXml`). At most `MAX_RELS`.
 */
export function relatedTargets(part: string, relsXml: string, typeSuffix: string): string[] {
  const out: string[] = [];
  let n = 0;
  for (const t of startTags(relsXml, 'Relationship')) {
    if (++n > MAX_RELS) break;
    const a = attributes(t.attrs);
    if (a.get('TargetMode')?.toLowerCase() === 'external') continue;
    if (!a.get('Type')?.endsWith(typeSuffix)) continue;
    const target = resolveTarget(part, a.get('Target') ?? '');
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}
