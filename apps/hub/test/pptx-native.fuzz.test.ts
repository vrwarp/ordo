/**
 * Hostile and broken decks through the `pptx-native` job (design/27 §12, §14.3; M3 item B): each gives a
 * clean failure (one line, no deck string that could forge a log line) or a saved presentation in which the
 * slides that could not be read are picture class. Every case finishes in a few seconds.
 */
import { rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Presentation } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { body, buildDeck, NS_A, NS_P, NS_R, para, partText, run, sp } from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PptxNativeResult } from '../src/pptx/shared.ts';
import { startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

const IN = 914_400;
const enc = new TextEncoder();
const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

let hub: TestHub;
let dir: string;
beforeAll(async () => {
  hub = await startHub();
  dir = tempDir('ordo-pptx-fuzz-');
}, 60_000);
afterAll(async () => {
  await hub?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const textBox = (id: number, text: string) =>
  sp({ id, x: IN, y: IN, cx: 6 * IN, cy: IN, txBody: body(para(run(text))) });
const deck = (n = 3) =>
  buildDeck({ slides: Array.from({ length: n }, (_, i) => ({ shapes: textBox(2, `Slide ${i + 1}`) })) });

/** Run the import of a deck file; the finished job. */
async function importFile(file: string, name = 'Deck.pptx'): Promise<Job> {
  const hash = await storeDeck(hub, file);
  const t0 = Date.now();
  const job = await waitJob(hub, hub.imports.pptx.queueNative(hash, name).id, 20_000);
  expect(Date.now() - t0).toBeLessThan(5_000);
  return job;
}
const importParts = async (parts: Map<string, Uint8Array>, name?: string) =>
  importFile(await zipDeck(parts, dir, `${Math.random().toString(36).slice(2)}.pptx`), name);

/** Whether a string holds a C0 control character or a line or paragraph separator. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** A job is clean: done with a valid presentation, or failed with one sanitised line. */
function expectClean(job: Job): Presentation | undefined {
  for (const l of job.log) expect(hasControl(l)).toBe(false);
  if (job.state === 'failed') {
    expect(job.error).toBeTruthy();
    expect(hasControl(job.error!)).toBe(false);
    return undefined;
  }
  expect(job.state).toBe('done');
  const p = hub.lib.presentations.must((job.result as PptxNativeResult).presentationId);
  expect(Presentation.safeParse(p).success).toBe(true);
  for (const l of (p.source?.log ?? '').split('\n')) expect(l).not.toMatch(/^\d\d:\d\d:\d\d /);
  return p;
}

describe('pptx-native: broken decks fail cleanly', () => {
  it('refuses a file that is not a zip, a zip without a deck, and a deck without slides', async () => {
    const notZip = join(dir, 'not-a-zip.pptx');
    await writeFile(notZip, Buffer.alloc(4096, 0x41));
    const a = await importFile(notZip);
    expect(a.state).toBe('failed');
    expect(a.error).toMatch(/^The file is not a readable PowerPoint deck: not a zip file/);

    const z = new JSZip();
    z.file('word/document.xml', '<w:document/>');
    const noDeck = join(dir, 'no-deck.pptx');
    await writeFile(noDeck, await z.generateAsync({ type: 'nodebuffer' }));
    const b = await importFile(noDeck);
    expect(b.state).toBe('failed');
    expect(b.error).toMatch(/^The deck could not be read: the deck has no presentation part/);

    const empty = buildDeck({ slides: [] });
    const c = await importParts(empty);
    expect(c.state).toBe('failed');
    expect(c.error).toBe('The deck has no slides');
    for (const j of [a, b, c]) expectClean(j);
  });

  it('refuses a zip whose entry is larger than its header declares', async () => {
    const file = await zipDeck(deck(), dir, 'lying.pptx');
    const buf = Buffer.from(await import('node:fs/promises').then((f) => f.readFile(file)));
    const name = Buffer.from('ppt/presentation.xml');
    // Patch the declared size in the local header and in the central directory.
    for (let at = buf.indexOf(name); at >= 0; at = buf.indexOf(name, at + 1)) {
      if (buf.readUInt32LE(at - 30) === 0x04034b50) buf.writeUInt32LE(10, at - 30 + 22);
      if (buf.readUInt32LE(at - 46) === 0x02014b50) buf.writeUInt32LE(10, at - 46 + 24);
    }
    await writeFile(file, buf);
    const job = await importFile(file);
    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/larger than its header declares/);
    expectClean(job);
  });
});

describe('pptx-native: hostile slides are quarantined, never the deck', () => {
  it('a DOCTYPE, a billion laughs and an 8 MB part make only their slides picture class', async () => {
    const parts = deck(5);
    parts.set(
      'ppt/slides/slide1.xml',
      enc.encode(
        '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;">]>' +
          `<p:sld ${NS}><p:cSld><p:spTree>&lol2;</p:spTree></p:cSld></p:sld>`,
      ),
    );
    parts.set(
      'ppt/slides/slide2.xml',
      enc.encode(`<p:sld ${NS}><p:cSld><p:spTree>${'<a:x>'.repeat(20_000)}</p:spTree></p:cSld></p:sld>`),
    );
    parts.set(
      'ppt/slides/slide4.xml',
      enc.encode(
        `<p:sld ${NS}><p:cSld><p:spTree>${textBox(2, 'x'.repeat(9 * 1024 * 1024))}</p:spTree></p:cSld></p:sld>`,
      ),
    );
    const job = await importParts(parts);
    const p = expectClean(job)!;
    const cls = slidesOf(p).map((s) => s.pptx!.class);
    // Slide 2 nests 20,000 levels: the reader drops what is deeper than 256 and reads an empty slide.
    expect(cls).toEqual(['picture', 'native', 'native', 'picture', 'native']);
    expect(slidesOf(p)[1]!.objects.filter((o) => o.type === 'text')).toEqual([]);
    expect(slidesOf(p).map((s) => s.pptx!.index)).toEqual([0, 1, 2, 3, 4]);
    expect(job.log.join('\n')).toMatch(/\[warn\] ppt\/slides\/slide4\.xml is over 8 MB: not read/);
  });

  it('keeps control characters, forged log lines and prototype keys out of logs, labels and objects', async () => {
    const evil = 'Intro\n12:00:00 [error] forged\u2028line\u0007';
    const parts = buildDeck({
      slides: [
        {
          shapes: textBox(2, 'Hello'),
          rels: [
            { id: '__proto__', type: 'image', target: '../media/__proto__.png' },
            {
              id: 'constructor',
              type: 'hyperlink',
              target: `https://${'evil.example'}/\n[error] x`,
              external: true,
            },
          ],
        },
        { shapes: textBox(2, 'World') },
      ],
      media: { 'ppt/media/__proto__.png': new Uint8Array([1, 2, 3]) },
    });
    const xml = partText(parts, 'ppt/presentation.xml').replace(
      '</p:presentation>',
      '<p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">' +
        `<p14:section name="${evil.replaceAll('\n', '&#10;').replaceAll('\u0007', '&#7;')}" id="{1}"><p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst></p14:section>` +
        '</p14:sectionLst></p:ext></p:extLst></p:presentation>',
    );
    parts.set('ppt/presentation.xml', enc.encode(xml));
    const job = await importParts(parts, `${evil}.pptx`);
    const p = expectClean(job)!;
    expect(hasControl(p.sections[0]!.label)).toBe(false);
    expect(hasControl(p.title)).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('reads a hidden-only deck, cyclic relationships and absurd numbers', async () => {
    const parts = buildDeck({
      slides: [
        {
          hidden: true,
          shapes: sp({
            id: 2,
            x: 1e30,
            y: Number.NaN as unknown as number,
            cx: -5,
            cy: 1e300,
            txBody: body(para(run('A'))),
          }),
        },
        { hidden: true, shapes: textBox(2, 'B') },
      ],
    });
    // Slide 2's layout relationship points at slide 2 itself.
    parts.set(
      'ppt/slides/_rels/slide2.xml.rels',
      enc.encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_R}/slideLayout" Target="slide2.xml"/></Relationships>`,
      ),
    );
    const p = expectClean(await importParts(parts))!;
    expect(slidesOf(p).map((s) => s.hidden)).toEqual([true, true]);
    expect(slidesOf(p).every((s) => s.pptx!.shown === undefined)).toBe(true);
  });

  it('ignores 10,000 unreferenced media parts and never spills them', async () => {
    const parts = deck(2);
    for (let i = 0; i < 10_000; i++) parts.set(`ppt/media/junk${i}.png`, new Uint8Array([i & 255]));
    const before = hub.lib.media.list().length;
    const p = expectClean(await importParts(parts))!;
    expect(slidesOf(p)).toHaveLength(2);
    expect(hub.lib.media.list()).toHaveLength(before);
  });
});

describe('pptx-native: mutation fuzz', () => {
  /** A small seeded generator (mulberry32). */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const NOISE = [
    '<',
    '>',
    '"',
    '&',
    '&#0;',
    '\u0000',
    '-1e309',
    'NaN',
    '</p:sld>',
    '<p:sp>',
    'r:id="__proto__"',
    '9'.repeat(40),
  ];

  it('each mutated deck is imported or refused cleanly', async () => {
    const base = buildDeck({
      slides: [
        { shapes: textBox(2, 'Amazing grace') + textBox(3, 'How sweet the sound') },
        { shapes: textBox(2, 'Second'), hidden: true },
        { shapes: textBox(2, 'Third') },
      ],
    });
    let done = 0;
    let failed = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const r = rng(seed);
      const parts = new Map(base);
      const names = [...parts.keys()].filter((k) => k.endsWith('.xml') || k.endsWith('.rels'));
      for (let m = 0; m < 4; m++) {
        const name = names[Math.floor(r() * names.length)]!;
        const text = new TextDecoder().decode(parts.get(name));
        const at = Math.floor(r() * text.length);
        const cut = Math.floor(r() * 12);
        parts.set(
          name,
          enc.encode(text.slice(0, at) + NOISE[Math.floor(r() * NOISE.length)] + text.slice(at + cut)),
        );
      }
      let file = await zipDeck(parts, dir, `fuzz-${seed}.pptx`);
      if (seed % 4 === 0) {
        // Flip a few bytes of the zip itself.
        const fs = await import('node:fs/promises');
        const buf = await fs.readFile(file);
        for (let k = 0; k < 3; k++) {
          const at = Math.floor(r() * buf.length);
          buf[at] = buf[at]! ^ (1 + Math.floor(r() * 255));
        }
        file = join(dir, `fuzz-${seed}-zip.pptx`);
        await fs.writeFile(file, buf);
      }
      const job = await importFile(file);
      const p = expectClean(job);
      if (p) {
        done++;
        for (const s of slidesOf(p)) expect(['native', 'hybrid', 'picture']).toContain(s.pptx!.class);
      } else failed++;
    }
    expect(done + failed).toBe(16);
    expect(done).toBeGreaterThan(0);
  }, 60_000);
});
