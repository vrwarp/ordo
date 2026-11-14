/**
 * The compact layout's stylesheet (design/28 §2.2, §6; src/compact.css): every rule is scoped to
 * html[data-layout="compact"], so the venue PC and the iPad's regular layout render exactly as before; no other
 * stylesheet names the attribute; and it uses logical properties only (P1's right-to-left layouts mirror them).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url);
const SCOPE = 'html[data-layout="compact"]';

/**
 * The selector lists of a stylesheet's style rules (inside @media and @supports too; not the frames of a
 * @keyframes, which are not selectors), comments removed.
 */
function selectorLists(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  const open: string[] = [];
  let prelude = '';
  for (const ch of text) {
    if (ch === '{') {
      const p = prelude.trim();
      if (!p.startsWith('@') && !open.some((o) => o.startsWith('@keyframes'))) out.push(p);
      open.push(p);
      prelude = '';
    } else if (ch === '}') {
      open.pop();
      prelude = '';
    } else if (ch === ';') prelude = '';
    else prelude += ch;
  }
  return out;
}

/** A selector list split at its top-level commas (not those inside :is(), :not() or attribute values). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const ch of list) {
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const compactCss = readFileSync(new URL('compact.css', SRC), 'utf8');

describe('compact.css', () => {
  it('has rules, and every selector starts with the compact scope', () => {
    const lists = selectorLists(compactCss);
    expect(lists.length).toBeGreaterThan(20);
    const unscoped = lists.flatMap(splitSelectors).filter((s) => !s.replace(/\s+/g, ' ').startsWith(SCOPE));
    expect(unscoped).toEqual([]);
  });

  it('the parser sees nested rules and top-level commas only', () => {
    expect(
      selectorLists(
        '@media (x) { a, b:is(c, d) { color: red } } /* e { } */ f { g: h; } @keyframes k { from { x: 1 } to { x: 2 } } i { }',
      ),
    ).toEqual(['a, b:is(c, d)', 'f', 'i']);
    expect(splitSelectors('a, b:is(c, d), e[x="1,2"]')).toEqual(['a', 'b:is(c, d)', 'e[x="1,2"]']);
  });

  it('uses logical properties only: no physical left or right', () => {
    const text = compactCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const physical = text.match(
      /(?:^|[\s;{])(?:(?:margin|padding|border)-(?:left|right)(?:-[a-z]+)?|left|right)\s*:|text-align\s*:\s*(?:left|right)|float\s*:\s*(?:left|right)/gm,
    );
    expect(physical).toBeNull();
  });
});

describe('the other stylesheets', () => {
  it('never name data-layout (the regular layout keeps its rules as they were)', () => {
    const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
      (f) => f.endsWith('.css') && !f.endsWith('compact.css'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(new URL(f, SRC), 'utf8'), f).not.toContain('data-layout');
  });
});
