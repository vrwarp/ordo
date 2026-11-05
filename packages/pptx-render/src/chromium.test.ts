import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pptxgen from 'pptxgenjs';
import { afterAll, describe, expect, it } from 'vitest';
import { renderWithPptxPreview } from './chromium.ts';

/** A Chromium to drive: ORDO_TEST_CHROMIUM, else Playwright's when it is installed. */
async function findChromium(): Promise<string | undefined> {
  if (process.env.ORDO_TEST_CHROMIUM) return process.env.ORDO_TEST_CHROMIUM;
  try {
    const { chromium } = await import('@playwright/test');
    const exe = chromium.executablePath();
    return existsSync(exe) ? exe : undefined;
  } catch {
    return undefined;
  }
}

const chromium = await findChromium();
const dirs: string[] = [];
afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

async function work(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'ordo-pptx-render-'));
  dirs.push(d);
  return d;
}

function pngSize(b: Buffer): [number, number] {
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe.skipIf(!chromium)('renderWithPptxPreview (headless Chromium)', () => {
  async function deck(slides: number): Promise<string> {
    const p = new pptxgen();
    p.layout = 'LAYOUT_16x9';
    const s1 = p.addSlide();
    s1.background = { color: '1F2937' };
    s1.addText(
      [
        { text: '18', options: { superscript: true } },
        { text: ' Now when Jesus saw great multitudes', options: {} },
      ],
      { x: 0.5, y: 0.5, w: 9, h: 1.5, fontFace: 'Tahoma', fontSize: 32, color: 'FFFFFF' },
    );
    for (let i = 2; i <= slides; i++)
      p.addSlide().addText(`Slide ${i}`, { x: 1, y: 1, w: 8, h: 1, fontSize: 40, color: '000000' });
    const dir = await work();
    const input = join(dir, 'in.pptx');
    await writeFile(input, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
    return input;
  }

  it('draws every slide at 1920x1080, repairing what pptx-preview cannot open', async () => {
    const input = await deck(2);
    const dir = await work();
    const fixed = await renderWithPptxPreview(input, join(dir, 'fixed'), {
      chromium: chromium!,
      timeoutMs: 60_000,
    });
    expect(fixed.pages).toHaveLength(2);
    expect(fixed.styled).toBeGreaterThanOrEqual(3);
    expect(fixed.notes.join('\n')).toMatch(/Content_Types.*removed/);
    for (const page of fixed.pages) expect(pngSize(await readFile(page))).toEqual([1920, 1080]);
    // pptxgenjs lists a slide master per slide: unrepaired, pptx-preview draws nothing.
    await expect(
      renderWithPptxPreview(input, join(dir, 'raw'), {
        chromium: chromium!,
        timeoutMs: 60_000,
        fixes: false,
      }),
    ).rejects.toThrow(/no slides/);
  }, 120_000);

  it('restyles the runs it marked (fonts, raised verse numbers)', async () => {
    const input = await deck(1);
    const dir = await work();
    const fixed = await renderWithPptxPreview(input, join(dir, 'fixed'), {
      chromium: chromium!,
      timeoutMs: 60_000,
    });
    const raw = await renderWithPptxPreview(input, join(dir, 'raw'), {
      chromium: chromium!,
      timeoutMs: 60_000,
      fixes: false,
    });
    expect(fixed.pages).toHaveLength(1);
    expect(raw.pages).toHaveLength(1);
    expect(raw.styled).toBe(0);
    expect(fixed.styled).toBe(2);
    expect((await readFile(fixed.pages[0]!)).equals(await readFile(raw.pages[0]!))).toBe(false);
  }, 120_000);

  it('reports a missing browser and a deck pptx-preview cannot read', async () => {
    const dir = await work();
    const input = join(dir, 'bad.pptx');
    await writeFile(input, 'not a zip');
    await expect(
      renderWithPptxPreview(input, join(dir, 'x'), {
        chromium: join(dir, 'no-such-chromium'),
        timeoutMs: 20_000,
        fixes: false,
      }),
    ).rejects.toThrow(/Chromium not found/);
    await expect(
      renderWithPptxPreview(input, join(dir, 'y'), { chromium: chromium!, timeoutMs: 30_000, fixes: false }),
    ).rejects.toThrow(/pptx-preview|no slides/);
  }, 60_000);
});
