import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/**
 * Golden-image test of the text rasterizer and looks (design/14, design/23, design/27 §14 item 4). Bundles
 * golden/page.ts, runs it in headless Chromium, renders every case to a PNG and compares it to
 * golden/expected/<case>.png with a per-pixel tolerance (anti-aliasing differs slightly between Chromium
 * builds). It also draws the legacy cases again with the font resolver installed, against the same PNGs,
 * and runs the line-break invariance check (identical text drawing at 320, 960, 1920 and 3840 px wide).
 *
 *   pnpm --filter @ordo/renderer golden            compare
 *   pnpm --filter @ordo/renderer golden --update   rewrite the expected PNGs
 *   pnpm --filter @ordo/renderer golden --strict   a skip fails the run (CI sets CI=true: always strict)
 *
 * Text is drawn with faces the runner injects from the system, recorded in expected/meta.json: 'Golden' is
 * DejaVu Sans (fonts-dejavu-core), 'Golden Serif' FreeSerif (fonts-freefont-ttf) and 'Golden CJK' IPAGothic
 * (fonts-ipafont-gothic); Playwright's `install --with-deps chromium` installs the last two on Ubuntu.
 * meta.json lists the files the expected PNGs were made with, and a comparison loads exactly those files,
 * whatever else the machine has (a font added to the system can no longer turn the run into a skip). When
 * one of them is missing the run is skipped; under --strict or CI that is a failure, as is a case without
 * an expected PNG.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const expectedDir = join(here, 'expected');
const update = process.argv.includes('--update');
const strict = process.argv.includes('--strict') || !!process.env.CI;
const TOLERANCE = 40; // per channel, 0..255
const MAX_DIFFERING = 0.004; // fraction of pixels allowed over the tolerance

/** The faces the cases draw with: family, descriptors and where the file is on Debian and Ubuntu. */
const FONTS = [
  {
    family: 'Golden',
    weight: 700,
    style: 'normal' as const,
    path: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  },
  {
    family: 'Golden',
    weight: 400,
    style: 'normal' as const,
    path: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  },
  {
    family: 'Golden Serif',
    weight: 400,
    style: 'normal' as const,
    path: '/usr/share/fonts/truetype/freefont/FreeSerif.ttf',
  },
  {
    family: 'Golden CJK',
    weight: 400,
    style: 'normal' as const,
    path: '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
  },
];

/** A face as meta.json records it: what the expected PNGs were drawn with. */
type MetaFont = { family: string; weight: number; style: 'normal' | 'italic'; file: string; sha256: string };
type Meta = { fonts: MetaFont[] | string; chromium?: string };

