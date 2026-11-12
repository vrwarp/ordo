import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GeomFile, Slide } from '@ordo/domain';
import { type Browser, chromium } from '@playwright/test';
import type { PageFont, PageMedia, Pro7RenderPage } from './render-page.ts';

declare global {
  interface Window {
    __pro7: Pro7RenderPage;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const ORIGIN = 'https://ordo-pro7.invalid';

type Esbuild = {
  build(o: Record<string, unknown>): Promise<{ outputFiles: { text: string }[] }>;
};

async function loadEsbuild(): Promise<Esbuild> {
  let path: string;
  try {
    path = createRequire(import.meta.url).resolve('esbuild');
  } catch {
    const fromOutput = createRequire(join(root, 'apps/output/package.json'));
    path = createRequire(fromOutput.resolve('vite')).resolve('esbuild');
  }
  const mod = (await import(pathToFileURL(path).href)) as Esbuild & { default?: Esbuild };
  return typeof mod.build === 'function' ? mod : mod.default!;
}

async function bundleRenderPage(): Promise<string> {
  const esbuild = await loadEsbuild();
  const built = await esbuild.build({
    entryPoints: [join(here, 'render-page.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    absWorkingDir: root,
    logLevel: 'silent',
  });
  return built.outputFiles[0]!.text;
}

function collectFontFamilies(slides: readonly Slide[]): Set<string> {
  const families = new Set<string>();
  for (const s of slides) {
    for (const obj of s.objects) {
      if (obj.type === 'text') {
        if (obj.style?.fontFamily) families.add(obj.style.fontFamily);
        if (obj.style?.fallbackFonts) {
          for (const f of obj.style.fallbackFonts) families.add(f);
        }
      }
    }
  }
  return families;
}

export type RenderedSlidePng = {
  png: Buffer;
  ms1920: number;
  missing: string[];
};

export class Pro7HeadlessRenderer {
  private readonly browser: Browser;
  private readonly script: string;
  private readonly fontBuffers = new Map<string, Buffer>();

  private constructor(browser: Browser, script: string) {
    this.browser = browser;
    this.script = script;
  }

  static async open(): Promise<Pro7HeadlessRenderer> {
    const script = await bundleRenderPage();
    const args = [
      '--disable-gpu',
      '--force-color-profile=srgb',
      '--mute-audio',
      '--hide-scrollbars',
      '--host-resolver-rules=MAP * ~NOTFOUND',
    ];
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: true, args });
    } catch {
      browser = await chromium.launch({
        headless: true,
        executablePath: '/usr/bin/google-chrome',
        args,
      });
    }
    return new Pro7HeadlessRenderer(browser, script);
  }

  private resolveLinuxFonts(families: ReadonlySet<string>): PageFont[] {
    if (process.platform !== 'linux') return [];
    const fonts: PageFont[] = [];
    for (const family of families) {
      const name = family.trim();
      if (!name || name.length > 300) continue;
      try {
        const escaped = name.replace(/[\\\-:,]/g, (c) => `\\${c}`);
        const r = spawnSync('fc-match', ['-f', '%{file}\t%{index}', escaped], {
          encoding: 'utf8',
          timeout: 5000,
        });
        if (r.status !== 0 || !r.stdout) continue;
        const [file, idxStr] = r.stdout.split('\t');
        const index = Number(idxStr) || 0;
        if (!file || index !== 0) continue;
        if (!/\.(ttf|otf)$/i.test(file)) continue;
        if (!existsSync(file)) continue;

        const buf = readFileSync(file);
        const hash = createHash('sha256').update(buf).digest('hex');
        if (!this.fontBuffers.has(hash)) {
          this.fontBuffers.set(hash, buf);
        }
        fonts.push({
          family: name,
          weight: 400,
          style: 'normal',
          hash,
          url: `${ORIGIN}/font/${hash}`,
        });
      } catch {
        // Font resolution fallback
      }
    }
    return fonts;
  }

  async renderDeck(opts: {
    slides: Slide[];
    presentationBackgroundMediaId?: string;
    mediaFiles: Map<string, string>;
    geoms?: { id: string; file: GeomFile }[];
    onlySlides?: ReadonlySet<number>;
  }): Promise<Map<number, RenderedSlidePng>> {
    const page = await this.browser.newPage({ viewport: { width: 1920, height: 1080 } });

    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) return route.abort();

      if (url.pathname === '/') {
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta charset="utf-8"><body><script src="/page.js"></script></body>',
        });
      }

      if (url.pathname === '/page.js') {
        return route.fulfill({
          contentType: 'application/javascript',
          body: this.script,
        });
      }

      if (url.pathname.startsWith('/font/')) {
        const hash = url.pathname.slice('/font/'.length);
        const buf = this.fontBuffers.get(hash);
        if (buf) {
          return route.fulfill({
            contentType: 'font/ttf',
            body: buf,
          });
        }
        return route.abort();
      }

      if (url.pathname.startsWith('/media/')) {
        const id = decodeURIComponent(url.pathname.slice('/media/'.length));
        const file = opts.mediaFiles.get(id);
        if (file && existsSync(file)) {
          try {
            const data = await readFile(file);
            const ext = extname(file).toLowerCase();
            const contentType =
              ext === '.png'
                ? 'image/png'
                : ext === '.jpg' || ext === '.jpeg'
                  ? 'image/jpeg'
                  : ext === '.webp'
                    ? 'image/webp'
                    : ext === '.gif'
                      ? 'image/gif'
                      : 'application/octet-stream';
            return route.fulfill({ contentType, body: data });
          } catch {
            return route.abort();
          }
        }
        return route.abort();
      }

      return route.abort();
    });

    await page.goto(`${ORIGIN}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window.__pro7 !== 'undefined');

    const families = collectFontFamilies(opts.slides);
    const linuxFonts = this.resolveLinuxFonts(families);
    if (linuxFonts.length > 0) {
      await page.evaluate((list) => window.__pro7.fonts(list), linuxFonts);
    }

    if (opts.geoms && opts.geoms.length > 0) {
      await page.evaluate((list) => window.__pro7.geoms(list), opts.geoms);
    }

    const mediaList: PageMedia[] = [];
    for (const [id] of opts.mediaFiles) {
      mediaList.push({
        id,
        url: `${ORIGIN}/media/${encodeURIComponent(id)}`,
        needW: 1920,
        needH: 1080,
      });
    }
    await page.evaluate((list) => window.__pro7.media(list), mediaList);

    const results = new Map<number, RenderedSlidePng>();
    for (let i = 0; i < opts.slides.length; i++) {
      const n = i + 1; // 1-based slide index
      if (opts.onlySlides && !opts.onlySlides.has(n)) continue;
      const slide = opts.slides[i]!;
      const res = await page.evaluate((job) => window.__pro7.render(job), {
        slide,
        presentationBackgroundMediaId: opts.presentationBackgroundMediaId,
        repeats: 0,
      });
      results.set(n, {
        png: Buffer.from(res.pngBase64, 'base64'),
        ms1920: res.ms1920,
        missing: res.missing,
      });
    }

    await page.close();
    return results;
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }
}
