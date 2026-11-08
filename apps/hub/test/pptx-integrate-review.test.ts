/**
 * The M3 wave 1 integration review (apps/hub/src/pptx/README.md "Review fixes"): LibreOffice never sees a deck
 * as uploaded, deck reads write only referenced pictures, a picture keeps no padding, reference requests do
 * not stack, the LibreOffice follow-up retries a failed run and reports what it could not draw, a version-1
 * draft saved over version 2 gets its art back, version 1 and its follow-up are written together, an edited
 * hybrid slide loses only the objects the art really replaces, and CJK faces a congregation picked reach
 * its outputs. The LibreOffice cases need soffice, pdftoppm and ffmpeg (skipped without them).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_THEME,
  type Font,
  type ImageObject,
  newId,
  type Presentation,
  type Slide,
  type SlideObject,
} from '@ordo/domain';
import { digestOf } from '@ordo/pptx-scene/emit.ts';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  imageRel,
  para,
  pic,
  run,
  sp,
  withPart,
} from '@ordo/pptx-scene/test-util.ts';
import type { Job } from '@ordo/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loStatus } from '../../operator/src/lib/pptxImport.ts';
import { outputFonts } from '../src/fonts/bundled.ts';
import type { JobCtx, JobQueue } from '../src/jobs.ts';
import { readDeckXml } from '../src/pptx/deckParts.ts';
import { extractDeck, patchSlide } from '../src/pptx/fallback.ts';
import { nativeJob } from '../src/pptx/nativeJob.ts';
import { addReadyPicture, PICTURE_LIMITS, plausibleBytes } from '../src/pptx/pictures.ts';
import type {
  PptxDeps,
  PptxLoPayload,
  PptxLoSlide,
  PptxNativePayload,
  PptxNativeResult,
  PptxReferencePayload,
} from '../src/pptx/shared.ts';
import { ffmpeg } from './fixtures.ts';
import { EDIT_PIN, login, startHub, type TestHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

function has(tool: string, flag: string): boolean {
  try {
    execFileSync(tool, [flag], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}
const tools = has('soffice', '--version') && has('pdftoppm', '-v') && has('ffmpeg', '-version');

const IN = 914_400;
let hub: TestHub;
let dir: string;

beforeAll(async () => {
  hub = await startHub();
  dir = tempDir('ordo-pptx-review-');
});
afterAll(async () => {
  await hub?.cleanup();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const textBox = (id: number, text: string, y = 0) =>
  sp({ id, x: IN, y: IN + y, cx: 8 * IN, cy: IN, txBody: body(para(run(text, 'sz="2000"'))) });
/** A slide too large for one native slide (§3.4: 64 KB): picture class. */
const pictureSlide = () => {
  const big = 'x'.repeat(19_000);
  return {
    shapes: textBox(2, big) + textBox(3, big, IN) + textBox(5, big, 2 * IN) + textBox(6, big, 3 * IN),
  };
};
const chartSlide = (text = 'Giving') => ({
  shapes:
    textBox(2, text) +
    chartFrame({ id: 4, x: 2 * IN, y: 2 * IN, cx: 6 * IN, cy: 3 * IN, rId: 'rId3' }) +
    sp({ id: 7, x: 9 * IN, y: 2 * IN, cx: IN, cy: IN }),
  rels: [{ id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
});
const withChart = (parts: Map<string, Uint8Array>) =>
  withPart(parts, 'ppt/charts/chart1.xml', chartXml([3, 5, 2], 'C00000'), CHART_CONTENT_TYPE);

async function stored(parts: Map<string, Uint8Array>): Promise<string> {
  return storeDeck(hub, await zipDeck(parts, dir, `${newId()}.pptx`));
}

async function importDeck(parts: Map<string, Uint8Array>, name = 'Deck.pptx') {
  const hash = await stored(parts);
  const job = await waitJob(hub, hub.imports.pptx.queueNative(hash, name, {}).id, 120_000);
  if (job.state !== 'done') throw new Error(`import failed: ${job.error}\n${job.log.join('\n')}`);
  const result = job.result as PptxNativeResult;
  return { hash, result, p: hub.lib.presentations.must(result.presentationId) };
}

/** Hold every follow-up as if its presentation were live (it defers itself) until `release`. */
function holdFollowUps(): { release(): void } {
  const deps = hub.imports.pptx.deps as { locked: PptxDeps['locked'] };
  const real = deps.locked;
  deps.locked = () => true;
  return {
    release() {
      deps.locked = real;
    },
  };
}

async function waitDeferred(id: string): Promise<void> {
  const t0 = Date.now();
  while (!hub.jobs.deferred().some((d) => d.id === id)) {
    const j = hub.jobs.get(id);
    if (j.state === 'done' || j.state === 'failed') throw new Error(`job ${id} ended: ${j.state} ${j.error}`);
    if (Date.now() - t0 > 120_000) throw new Error(`job ${id} not deferred: ${j.state}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A zip whose two central entries share one local header and its data. */
function overlappingZip(): Uint8Array {
  const data = new TextEncoder().encode('<x/>');
  const name = (s: string) => new TextEncoder().encode(s);
  const crc = (() => {
    let c = 0xffffffff;
    for (const b of data) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ 0xffffffff) >>> 0;
  })();
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  const a = name('ppt/a.xml');
  local.writeUInt16LE(a.length, 26);
  const head = Buffer.concat([local, a, data]);
  const central = (n: Uint8Array) => {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(0, 42);
    return Buffer.concat([c, n]);
  };
  const cd = Buffer.concat([central(a), central(name('ppt/b.xml'))]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(head.length, 16);
  return Buffer.concat([head, cd, end]);
}

describe("the 'Pictures (LibreOffice)' import fails closed (design/21, design/27 §5)", () => {
  it('fails the job, and never starts soffice, when the render copy cannot be built', async () => {
    // A soffice that only records it ran, first on the PATH.
    const bin = join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const marker = join(dir, 'soffice-ran');
    writeFileSync(join(bin, 'soffice'), `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
    chmodSync(join(bin, 'soffice'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      // One ordinary slide, plus 67.5 MB of unreferenced XML: more than a copy may hold in memory.
      const parts = buildDeck({ slides: [{ shapes: textBox(2, 'Welcome') }] });
      for (let i = 0; i < 9; i++) parts.set(`ppt/junk/part${i}.xml`, new Uint8Array(7_500_000).fill(0x61));
      const hash = await stored(parts);
      const job = await waitJob(hub, hub.imports.queueDocument(hash, 'Big.pptx', 'pptx', 'libreoffice').id);
      expect(job.state).toBe('failed');
      expect(job.error).toMatch(/could not be prepared for LibreOffice, so the deck was not converted/);
      expect(job.log.some((l) => /converting with LibreOffice/.test(l))).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = path;
    }
  }, 120_000);

  it('keeps a deck-made error on one line of the job log', async () => {
    const parts = buildDeck({ slides: [{ shapes: textBox(2, 'Welcome') }] });
    parts.set('ppt/../x\n12:00:00 [error] the hub database is corrupt; call', new Uint8Array([1]));
    const hash = await stored(parts);
    const job = await waitJob(hub, hub.imports.queueDocument(hash, 'Forged.pptx', 'pptx', 'libreoffice').id);
    expect(job.state).toBe('failed');
    expect(job.error).not.toMatch(/\n/);
    for (const line of job.log) expect(line).not.toMatch(/\n/);
    expect(job.log.some((l) => l.startsWith('12:00:00 [error]'))).toBe(false);
  });
});

describe('deck reads write only what is used (design/27 §12)', () => {
  it('reads XML into memory and writes nothing else; refuses overlapping entries', async () => {
    const parts = buildDeck({
      slides: [
        {
          shapes: pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }),
          rels: [imageRel('rId2', 'a.png')],
        },
      ],
    });
    parts.set('ppt/media/junk.bin', new Uint8Array(30 * 1024 * 1024));
    const file = await zipDeck(parts, dir, 'junk.pptx');
    const out = join(dir, 'xml-only');
    mkdirSync(out);
    const xml = await readDeckXml(file, out, new AbortController().signal);
    expect(xml.parts.get('ppt/media/junk.bin')?.byteLength).toBe(0);
    expect(xml.parts.get('ppt/media/a.png')?.byteLength).toBe(0);
    expect(xml.parts.get('ppt/slides/slide1.xml')!.byteLength).toBeGreaterThan(0);
    expect(readdirSync(out)).toEqual([]);

    const bad = join(dir, 'overlap.pptx');
    writeFileSync(bad, overlappingZip());
    await expect(readDeckXml(bad, out, new AbortController().signal)).rejects.toThrow(/overlap/);
  });

  it('spills only the pictures a render copy keeps', async () => {
    const parts = buildDeck({
      slides: [
        {
          shapes: pic({ id: 2, x: 0, y: 0, cx: IN, cy: IN, rId: 'rId2' }),
          rels: [imageRel('rId2', 'used.png')],
        },
      ],
    });
    for (let i = 0; i < 3; i++) parts.set(`ppt/media/unused${i}.png`, new Uint8Array(10 * 1024 * 1024));
    const file = await zipDeck(parts, dir, 'spill.pptx');
    const out = join(dir, 'spill');
    const deck = await extractDeck(file, out, new AbortController().signal, {
      pages: [{ index: 0, mode: 'whole' }],
    });
    expect(deck.media.map(([part]) => part)).toEqual(['ppt/media/used.png']);
    expect(readdirSync(out)).toHaveLength(1);
    expect(deck.over).toBe(0);
  });
});

