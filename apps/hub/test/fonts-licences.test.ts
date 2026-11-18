/**
 * The image's fonts, their licence records and the bundled list agree (design/27 §10, `fonts/LICENSES.md`): every
 * font package the Dockerfile's runtime stage installs has a licence row in LICENSES.md, every package recorded
 * there is one the image installs, the bundled table records exactly the packages `BUNDLED_FACES` registers, and a
 * package recorded as installed but not served bundles no face. It never says which packages those are: it keeps
 * the three records in step, so a font package added to the image without its licence recorded fails here. It
 * also checks that a dpkg rule the runtime stage writes (the one that leaves out the Serif CJK collections) is
 * removed in the same `RUN`, so the published image keeps none.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUNDLED_FACES } from '../src/fonts/bundled.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** A Debian font package name (`fonts-…`). */
const FONT_PACKAGE = /^fonts-[a-z0-9][a-z0-9.+-]*$/;

/**
 * The commands of each `RUN` of the Dockerfile's runtime stage: the stage's instructions with comment lines dropped
 * and continued lines joined, each `RUN` split at `&&` and `;`.
 */
function runtimeRuns(dockerfile: string): string[][] {
  const at = dockerfile.search(/^FROM\s+\S+\s+AS\s+runtime\s*$/im);
  expect(at, 'the Dockerfile has a runtime stage').toBeGreaterThanOrEqual(0);
  const text = dockerfile
    .slice(at)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
    .replace(/\\\n/g, ' ');
  return text
    .split('\n')
    .filter((line) => /^\s*RUN\s/i.test(line))
    .map((line) =>
      line
        .replace(/^\s*RUN\s+/i, '')
        .split(/&&|;/)
        .map((c) => c.trim()),
    );
}

/** The font packages the runtime stage asks apt-get to install: the `fonts-*` words of every `apt-get install`. */
function imageFontPackages(dockerfile: string): string[] {
  const found = new Set<string>();
  for (const run of runtimeRuns(dockerfile))
    for (const command of run) {
      const words = command.split(/\s+/);
      const install = words.findIndex((w, i) => w === 'install' && words[i - 1] === 'apt-get');
      if (install < 0) continue;
      for (const w of words.slice(install + 1)) if (FONT_PACKAGE.test(w)) found.add(w);
    }
  return [...found].sort();
}

/**
 * The dpkg rule files (`/etc/dpkg/dpkg.cfg.d/…`) a runtime `RUN` writes with `>` or `>>` and does not `rm` in a later
 * command of the same `RUN`: rules the published image would keep.
 */
function dpkgRulesKept(dockerfile: string): string[] {
  const kept: string[] = [];
  for (const run of runtimeRuns(dockerfile))
    run.forEach((command, i) => {
      const file = /(?:^|\s)>>?\s*(\/etc\/dpkg\/dpkg\.cfg\.d\/\S+)/.exec(command)?.[1];
      if (!file) return;
      const removed = run
        .slice(i + 1)
        .some((later) => /^rm\s/.test(later) && later.split(/\s+/).slice(1).includes(file));
      if (!removed) kept.push(file);
    });
  return kept;
}

/** Each licence table of LICENSES.md: the heading it sits under and the package (first word) of each row. */
function licenceTables(md: string): { heading: string; packages: string[] }[] {
  const tables: { heading: string; packages: string[] }[] = [];
  let heading = '';
  let column = -1;
  for (const line of md.split('\n')) {
    if (line.startsWith('#')) {
      heading = line.replace(/^#+\s*/, '');
      column = -1;
      continue;
    }
    if (!line.startsWith('|')) {
      column = -1;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (column < 0) {
      column = cells.findIndex((c) => c.startsWith('Package'));
      if (column >= 0) tables.push({ heading, packages: [] });
      continue;
    }
    if (cells.every((c) => /^-+$/.test(c))) continue;
    tables.at(-1)?.packages.push(cells[column]?.split(/\s+/)[0] ?? '');
  }
  return tables;
}

const unique = (xs: readonly string[]) => [...new Set(xs)].sort();

describe("the image's fonts and their licences (fonts/LICENSES.md)", () => {
  const installed = imageFontPackages(read('Dockerfile'));
  const tables = licenceTables(read('apps/hub/src/fonts/LICENSES.md'));
  const bundledTable = tables.filter((t) => /^Bundled fonts/i.test(t.heading));
  const otherTables = tables.filter((t) => !/^Bundled fonts/i.test(t.heading));
  const recorded = unique(tables.flatMap((t) => t.packages));
  const bundledPackages = unique(BUNDLED_FACES.map((f) => f.pkg));

  it('reads the records it compares', () => {
    expect(installed.length).toBeGreaterThan(0);
    expect(bundledTable).toHaveLength(1);
    for (const p of recorded) expect(p).toMatch(FONT_PACKAGE);
  });

  it('records the licence of every font package the image installs', () => {
    expect(installed.filter((p) => !recorded.includes(p))).toEqual([]);
  });

  it('records no package the image does not install', () => {
    expect(recorded.filter((p) => !installed.includes(p))).toEqual([]);
  });

  it("takes every bundled face from a package the image installs, and lists those packages' licences as bundled", () => {
    expect(bundledPackages.filter((p) => !installed.includes(p))).toEqual([]);
    expect(unique(bundledTable[0]?.packages ?? [])).toEqual(bundledPackages);
  });

  it('bundles no face from a package recorded as installed but not served', () => {
    const notServed = unique(otherTables.flatMap((t) => t.packages));
    expect(notServed.filter((p) => bundledPackages.includes(p))).toEqual([]);
  });
});

describe("the image's dpkg rules (Dockerfile)", () => {
  it('finds a dpkg rule a RUN writes and keeps, and one it removes', () => {
    const stage = (run: string) => `FROM debian AS build\nFROM debian AS runtime\n${run}\n`;
    const write =
      "RUN echo 'path-exclude=/usr/share/x/*' > /etc/dpkg/dpkg.cfg.d/x \\\n && apt-get install -y y";
    expect(dpkgRulesKept(stage(write))).toEqual(['/etc/dpkg/dpkg.cfg.d/x']);
    expect(dpkgRulesKept(stage(`${write} \\\n && rm /etc/dpkg/dpkg.cfg.d/x`))).toEqual([]);
  });

  it('removes every dpkg rule the runtime stage writes in the same RUN, so the published image keeps none', () => {
    expect(dpkgRulesKept(read('Dockerfile'))).toEqual([]);
  });
});
