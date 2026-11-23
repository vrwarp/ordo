import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { DECOR_LIMITS, LOGICAL_HEIGHT, LOGICAL_WIDTH, TABLE_LIMITS } from '@ordo/domain';
import { PRERENDER_VERSION } from '@ordo/domain/prerender.ts';
import { describe, expect, it } from 'vitest';

/*
 * The picture version guard (design 29 section 1.2, sub-wave 3 bake-render): a pre-rendered picture is made by this
 * package's drawing code, so a change of that code changes what every stored picture should look like. A picture is
 * keyed by `PRERENDER_VERSION` (packages/domain/src/prerender.ts), and this test makes a change of the drawing code
 * force a DECISION, as packages/protocol/src/version.test.ts does for APP_VERSION: either the pixels are the same
 * (a refactor, a speed-up, a comment: record the digest below at the same version) or they are not (a face, a line
 * break, a colour, a resample, an encoder: raise PRERENDER_VERSION, which makes every stored picture stale at once,
 * the stand-bys covering the gap, and record both).
 *
 * WHAT IS DIGESTED (the fail-safe form: a file is digested unless it is excluded on purpose, so a new file is):
 * every non-test source under packages/renderer/src except `NOT_PIXELS`; the output's decoders and the picture
 * provider the bake reuses (`EXTRA`); the domain sources whose code decides pixels and is not part of the key (the
 * inventory of every `@ordo/domain` runtime name the renderer's sources import: bullets, cellstyle, color, content,
 * defaults, m9-readers, pathdata, readable and table are digested; stage notes, cues, live, time, palette and resolve
 * serve the live bands, the stage and the keys, and draw nothing a picture holds); the numbers of the domain's limits
 * that the drawing reads (`LIMITS`); and the renderer's `dependencies` (the line breaker and bidi tables decide where
 * lines break). A dependency's own version is not seen: a bump of a transitive package is a named limit.
 *
 * Comments, whitespace and layout are ignored, so a note or a reformat does not ask for a record.
 */

const root = new URL('../../../', import.meta.url).pathname;
const src = join(root, 'packages/renderer/src');

/**
 * Files under packages/renderer/src that no picture reads, each with its reason (checked: guards (b) and (c)). Not
 * listed, although they look like presentation, because the drawer modules the bake loads reach them by an import
 * (guard (c) found it): scene.ts and raster.ts (table/reach.ts -> sprite.ts -> raster.ts -> scene.ts), and the table's
 * edit.ts and hit.ts (table/index.ts re-exports them). A file the bake's closure reaches is digested, whether or not
 * the bundler would tree-shake it: a false inclusion costs one record, a false exclusion ships stale pictures.
 */
const NOT_PIXELS: Record<string, string> = {
  'compositor.ts': 'layer compositing and presentation on a screen',
  'gpu.ts': 'the WebGPU presenter',
  'frame-ring.ts': 'the output frame ring (presentation)',
  'health.ts': 'telemetry',
  'messages.ts': 'worker message types',
  'timing.ts': 'timing helpers',
  'cache-policy.ts': 'cache policy of the live caches',
  'bitmap-cache.ts': 'a cache of decoded bitmaps',
  'plan.ts': 'the live planner: what a screen draws and when, not how a picture is drawn',
  'props.ts': 'props on a live layer',
  'scene-raster.ts': 'the live layers and the video split',
  'stacks.ts': 'the live layer stacks',
  'text/cursor.ts': 'text editing',
};

/** What each digested file of another package is, relative to the repository root. */
const EXTRA = [
  'apps/output/src/decode.ts',
  'apps/output/src/pictures.ts',
  'apps/output/src/prepare/frame.ts',
  'apps/operator/src/workers/bakeJob.ts',
  'packages/domain/src/bullets.ts',
  'packages/domain/src/cellstyle.ts',
  'packages/domain/src/color.ts',
  'packages/domain/src/content.ts',
  'packages/domain/src/defaults.ts',
  'packages/domain/src/m9-readers.ts',
  'packages/domain/src/pathdata.ts',
  'packages/domain/src/readable.ts',
  'packages/domain/src/table.ts',
];