describe('pictures keep no padding (design/27 §4)', () => {
  it('re-encodes a picture with data after its image, and refuses to store one ready', async () => {
    const png = readFileSync(
      ffmpeg(dir, 'red.png', ['-f', 'lavfi', '-i', 'color=c=red:s=64x64', '-frames:v', '1']),
    );
    const padded = new Uint8Array(png.length + 2 * 1024 * 1024);
    padded.set(png);
    expect(padded.length).toBeGreaterThan(plausibleBytes(64, 64));
    const { p } = await importDeck(
      buildDeck({
        slides: [
          {
            shapes: pic({ id: 2, x: 0, y: 0, cx: 4 * IN, cy: 4 * IN, rId: 'rId2' }),
            rels: [imageRel('rId2', 'padded.png')],
          },
        ],
        media: { 'ppt/media/padded.png': padded },
      }),
    );
    const img = slidesOf(p)[0]!.objects.find((o): o is ImageObject => o.type === 'image')!;
    const m = hub.lib.media.must(img.mediaId);
    expect(m).toMatchObject({ width: 64, height: 64, state: 'ready' });
    expect(m.original.bytes).toBeLessThanOrEqual(plausibleBytes(64, 64));

    const file = join(dir, 'padded-ready.png');
    writeFileSync(file, padded);
    await expect(
      addReadyPicture(
        hub.imports.pptx.deps,
        {
          path: file,
          ext: 'png',
          mime: 'image/png',
          width: 64,
          height: 64,
          hasAlpha: false,
          sourceHash: 'a'.repeat(64),
          notes: [],
        },
        { name: 'padded', tags: ['pptx'] },
      ),
    ).rejects.toThrow(/more bytes than a 64x64 picture holds/);
    expect(PICTURE_LIMITS.maxBytes).toBe(64 * 1024 * 1024);
  });
});

