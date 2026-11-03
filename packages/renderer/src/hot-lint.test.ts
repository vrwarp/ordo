import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The zero-allocation rule for frame-path code (design/24): inside any function whose body starts with
 * a `/* @hot *\/` marker, no closures, template strings, `new`, object literals or array literals.
 * A line may opt out with a trailing `// alloc-ok` comment (rare paths such as error reporting).
 */

const dir = dirname(fileURLToPath(import.meta.url));
const MARK = '/* @hot */';

type Violation = { file: string; line: number; rule: string; text: string };

function hotBodies(src: string): { start: number; body: string }[] {
  const out: { start: number; body: string }[] = [];
  let i = src.indexOf(MARK);
  while (i >= 0) {
    let depth = 1;
    let j = i + MARK.length;
    for (; j < src.length && depth > 0; j++) {
      const ch = src[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    out.push({ start: i, body: src.slice(i + MARK.length, j - 1) });
    i = src.indexOf(MARK, j);
  }
  return out;
}

const RULES: [string, RegExp][] = [
  ['closure', /=>/],
  ['template string', /`/],
  ['new', /\bnew\s+[A-Z]/],
  ['object literal', /(^|[=(,?]|\breturn)\s*\{\s*(\w+\s*:|\}|\.\.\.)/],
  ['array literal', /(^|[=(,?]|\breturn)\s*\[/],
];

function lint(file: string, src: string): Violation[] {
  const v: Violation[] = [];
  for (const { start, body } of hotBodies(src)) {
    const baseLine = src.slice(0, start).split('\n').length;
    body.split('\n').forEach((raw, k) => {
      if (raw.includes('// alloc-ok')) return;
      const line = raw.replace(/\/\/.*$/, '').replace(/'[^']*'/g, "''");
      for (const [rule, re] of RULES)
        if (re.test(line)) v.push({ file, line: baseLine + k, rule, text: raw.trim() });
    });
  }
  return v;
}

describe('frame-path allocation lint', () => {
  it('finds hot functions', () => {
    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'));
    const count = all.reduce((n, s) => n + hotBodies(s).length, 0);
    expect(count).toBeGreaterThan(10);
  });

  it('flags allocations in a sample', () => {
    const sample = `function f() {\n  ${MARK}\n  const a = [1];\n  const o = { x: 1 };\n  g(() => 1);\n  const s = \`x\`;\n}`;
    expect(lint('sample', sample).map((x) => x.rule)).toEqual(['array literal', 'object literal', 'closure', 'template string']);
  });

  it('has no allocations in hot code', () => {
    const violations: Violation[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.test.ts')))
      violations.push(...lint(f, readFileSync(join(dir, f), 'utf8')));
    expect(violations).toEqual([]);
  });
});
