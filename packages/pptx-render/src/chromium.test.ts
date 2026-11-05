import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pptxgen from 'pptxgenjs';
import { afterAll, describe, expect, it } from 'vitest';
import { annotatePptx } from './annotate.ts';
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

  it('takes the annotation from the caller when given one (the hub runs it on a worker)', async () => {
    const input = await deck(1);
    const dir = await work();
    let calls = 0;
    const fixed = await renderWithPptxPreview(input, join(dir, 'fixed'), {
      chromium: chromium!,
      timeoutMs: 60_000,
      annotate: (bytes, signal) => {
        calls++;
        return annotatePptx(bytes, { signal });
      },
    });
    expect(calls).toBe(1);
    expect(fixed.styled).toBe(2);
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

/**
 * A stand-in for Chromium: a script that answers the DevTools calls on the pipe (fd 3 in, fd 4 out) with
 * empty results, exits soon after answering the navigation (as a crashing browser would, before the page
 * loads), and leaves a file `launched` behind when it was started at all.
 */
async function fakeChromium(dir: string): Promise<string> {
  const exe = join(dir, 'fake-chromium');
  await writeFile(
    exe,
    `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
fs.writeFileSync(${JSON.stringify(join(dir, 'launched'))}, '');
// Sockets, not fs streams: a blocking read on the pipe would keep process.exit from finishing.
const out = new net.Socket({ fd: 4, readable: false, writable: true });
let buf = '';
new net.Socket({ fd: 3, readable: true, writable: false }).on('data', (d) => {
  buf += d.toString('utf8');
  for (let i = buf.indexOf('\\0'); i >= 0; i = buf.indexOf('\\0')) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const result =
      m.method === 'Target.createTarget' ? { targetId: 't' } :
      m.method === 'Target.attachToTarget' ? { sessionId: 's' } : {};
    out.write(JSON.stringify({ id: m.id, result }) + '\\0');
    if (m.method === 'Page.navigate') setTimeout(() => process.exit(3), 50);
    if (m.method === 'Browser.close') process.exit(0);
  }
});
`,
    { mode: 0o755 },
  );
  return exe;
}

describe('renderWithPptxPreview (a stand-in browser)', () => {
  it('fails instead of waiting forever when Chromium dies between the navigation and the page load', async () => {
    const dir = await work();
    const input = join(dir, 'in.pptx');
    await writeFile(input, 'not a deck');
    await expect(
      renderWithPptxPreview(input, join(dir, 'w'), {
        chromium: await fakeChromium(dir),
        timeoutMs: 60_000,
        fixes: false,
      }),
    ).rejects.toThrow(/Chromium exited \(3\)/);
    expect(existsSync(join(dir, 'launched'))).toBe(true);
  }, 20_000);

  it('times the whole render from the call and starts no browser once cancelled or out of time', async () => {
    const dir = await work();
    const input = join(dir, 'in.pptx');
    await writeFile(input, 'not a deck');
    const chromium = await fakeChromium(dir);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      renderWithPptxPreview(input, join(dir, 'a'), { chromium, timeoutMs: 60_000, signal: ctrl.signal }),
    ).rejects.toThrow('cancelled');
    // An annotation that never finishes: the deadline counts it, and tells it to stop.
    let told: AbortSignal | undefined;
    const t = performance.now();
    await expect(
      renderWithPptxPreview(input, join(dir, 'b'), {
        chromium,
        timeoutMs: 300,
        annotate: (_bytes, signal) => {
          told = signal;
          return new Promise(() => {});
        },
      }),
    ).rejects.toThrow(/timed out after/);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(told?.aborted).toBe(true);
    expect(existsSync(join(dir, 'launched'))).toBe(false);
  }, 20_000);
});