describe("'Show PowerPoint picture' requests do not stack", () => {
  it('joins the waiting job and merges the slides it switches', async () => {
    const { hash, p } = await importDeck(buildDeck({ slides: [{ shapes: textBox(2, 'One') }] }));
    const hold = holdFollowUps();
    try {
      const first = hub.imports.pptx.queueReference(p.id, hash, 'edit@1', []);
      await waitDeferred(first.id);
      const again = hub.imports.pptx.queueReference(p.id, hash, 'edit@1', ['s1']);
      expect(again.id).toBe(first.id);
      const payload = () =>
        JSON.parse(
          (hub.lib.db.prepare('SELECT payload FROM jobs WHERE id = ?').get(first.id) as { payload: string })
            .payload,
        ) as PptxReferencePayload;
      expect(payload().showPicture).toEqual(['s1']);
      expect(hub.imports.pptx.queueReference(p.id, hash).id).toBe(first.id);
      expect(payload().showPicture).toBeUndefined();
      const waiting = hub.lib.db
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE kind = 'pptx-reference' AND state IN ('queued', 'running')`,
        )
        .get() as { n: number };
      expect(waiting.n).toBe(1);
    } finally {
      hold.release();
    }
    // Another presentation gets its own.
    const other = await importDeck(buildDeck({ slides: [{ shapes: textBox(2, 'Two') }] }));
    const h2 = holdFollowUps();
    try {
      const j = hub.imports.pptx.queueReference(other.p.id, other.hash);
      expect(j.id).not.toBe(hub.imports.pptx.queueReference(p.id, hash).id);
    } finally {
      // Not drawn: these requests only had to be counted.
      hub.lib.db.prepare(`DELETE FROM jobs WHERE kind = 'pptx-reference' AND state = 'queued'`).run();
      h2.release();
      hub.jobs.undefer();
      await hub.jobs.idle();
    }
  }, 180_000);
});

describe('version 1 and its follow-up are written together', () => {
  it('saves nothing when the follow-up cannot be queued', async () => {
    const hash = await stored(withChart(buildDeck({ slides: [chartSlide()] })));
    const jobs = {
      enqueue: () => {
        throw new Error('the queue is gone');
      },
    } as unknown as JobQueue;
    const deps = { ...hub.imports.pptx.deps, jobs };
    const ctx: JobCtx<PptxNativePayload> = {
      id: 'direct',
      payload: { hash, name: 'Atomic.pptx' },
      signal: new AbortController().signal,
      log: () => {},
      progress: () => {},
      setPayload: (pl) => {
        ctx.payload = pl;
      },
    };
    await expect(nativeJob(deps)(ctx)).rejects.toThrow(/the queue is gone/);
    const id = ctx.payload.done?.presentationId;
    expect(id).toBeDefined();
    expect(hub.lib.presentations.get(id!)).toBeUndefined();
  });
});

describe('an edited hybrid slide gets its art (pure)', () => {
  const style = DEFAULT_THEME.textBoxDefaults;
  const box = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };
  const text = (id: string, t: string): SlideObject => ({
    id,
    type: 'text',
    box,
    text: t,
    style,
    opacity: 1,
  });
  it('replaces only the objects still as version 1 wrote them, in the art place', () => {
    const v1 = [
      text('t', 'Title'),
      text('n1', 'Inside the chart'),
      text('n2', 'Legend'),
      text('top', 'Over'),
    ];
    const lo: PptxLoSlide = {
      slideId: 's',
      index: 0,
      class: 'hybrid',
      digest: digestOf(v1),
      art: { elements: [], box, at: 1, replaces: ['n1', 'n2'], before: 'top', text: '' },
      replaced: [
        ['n1', digestOf([v1[1]!])],
        ['n2', digestOf([v1[2]!])],
      ],
    };
    const slide: Slide = {
      id: 's',
      objects: [text('t', 'Title, fixed'), v1[1]!, text('n2', 'Legend, edited'), v1[3]!],
      pptx: {
        fileId: 'f'.repeat(64),
        index: 0,
        class: 'hybrid',
        version: 1,
        pending: true,
        digest: lo.digest,
      },
    };
    const out = patchSlide(slide, lo, { art: { mediaId: 'art', box }, failed: [] }, 'f'.repeat(64));
    expect(out.objects.map((o) => (o.type === 'image' ? 'ART' : o.id))).toEqual(['t', 'n2', 'ART', 'top']);
    expect(out.pptx!.pending).toBeUndefined();
    expect(out.pptx!.failed).toBeUndefined();
    expect(out.pptx!.notes).toEqual([
      'edited since the import: the PowerPoint art still shows 1 edited or deleted object(s) as they were',
    ]);
    // What LibreOffice could not do is reported, and the slide marked.
    const failed = patchSlide(slide, lo, { failed: ['LibreOffice could not draw the art'] }, 'f'.repeat(64));
    expect(failed.pptx).toMatchObject({ failed: true });
    expect(failed.pptx!.pending).toBeUndefined();
  });
});

describe('CJK faces a congregation picked reach its outputs', () => {
  const font = (family: string): Font =>
    ({
      id: newId(),
      family,
      weight: 400,
      style: 'normal',
      source: 'google',
      file: { hash: 'h', bytes: 1, mime: 'font/woff2', path: 'p' },
    }) as Font;
  it('keeps a CJK family a theme or presentation names', () => {
    const fonts = [font('Noto Sans KR'), font('Noto Sans JP'), font('Inter')];
    expect(outputFonts(fonts, []).map((f) => f.family)).toEqual(['Inter']);
    const theme = {
      ...DEFAULT_THEME,
      id: newId(),
      name: 'Korean',
      text: { ...DEFAULT_THEME.text, fontFamily: 'Noto Sans KR' },
    };
    hub.lib.themes.insert(theme);
    expect(hub.lib.namesFontFamily('Noto Sans KR')).toBe(true);
    expect(hub.lib.namesFontFamily('noto sans kr')).toBe(true);
    expect(hub.lib.namesFontFamily('Noto Sans JP')).toBe(false);
    expect(outputFonts(fonts, [], (f) => hub.lib.namesFontFamily(f)).map((f) => f.family)).toEqual([
      'Noto Sans KR',
      'Inter',
    ]);
  });
});

describe.skipIf(!tools)('the LibreOffice follow-up when LibreOffice fails (design/27 §5)', () => {
  const timeouts = () => hub.imports.pptx.deps.cfg.timeouts;
  it('tries a failed run again later, then marks the slides it could not draw', async () => {
    const real = timeouts().soffice;
    timeouts().soffice = 1;
    try {
      const { result } = await importDeck(withChart(buildDeck({ slides: [chartSlide(), pictureSlide()] })));
      expect(result).toMatchObject({ hybrid: 1, picture: 1, pending: 2 });
      for (let i = 0; i < 2; i++) {
        await waitDeferred(result.loJobId!);
        expect(hub.jobs.get(result.loJobId!).log.at(-1)).toMatch(
          /\[warn\] LibreOffice could not draw the slides .*trying again/,
        );
        hub.jobs.undefer(result.loJobId!);
      }
      const lo = await waitJob(hub, result.loJobId!, 120_000);
      expect(lo.state).toBe('done');
      expect(lo.result).toMatchObject({ failed: 2, art: 0, pages: 0 });
      expect(lo.log.some((l) => /could not draw the slides after 3 attempts/.test(l))).toBe(true);
      const slides = slidesOf(hub.lib.presentations.must(result.presentationId));
      for (const s of slides) {
        expect(s.pptx).toMatchObject({ failed: true });
        expect(s.pptx!.pending).toBeUndefined();
      }
      expect(loStatus(result.pending, lo)).toMatchObject({ tone: 'red' });
    } finally {
      timeouts().soffice = real;
    }
  }, 300_000);

  it('a run that fails once and then works leaves nothing marked', async () => {
    const real = timeouts().soffice;
    timeouts().soffice = 1;
    const { result } = await importDeck(withChart(buildDeck({ slides: [chartSlide()] })));
    try {
      await waitDeferred(result.loJobId!);
    } finally {
      timeouts().soffice = real;
    }
    hub.jobs.undefer(result.loJobId!);
    const lo = await waitJob(hub, result.loJobId!, 120_000);
    expect(lo.result).toMatchObject({ art: 1, failed: 0 });
    const s = slidesOf(hub.lib.presentations.must(result.presentationId))[0]!;
    expect(s.pptx!.failed).toBeUndefined();
    expect(s.objects.some((o) => o.type === 'image')).toBe(true);
    expect(loStatus(result.pending, lo)).toMatchObject({ tone: 'green' });
  }, 300_000);
});

describe.skipIf(!tools)('version 2 is never lost to a stale editor (design/27 §5)', () => {
  it('a version-1 draft saved over version 2 gets its art back without running LibreOffice again', async () => {
    const { result } = await importDeck(withChart(buildDeck({ slides: [chartSlide('Givng')] })));
    const lo = await waitJob(hub, result.loJobId!, 120_000);
    expect(lo.result).toMatchObject({ art: 1 });
    const v2 = hub.lib.presentations.must(result.presentationId);
    const art = slidesOf(v2)[0]!.objects.find((o): o is ImageObject => o.type === 'image')!;
    // The editor opened version 1, fixed the typo and, at the conflict, chose 'Save mine anyway'.
    const draft = hub.lib.revision(v2.id, 1) as Presentation;
    const t = draft.sections[0]!.slides[0]!.objects.find((o) => o.type === 'text')!;
    if (t.type === 'text') t.text = 'Giving';
    const ed = await login(hub.url, EDIT_PIN);
    // Held so the waiting state can be seen; it runs at once otherwise.
    const hold = holdFollowUps();
    let again: { id: string; payload: string };
    try {
      await ed.json(`/presentations/${v2.id}`, { method: 'PUT', json: { ...draft, rev: v2.rev } });
      const saved = hub.lib.presentations.must(v2.id);
      expect(slidesOf(saved)[0]!.pptx!.pending).toBe(true);
      again = hub.lib.db
        .prepare(
          `SELECT id, payload FROM jobs WHERE kind = 'pptx-lo' AND state IN ('queued', 'running')
           AND json_extract(payload, '$.presentationId') = ?`,
        )
        .get(v2.id) as { id: string; payload: string };
      expect(again).toBeDefined();
      const plan = JSON.parse(again.payload) as PptxLoPayload;
      // Planned as the first follow-up planned it (the art, version 1's digests), its pictures reused.
      expect(plan.slides[0]!.art).toBeDefined();
      expect(plan.slides[0]!.replaced).toBeDefined();
      expect(plan.done?.length).toBeGreaterThan(0);
      // Only one at a time.
      expect(hub.imports.pptx.followUp(saved)).toBeUndefined();
      await waitDeferred(again.id);
    } finally {
      hold.release();
    }
    hub.jobs.undefer(again.id);
    const followUp: Job = await waitJob(hub, again.id, 120_000);
    expect(followUp.result).toMatchObject({ art: 1, failed: 0 });
    expect(followUp.log.some((l) => /LibreOffice: \d+ page/.test(l))).toBe(false);
    const back = slidesOf(hub.lib.presentations.must(v2.id))[0]!;
    expect(back.pptx!.pending).toBeUndefined();
    expect(back.objects.find((o): o is ImageObject => o.type === 'image')!.mediaId).toBe(art.mediaId);
    expect(back.objects.some((o) => o.type === 'text' && o.text === 'Giving')).toBe(true);
    // A save with nothing waiting queues nothing.
    expect(hub.imports.pptx.followUp(hub.lib.presentations.must(v2.id))).toBeUndefined();
  }, 300_000);

  it('a picture slide duplicated before LibreOffice ran gets its page too', async () => {
    const hold = holdFollowUps();
    let result: PptxNativeResult;
    try {
      ({ result } = await importDeck(buildDeck({ slides: [pictureSlide()] })));
      await waitDeferred(result.loJobId!);
      const p = hub.lib.presentations.must(result.presentationId);
      const s = p.sections[0]!.slides[0]!;
      const { digest: _d, ...pptx } = s.pptx!;
      const copy: Slide = { ...structuredClone(s), id: newId(), pptx };
      const ed = await login(hub.url, EDIT_PIN);
      await ed.json(`/presentations/${p.id}`, {
        method: 'PUT',
        json: { ...p, sections: [{ ...p.sections[0]!, slides: [s, copy] }] },
      });
    } finally {
      hold.release();
    }
    hub.jobs.undefer(result!.loJobId!);
    const lo = await waitJob(hub, result!.loJobId!, 120_000);
    expect(lo.result).toMatchObject({ pages: 2, failed: 0 });
    const [a, b] = slidesOf(hub.lib.presentations.must(result!.presentationId));
    for (const s of [a!, b!]) {
      expect(s.pptx!.pending).toBeUndefined();
      expect(s.imported?.imageMediaId).toBeDefined();
    }
    expect(a!.imported!.imageMediaId).toBe(b!.imported!.imageMediaId);
  }, 300_000);
});