/** Faces made before meta.json listed families: the two DejaVu files under 'Golden'. */
function metaFonts(meta: Meta): MetaFont[] {
  if (Array.isArray(meta.fonts)) return meta.fonts;
  return meta.fonts.split(',').map((file) => {
    const f = FONTS.find((x) => x.path.endsWith(`/${file}`));
    return { family: 'Golden', weight: f?.weight ?? 400, style: 'normal', file: f?.path ?? file, sha256: '' };
  });
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A skip: a failure under --strict, else a notice. */
function skip(why: string): number {
  if (strict) {
    console.error(`golden: FAILED, would skip: ${why}`);
    return 1;
  }
  console.log(`golden: skipped (${why})`);
  return 0;
}

/** esbuild is not a dependency of this package; vite (apps/output) depends on it, so resolve it through vite. */
async function loadEsbuild(): Promise<typeof import('esbuild')> {
  try {
    return await import('esbuild');
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    const vitePath = fromOutput.resolve('vite');
    const esbuildPath = createRequire(vitePath).resolve('esbuild');
    return (await import(esbuildPath)) as typeof import('esbuild');
  }
}

async function main(): Promise<number> {
  const metaPath = join(expectedDir, 'meta.json');
  const meta: Meta | null = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
  // The faces to load: on --update every face the cases use; else exactly the files meta.json lists, plus
  // faces added to FONTS since (new cases draw with them, and meta.json records them once they are written).
  const all: MetaFont[] = FONTS.map(({ path, ...f }) => ({ ...f, file: path, sha256: '' }));
  const recorded = update || !meta ? [] : metaFonts(meta);
  const same = (a: MetaFont, b: MetaFont) =>
    a.family === b.family && a.weight === b.weight && a.style === b.style;
  const wanted = [...recorded, ...all.filter((f) => !recorded.some((r) => same(r, f)))];
  const missing = wanted.filter((f) => !existsSync(f.file)).map((f) => f.file);
  if (missing.length)
    return skip(
      `${missing.join(', ')} not installed; apt install fonts-dejavu-core fonts-freefont-ttf fonts-ipafont-gothic`,
    );
  const fonts = wanted.map((f) => {
    const bytes = readFileSync(f.file);
    const hash = sha256(bytes);
    if (f.sha256 && f.sha256 !== hash)
      console.log(
        `golden: note: ${f.file} is not the file the expected PNGs were made with (sha-256 differs)`,
      );
    return { ...f, sha256: hash, base64: bytes.toString('base64') };
  });

  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  const script = built.outputFiles[0]!.text;

  const launch = async () => {
    try {
      return await chromium.launch({ headless: true });
    } catch {
      return await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
    }
  };
  const browser = await launch();
  let failures = 0;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: script });
    const loaded = await page.evaluate(
      (files) => window.__golden.fonts(files),
      fonts.map(({ family, weight, style, base64, sha256: hash }) => ({
        family,
        weight,
        style,
        base64,
        hash,
      })),
    );
    const fontList = fonts.map(
      (f) => `${f.family} ${f.weight}${f.style === 'italic' ? 'i' : ''} = ${basename(f.file)}`,
    );
    console.log(`golden: ${loaded} font faces loaded (${fontList.join(', ')}); ${await browser.version()}`);
    const names = await page.evaluate(() => window.__golden.names());
    const legacy = new Set(await page.evaluate(() => window.__golden.legacyNames()));
    if (!names.length) return skip('no cases');
    mkdirSync(expectedDir, { recursive: true });
    let created = 0;
    for (const name of names) {
      const png = await page.evaluate((n) => window.__golden.render(n), name);
      const file = join(expectedDir, `${name}.png`);
      if (update || !existsSync(file)) {
        writeFileSync(file, Buffer.from(png, 'base64'));
        console.log(`  ${name}: ${update ? 'updated' : 'created (no expected image yet)'}`);
        if (!update) {
          created++;
          if (strict) failures++;
        }
        continue;
      }
      const expected = readFileSync(file).toString('base64');
      const d = await page.evaluate(
        ([n, e, t]) => window.__golden.diff(n as string, e as string, t as number),
        [name, expected, TOLERANCE] as const,
      );
      const frac = d.differing / d.total;
      const ok = frac <= MAX_DIFFERING;
      if (!ok) {
        failures++;
        writeFileSync(join(expectedDir, `${name}.actual.png`), Buffer.from(png, 'base64'));
      }
      console.log(
        `  ${name}: ${ok ? 'ok' : 'MISMATCH'} (${d.differing} of ${d.total} pixels over ${TOLERANCE}, ${(frac * 100).toFixed(3)}%, max delta ${d.maxDelta})`,
      );
      // The legacy cases again, with the font resolver installed as every drawer now has it.
      if (!legacy.has(name)) continue;
      await page.evaluate((n) => window.__golden.render(n, 'resolver'), name);
      const r = await page.evaluate(
        ([n, e, t]) => window.__golden.diff(n as string, e as string, t as number),
        [name, expected, TOLERANCE] as const,
      );
      const rok = r.differing / r.total <= MAX_DIFFERING;
      if (!rok) failures++;
      console.log(
        `  ${name} (font resolver): ${rok ? 'ok' : 'MISMATCH'} (${r.differing} pixels over ${TOLERANCE}, max delta ${r.maxDelta})`,
      );
    }
    if (created && strict)
      console.error(`golden: ${created} case(s) had no expected PNG (written now; commit them)`);
    const inv = await page.evaluate(() => window.__golden.invariance());
    console.log(
      `golden: line-break invariance: ${inv.configs} rich text configurations (${inv.richLines} lines) drawn at ${inv.widths.join(', ')} px wide: ${inv.richDiffer.length ? `${inv.richDiffer.length} DIFFER` : 'identical'}; legacy drawText breaks differ in ${inv.legacyDiffer} of them`,
    );
    for (const d of inv.richDiffer) console.error(`  differs: ${d}`);
    if (inv.richDiffer.length || !inv.configs) failures++;
    if (update || !meta || created) {
      const record: MetaFont[] = fonts.map(({ family, weight, style, file, sha256: hash }) => ({
        family,
        weight,
        style,
        file,
        sha256: hash,
      }));
      writeFileSync(
        metaPath,
        `${JSON.stringify({ fonts: record, chromium: await browser.version(), tolerance: TOLERANCE, maxDifferingFraction: MAX_DIFFERING }, null, 2)}\n`,
      );
    }
  } finally {
    await browser.close();
  }
  if (failures)
    console.error(
      `golden: ${failures} case(s) differ; see expected/*.actual.png, or run with --update if intended`,
    );
  return failures ? 1 : 0;
}

declare global {
  interface Window {
    __golden: {
      names(): string[];
      legacyNames(): string[];
      fonts(
        files: { family: string; weight: number; style: 'normal' | 'italic'; base64: string; hash: string }[],
      ): Promise<number>;
      render(name: string, env?: 'legacy' | 'resolver'): Promise<string>;
      invariance(): {
        configs: number;
        widths: number[];
        richDiffer: string[];
        legacyDiffer: number;
        richLines: number;
      };
      diff(
        name: string,
        expectedBase64: string,
        tolerance: number,
      ): Promise<{ differing: number; total: number; maxDelta: number }>;
    };
  }
}

process.exit(await main());