/** The numbers of the domain that the drawing reads (a limit that changes moves pixels). */
const LIMITS = { LOGICAL_WIDTH, LOGICAL_HEIGHT, TABLE_LIMITS, DECOR_LIMITS };

/**
 * The recorded drawing version and the digest of the sources above at it. Record the digest at the same version when
 * the pixels are the same; raise PRERENDER_VERSION and record both when they are not. The integrator records it once
 * after the last merge of a sub-wave; a track that edits a digested source for the same pixels records it on its
 * branch and says so in its notes.
 */
const RECORDED = {
  version: 1,
  // shape-raster-2 (same pixels, PRERENDER_VERSION unchanged): clamp.ts `clampOrigin` copies the optional provenance field `raster` of
  // an object's origin; an origin is never drawn, so no pixel moves (the renderer, text and clamp tests pass unchanged). The
  // branch's own recorded value yielded to the integrator's at the merge; the integrator records the merged digest right after.
  // Main's PR #41 merged in (same pixels, PRERENDER_VERSION unchanged): text2d.ts draws the Stage Display's speaker notes
  // with highlights, amber bullets and cue pills (`drawRichStageNotes2D`, reached only from `drawStagePreview2D`, which
  // `drawSlide2D` calls only for a lyric-only look whose stage notes are on). A picture is drawn with no look, so it takes
  // the authored branch that returns before that code: text2d.test.ts ('stage notes reach only a stage look whose notes are
  // on') holds that a slide's notes change nothing a draw records without a look or with any look but such a stage look,
  // and a comparison of the canvas calls of the code before and after (72 cases: 6 slides, 6 looks, 2 kinds) found them
  // equal except the 4 cases of a stage look with notes on.
  // Countdown presets (same slide pixels, PRERENDER_VERSION unchanged): clamp.ts preserves optional `countdownPreset`
  // and `countdownCorner` on `PropsRule`, and raster.ts draws the progress ring in `rasterProps` (props layer only;
  // slide prerendering does not call `rasterProps` or read `PropsRule`).
  digest: '96f567ff4456cad8cfe4e19dc6660e92427bd683be8fed7a3fd6b32fdda7ab1a',
};

/** The source without comments and layout. */
export function normalize(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A SHA-256 over each path and its normalised text, in path order (a plate version can digest its own list). */
export function digestOf(files: readonly { path: string; text: string }[]): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    h.update(`${f.path}\n`);
    h.update(normalize(f.text));
    h.update('\n');
  }
  return h.digest('hex');
}

const isSource = (name: string) =>
  name.endsWith('.ts') &&
  !name.endsWith('.d.ts') &&
  !/\.(?:browser\.)?test\.ts$/.test(name) &&
  !/(?:^|\.)(?:page\.)?test-util\.ts$/.test(name);

/** Every non-test source under `dir`, as paths relative to it. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else if (isSource(name)) out.push(relative(base, p));
  }
  return out;
}

function sources(): { path: string; text: string }[] {
  const files = walk(src)
    .filter((p) => !(p in NOT_PIXELS))
    .map((p) => ({ path: `packages/renderer/src/${p}`, text: readFileSync(join(src, p), 'utf8') }));
  for (const p of EXTRA) files.push({ path: p, text: readFileSync(join(root, p), 'utf8') });
  const pkg = JSON.parse(readFileSync(join(root, 'packages/renderer/package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  files.push({
    path: 'packages/renderer/package.json#dependencies',
    text: JSON.stringify(pkg.dependencies ?? {}),
  });
  files.push({ path: 'domain limits', text: JSON.stringify(LIMITS) });
  return files;
}

/** The relative modules a file imports: `from './x.ts'` (barrels left out) and `import('./x.ts')` literals. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  const add = (spec: string, dynamic: boolean) => {
    if (!spec.startsWith('.')) return;
    const target = resolve(dirname(file), spec);
    if (!dynamic && /(^|\/)index\.ts$/.test(spec)) return; // a barrel re-exports editing and probe code that no draw reaches
    if (existsSync(target)) out.push(target);
  };
  // Type-only imports and exports leave no code behind: only the others reach a file.
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\sfrom\s+'([^']+)'/g)) {
    const names = m[2]!;
    const typesOnly =
      m[1] !== undefined ||
      (/^\{[^}]*\}$/.test(names.trim()) &&
        names
          .replace(/[{}]/g, '')
          .split(',')
          .filter((n) => n.trim())
          .every((n) => /^\s*type\s/.test(n)));
    if (!typesOnly) add(m[3]!, false);
  }
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+'([^']+)'/g)) add(m[1]!, false);
  for (const m of text.matchAll(/\bimport\('([^']+)'\)/g)) add(m[1]!, true);
  return out;
}

/** Every file reachable from `entry` by `importsOf`. */
function closureOf(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const next of importsOf(f)) queue.push(next);
  }
  return seen;
}

