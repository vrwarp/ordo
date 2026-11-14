/**
 * Every ordo client sends `x-ordo` on its writes (design/28 §4): once Phones is on, the hub refuses a signed-in
 * full session's write without it, so a write path that forgot it would fail on the venue PC. This scans the
 * clients' sources for every non-GET request (a literal non-GET method, an XHR, a fetch whose init comes from a
 * variable) and fails on one that neither goes through `@ordo/client`'s api()/upload() (which send it) nor sets
 * the header itself. One request is allowlisted, with its reason.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TREES = [
  'apps/operator/src',
  'apps/output/src',
  'apps/stage/src',
  'packages/client/src',
  'packages/cache/src',
  'apps/demo/scripts',
  'tools/soak/src',
  'tools/pptx-fidelity/src',
];

/** Requests that never reach a hub, by file and the request's path. */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  {
    file: 'apps/operator/src/components/DemoBanner.tsx',
    contains: '/api/v1/demo/reset',
    why: "POST /api/v1/demo/reset is answered by the Pages demo's service worker, never by a hub",
  },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules' && name !== '__tests__') out.push(...sources(p));
    } else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const SETS_HEADER = /HEADER_CLIENT|['"]x-ordo['"]/;
const VIA_CLIENT = /import\s*\{[^}]*\b(api|upload)\b[^}]*\}\s*from\s*'@ordo\/client'/;

type Finding = { file: string; line: number; what: string };

/** Non-GET requests in one file that do not send the header. */
export function unsent(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  const lineOf = (i: number) => src.slice(0, i).split('\n').length;
  const calls = [
    ...src.matchAll(
      /\b(api|upload|fetch|request\.fetch)\s*(<[^>(]*>)?\s*\(|\.open\(\s*['"](POST|PUT|PATCH|DELETE)['"]/g,
    ),
  ];
  const near = (i: number) => src.slice(Math.max(0, i - 800), i + 600);
  const allowed = (i: number) =>
    ALLOWED.some((a) => file === a.file && src.slice(i, i + 200).includes(a.contains));
  // Literal non-GET methods: through the nearest call before them.
  for (const m of src.matchAll(/method:\s*['"](POST|PUT|PATCH|DELETE)['"]/g)) {
    const i = m.index ?? 0;
    const call = calls.filter((c) => (c.index ?? 0) < i).pop();
    const via = call?.[1];
    if (allowed(call?.index ?? i)) continue;
    if (via === 'api' || via === 'upload') {
      if (VIA_CLIENT.test(src) || file === 'packages/client/src/api.ts' || SETS_HEADER.test(src)) continue;
      out.push({ file, line: lineOf(i), what: `${m[1]} through a local ${via}() that does not send x-ordo` });
    } else if (!SETS_HEADER.test(near(call?.index ?? i)))
      out.push({ file, line: lineOf(i), what: `${m[1]} by ${via ?? 'an unknown call'} without x-ordo` });
  }
  // XHR writes, and fetches whose init (method included) comes from a variable.
  for (const c of calls) {
    const i = c.index ?? 0;
    if (allowed(i)) continue;
    const args = src.slice(i, i + 400);
    const isXhr = !!c[3];
    const varInit =
      (c[1] === 'fetch' || c[1] === 'request.fetch') &&
      /\.\.\.init\b|\bmethod\s*[,}]|\bmethod:\s*[a-z]/.test(args.slice(0, 300));
    if ((isXhr || varInit) && !SETS_HEADER.test(near(i)))
      out.push({
        file,
        line: lineOf(i),
        what: isXhr ? 'XHR write without x-ordo' : 'fetch with a variable init without x-ordo',
      });
  }
  return out;
}

describe('every ordo client sends x-ordo on its writes', () => {
  const files = TREES.flatMap((t) => sources(join(ROOT, t))).map((p) =>
    relative(ROOT, p).replaceAll('\\', '/'),
  );

  it('no non-GET request skips the header (one allowlisted: the Pages demo reset)', () => {
    const findings = files.flatMap((f) => unsent(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(findings).toEqual([]);
    expect(files.length).toBeGreaterThan(100);
  });

  it('the scan finds what it must: a bare fetch POST, an XHR, a variable init, a local helper', () => {
    expect(unsent('x.ts', "await fetch('/api/v1/x', { method: 'POST' });")).toHaveLength(1);
    expect(unsent('x.ts', "xhr.open('PUT', url);")).toHaveLength(1);
    expect(unsent('x.ts', 'const r = await fetch(url, { ...init, headers });')).toHaveLength(1);
    expect(
      unsent('x.ts', "const api = (p, i) => fetch(p, i);\nawait api('/x', { method: 'DELETE' });"),
    ).toHaveLength(1);
    expect(unsent('x.ts', "await fetch('/x', { method: 'POST', headers: { 'x-ordo': '1' } });")).toEqual([]);
    expect(
      unsent('x.ts', "import { api } from '@ordo/client';\nawait api('/x', { method: 'DELETE' });"),
    ).toEqual([]);
    expect(unsent('x.ts', "await fetch(fileUrl(h), { credentials: 'same-origin' });")).toEqual([]);
  });

  it('the allowlist names only requests that exist', () => {
    for (const a of ALLOWED) expect(readFileSync(join(ROOT, a.file), 'utf8')).toContain(a.contains);
  });
});
