import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CI_PORT_BASE,
  DEFAULT_BASE_MIN,
  DEFAULT_BASE_SLOTS,
  defaultBase,
  PORT_SPAN,
  PORT_TABLE,
  type PortRow,
  pathHash,
  portBase,
} from './ports.ts';

/**
 * The e2e port table (design/23 "Ports"): every spec takes its ports from `e2e/ports.ts`, the rows do not
 * overlap, and the defaults stay clear of the ephemeral range (32768 and up on Linux) and of the
 * 11000-15999 block other runs on the shared machine use.
 */
const E2E = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(E2E, '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every file of the suite that could open a port: e2e/**\/*.ts and the Playwright config. */
const FILES = [...sources(E2E), join(ROOT, 'playwright.config.ts')]
  .map((p) => ({ path: relative(E2E, p).replaceAll('\\', '/'), text: readFileSync(p, 'utf8') }))
  .filter((f) => f.path !== 'ports.ts' && f.path !== 'ports.test.ts');

const rows = Object.entries(PORT_TABLE) as [PortRow, (typeof PORT_TABLE)[PortRow]][];

/** What reads a port without the table: a port variable, a literal port, or arithmetic on a port. */
const FORBIDDEN: { why: string; re: RegExp }[] = [
  { why: 'reads a port variable', re: /process\.env(?:\.|\[\s*['"`])ORDO_\w*PORT\w*/g },
  { why: 'literal port in a URL', re: /localhost:\d{2,5}\b/g },
  {
    why: 'literal port passed to a hub, server or window',
    re: /\b(?:fresh|hubApi|pptxHub|editorHub|startHub|listen|roleWindow|opOrigin|outputFaces|launchChaosOutput|login)\(\s*\d{2,5}\b/g,
  },
  { why: 'literal port passed to a proxy', re: /new \w*Proxy\(\s*(?:\d{2,5}\b|[^,()]+,\s*\d{2,5}\b)/g },
  {
    why: 'literal port in a port constant',
    re: /\b(?!viewport)\w*(?:port|PORT|Port|BASE)\s*[=:]\s*\d{3,5}\b/g,
  },
  { why: 'port arithmetic outside the table', re: /\b\w*(?:port|PORT|Port|BASE)\s*\+\s*\d/g },
];

describe('e2e port table', () => {
  it('rows have unique offsets and disjoint ranges inside the span', () => {
    const offsets = rows.map(([, r]) => r.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    const sorted = [...rows].sort((a, b) => a[1].offset - b[1].offset);
    for (let i = 0; i < sorted.length; i++) {
      const [name, r] = sorted[i]!;
      expect(Number.isInteger(r.offset) && r.offset >= 0, name).toBe(true);
      expect(Number.isInteger(r.count) && r.count >= 1, name).toBe(true);
      expect(r.offset + r.count, `${name} ends inside the span`).toBeLessThanOrEqual(PORT_SPAN);
      const next = sorted[i + 1];
      if (next) expect(r.offset + r.count, `${name} overlaps ${next[0]}`).toBeLessThanOrEqual(next[1].offset);
    }
    const specs = rows.map(([, r]) => r.spec);
    expect(new Set(specs).size, 'one row per spec').toBe(specs.length);
  });

  it('every default base, for any checkout path, stays in 16000..32767 with the whole span', () => {
    expect(DEFAULT_BASE_MIN).toBeGreaterThanOrEqual(16_000);
    for (let slot = 0; slot < DEFAULT_BASE_SLOTS; slot++) {
      const base = DEFAULT_BASE_MIN + 1000 * slot;
      expect(base).toBeGreaterThanOrEqual(16_000);
      expect(base + PORT_SPAN).toBeLessThan(32_768);
    }
    expect(CI_PORT_BASE + PORT_SPAN).toBeLessThan(32_768);
    for (const p of ['/home/user/ordo', '/tmp/x/wt-m9/a', '/tmp/x/wt-m9/b', 'C:\\ordo', '', 'ä/😀']) {
      const b = defaultBase(p);
      expect(b % 1000).toBe(0);
      expect(b).toBeGreaterThanOrEqual(DEFAULT_BASE_MIN);
      expect(b + PORT_SPAN).toBeLessThan(32_768);
      expect(pathHash(p)).toBe(pathHash(p));
    }
  });

  it('the base comes from ORDO_E2E_PORT_BASE, else CI, else the checkout', () => {
    expect(portBase({ ORDO_E2E_PORT_BASE: '31000' }, '/a')).toBe(31_000);
    expect(portBase({ CI: 'true' }, '/a')).toBe(CI_PORT_BASE);
    expect(portBase({ ORDO_CI: '1' }, '/a')).toBe(CI_PORT_BASE);
    expect(portBase({}, '/a')).toBe(defaultBase('/a'));
    expect(portBase({ ORDO_E2E_PORT_BASE: '' }, '/a')).toBe(defaultBase('/a'));
    for (const bad of ['12.5', 'x', '80', '65000', '-1'])
      expect(() => portBase({ ORDO_E2E_PORT_BASE: bad }, '/a'), bad).toThrow(RangeError);
  });

  it('no spec reads a port variable, writes a literal port or adds to a port', () => {
    const found: string[] = [];
    for (const f of FILES)
      for (const { why, re } of FORBIDDEN)
        for (const m of f.text.matchAll(re)) {
          const line = f.text.slice(0, m.index).split('\n').length;
          found.push(`${f.path}:${line} ${why}: ${m[0]}`);
        }
    expect(found).toEqual([]);
  });

  it('each spec takes only its own rows, within their counts, and every existing row owner uses its row', () => {
    const problems: string[] = [];
    const used = new Map<string, Set<string>>();
    for (const f of FILES)
      for (const m of f.text.matchAll(/\bportOf\(\s*'([^']+)'\s*(?:,\s*([^)]+))?\)/g)) {
        const name = m[1]!;
        const row = PORT_TABLE[name as PortRow] as (typeof PORT_TABLE)[PortRow] | undefined;
        const at = `${f.path}:${f.text.slice(0, m.index).split('\n').length}`;
        if (!row) {
          problems.push(`${at} unknown row '${name}'`);
          continue;
        }
        if (row.spec !== f.path) problems.push(`${at} takes '${name}', the row of ${row.spec}`);
        const i = m[2]?.trim();
        if (i !== undefined && /^\d+$/.test(i) && Number(i) >= row.count)
          problems.push(`${at} asks '${name}' for #${i} of ${row.count}`);
        if (!used.has(name)) used.set(name, new Set());
        used.get(name)!.add(f.path);
      }
    for (const [name, r] of rows) {
      if (name === 'shared') continue;
      if (existsSync(join(E2E, r.spec)) && !used.get(name)?.has(r.spec))
        problems.push(`${r.spec} exists but does not take its row '${name}'`);
    }
    expect(problems).toEqual([]);
  });

  it('a spec that starts a hub or a server of its own takes a row', () => {
    const starts = /HubProcess\.fresh\(|\bpptxHub\(|\beditorHub\(|\bstartHub\(|new TcpProxy\(|\.listen\(/;
    const helpers = new Set([
      'hubproc.ts',
      'pptxlive.ts',
      'editorhelpers.ts',
      'ipad/ipadhelpers.ts',
      'tcpproxy.ts',
      'linkhelpers.ts',
      'helpers.ts',
    ]);
    const missing = FILES.filter(
      (f) =>
        f.path.endsWith('.spec.ts') &&
        starts.test(f.text) &&
        !/\bportOf\(/.test(f.text) &&
        !helpers.has(f.path),
    ).map((f) => f.path);
    expect(missing).toEqual([]);
  });
});