describe("the renderer's picture version", () => {
  it('records the digest of the drawing sources at PRERENDER_VERSION', () => {
    const now = digestOf(sources());
    expect(
      { version: PRERENDER_VERSION, digest: now },
      `The drawing sources changed (digest ${now}). If the pixels a slide draws are the same (a refactor, a speed-up, a comment), record this digest at the same version in RECORDED. If they are not (a face, a line break, a colour, a resample, an encoder), raise PRERENDER_VERSION in packages/domain/src/prerender.ts, which makes every stored picture stale at once (the stand-by pictures cover the gap), and record both.`,
    ).toEqual(RECORDED);
  });

  it('every entry of NOT_PIXELS names a file that exists (no stale exclusion)', () => {
    for (const p of Object.keys(NOT_PIXELS)) expect(existsSync(join(src, p)), p).toBe(true);
  });

  it("no excluded file is imported by the bake's closure: an exclusion is a proof, not a hope", () => {
    const reach = closureOf(join(src, 'bake.ts'));
    for (const p of Object.keys(NOT_PIXELS))
      expect(reach.has(join(src, p)), `bake.ts reaches ${p}`).toBe(false);
    expect(reach.has(join(src, 'frame.ts'))).toBe(true);
    expect(reach.has(join(src, 'table/index.ts')), 'the drawer loaders are followed').toBe(true);
    expect(reach.has(join(src, 'text/fonts.ts'))).toBe(true);
  });

  it("the extra inputs exist, and the walk finds the renderer's sources", () => {
    for (const p of EXTRA) expect(existsSync(join(root, p)), p).toBe(true);
    const files = sources().map((f) => f.path);
    expect(files).toContain('packages/renderer/src/bake.ts');
    expect(files).toContain('packages/renderer/src/index.ts');
    expect(files).not.toContain('packages/renderer/src/plan.ts');
    expect(files.filter((p) => p.endsWith('.test.ts') || p.endsWith('test-util.ts'))).toEqual([]);
  });

  it('ignores comments and layout, and notices a changed number', () => {
    expect(normalize('const a = 1; // note\n/* block\n */  const  b = "http://x";')).toBe(
      'const a = 1; const b = "http://x";',
    );
    const a = digestOf([{ path: 'x.ts', text: 'const a = 1; // one\n' }]);
    expect(digestOf([{ path: 'x.ts', text: '/* two */ const   a = 1;' }])).toBe(a);
    expect(digestOf([{ path: 'x.ts', text: 'const a = 2;' }])).not.toBe(a);
    expect(digestOf([{ path: 'y.ts', text: 'const a = 1;' }])).not.toBe(a);
  });

  it('digests the files in path order, whatever order they are given in', () => {
    const f = [
      { path: 'b.ts', text: '1' },
      { path: 'a.ts', text: '2' },
    ];
    expect(digestOf(f)).toBe(digestOf([...f].reverse()));
  });

  it('costs one read of each source: well under 300 ms', () => {
    const t = performance.now();
    digestOf(sources());
    const ms = performance.now() - t;
    console.log(`the picture version digest: ${sources().length} sources, ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500); // the budget of this test on a loaded machine; the figure above is the cost
  });
});
