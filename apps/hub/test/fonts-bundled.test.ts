import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  DEFAULT_LOOKS,
  type Font,
  type LiveState,
  lyricSlide,
  newId,
  SCRIPT_FALLBACK_FONTS,
} from '@ordo/domain';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';
import type { OutputConfigRes } from '@ordo/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
  BUNDLED_FACES,
  type BundledFace,
  bundledSubstitute,
  outputFonts,
  SCRIPT_RANGES,
} from '../src/fonts/bundled.ts';
import { normalizeUnicodeRange } from '../src/fonts/google.ts';
import { FontService } from '../src/fonts/service.ts';
import { createLibraryProcess, type LibraryProcess } from '../src/libproc.ts';
import { noSystemFaces } from '../src/pptx/systemFaces.ts';
import {
  client,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  sleep,
  song,
  startHub,
  type TestHub,
  TEST_TOOLS,
  tempDir,
} from './helpers.ts';

let hub: TestHub | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Bytes that sniff as a font (TrueType or CFF magic), unique per name so every file has its own hash. */
function fakeFont(name: string, salt = ''): Buffer {
  const magic = name.endsWith('.otf') ? Buffer.from('OTTO') : Buffer.from([0, 1, 0, 0]);
  return Buffer.concat([magic, Buffer.alloc(8), Buffer.from(`${name}${salt}`)]);
}

/**
 * A fonts directory laid out as Debian installs the bundled faces; `flat` faces are put under another
 * folder by file name only (found by the name search), `skip` faces are not installed.
 */
function fontsDir(opts: { skip?: (f: BundledFace) => boolean; flat?: (f: BundledFace) => boolean } = {}) {
  const dir = tempDir('ordo-fonts-');
  dirs.push(dir);
  for (const f of BUNDLED_FACES) {
    if (opts.skip?.(f)) continue;
    const rel = opts.flat?.(f) ? join('elsewhere', 'deep', basename(f.paths[0]!)) : f.paths[0]!;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), fakeFont(basename(rel)));
  }
  return dir;
}

const bundledRows = (h: TestHub) => h.lib.listFonts().filter((f) => f.source === 'bundled');
const key = (f: Pick<Font, 'family' | 'weight' | 'style'>) => `${f.family} ${f.weight} ${f.style}`;

describe('bundled fonts (design/27 §10)', () => {
  it('lists the substitutes, script fallbacks and Inter the converter and the resolver name', () => {
    const families = new Set(BUNDLED_FACES.map((f) => f.family));
    expect([...families].sort()).toEqual(
      [
        'Caladea',
        'Carlito',
        'Inter',
        'Liberation Mono',
        'Liberation Sans',
        'Liberation Serif',
        'Noto Naskh Arabic',
        'Noto Sans',
        'Noto Sans Devanagari',
        'Noto Sans Hebrew',
        'Noto Sans Myanmar',
        'Noto Sans Tamil',
        'Noto Sans Thai',
      ].sort(),
    );
    // Every non-CJK script fallback family of the resolver's table is bundled.
    for (const [code, fams] of Object.entries(SCRIPT_FALLBACK_FONTS))
      if (!['Hani', 'Hira', 'Kana', 'Hang'].includes(code))
        for (const f of fams) expect(families.has(f), `${code}: ${f}`).toBe(true);
    expect(bundledSubstitute('Calibri')).toBe('Carlito');
    expect(bundledSubstitute(' calibri light ')).toBe('Carlito');
    expect(bundledSubstitute('Cambria')).toBe('Caladea');
    expect(bundledSubstitute('Arial')).toBe('Liberation Sans');
    expect(bundledSubstitute('Times New Roman')).toBe('Liberation Serif');
    expect(bundledSubstitute('Courier New')).toBe('Liberation Mono');
    expect(bundledSubstitute('Century Gothic')).toBeUndefined();
    // Script faces carry their script's range, canonical as the Google subsets are stored.
    for (const r of Object.values(SCRIPT_RANGES)) expect(normalizeUnicodeRange(r)).toBe(r);
    const hebrew = BUNDLED_FACES.find((f) => f.family === 'Noto Sans Hebrew')!;
    expect(hebrew.unicodeRange).toBe(SCRIPT_RANGES.Hebr);
    expect(BUNDLED_FACES.filter((f) => f.family === 'Noto Sans').every((f) => !f.unicodeRange)).toBe(true);
    // Faces are unique by family, weight and style.
    expect(new Set(BUNDLED_FACES.map(key)).size).toBe(BUNDLED_FACES.length);
  });

  it('registers the installed faces as library fonts at start, once', async () => {
    const dir = fontsDir({ flat: (f) => f.family === 'Caladea' });
    // Liberation 1.x and 2.x both installed: the liberation2 folder wins.
    const old = join(dir, 'truetype/liberation/LiberationSans-Regular.ttf');
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, fakeFont('old-liberation.ttf'));
    hub = await startHub({ fontsDir: dir });
    const first = await hub.fonts.bundled;
    expect(first).toMatchObject({ registered: BUNDLED_FACES.length, unchanged: 0, missing: [] });
    const rows = bundledRows(hub);
    expect(rows.map(key).sort()).toEqual(BUNDLED_FACES.map(key).sort());
    const sans = rows.find((f) => key(f) === 'Liberation Sans 400 normal')!;
    expect(hub.lib.getFile(sans.file.hash)?.bytes).toBe(fakeFont('LiberationSans-Regular.ttf').length);
    expect(rows.find((f) => key(f) === 'Caladea 700 italic')).toBeTruthy();
    expect(rows.find((f) => key(f) === 'Inter 400 normal')?.file.mime).toBe('font/otf');
    expect(rows.find((f) => key(f) === 'Noto Naskh Arabic 700 normal')?.unicodeRange).toBe(
      SCRIPT_RANGES.Arab,
    );
    expect(rows.find((f) => key(f) === 'Carlito 400 normal')?.unicodeRange).toBeUndefined();
    // The files are in the content store and served like any font.
    const ed = await login(hub.url, EDIT_PIN);
    expect((await ed.fetch(`/files/${sans.file.hash}`)).status).toBe(200);

    const seq = hub.lib.seq();
    const again = await hub.fonts.registerBundled(dir);
    expect(again).toMatchObject({ registered: 0, unchanged: BUNDLED_FACES.length, removed: 0 });
    expect(
      bundledRows(hub)
        .map((f) => f.id)
        .sort(),
    ).toEqual(rows.map((f) => f.id).sort());
    expect(hub.lib.seq()).toBe(seq);
  });

  it('replaces a changed file, keeps the venue’s own faces and drops retired ones', async () => {
    const dir = fontsDir();
    hub = await startHub({ fontsDir: dir });
    await hub.fonts.bundled;
    const before = bundledRows(hub).find((f) => key(f) === 'Carlito 400 normal')!;
    writeFileSync(join(dir, 'truetype/crosextra/Carlito-Regular.ttf'), fakeFont('Carlito-Regular.ttf', 'v2'));
    // The venue uploaded its own Inter bold; a face retired from the list is still in the library.
    hub.lib.upsertFont({
      family: 'Inter',
      weight: 700,
      style: 'normal',
      file: { hash: 'e'.repeat(64), bytes: 3, mime: 'font/ttf', path: `fonts/${'e'.repeat(64)}.ttf` },
      source: 'upload',
    });
    const retired = hub.lib.upsertFont({ ...before, id: undefined, family: 'Retired Sans' });
    const r = await hub.fonts.registerBundled(dir);
    expect(r).toMatchObject({ registered: 1, kept: 1, removed: 1 });
    const after = bundledRows(hub).find((f) => key(f) === 'Carlito 400 normal')!;
    expect(after.id).toBe(before.id);
    expect(after.file.hash).not.toBe(before.file.hash);
    // The old file is released once nothing refers to it (the retired row shared it).
    expect(hub.lib.getFile(before.file.hash)).toBeUndefined();
    expect(hub.lib.getFont(retired.id)).toBeUndefined();
    expect(hub.lib.listFonts().find((f) => key(f) === 'Inter 700 normal')?.source).toBe('upload');
  });

  it('reports faces that are not installed and registers the rest', async () => {
    const dir = fontsDir({ skip: (f) => f.family === 'Noto Sans Myanmar' });
    hub = await startHub({ fontsDir: dir });
    const r = await hub.fonts.bundled;
    expect(r?.missing).toEqual(['Noto Sans Myanmar 400', 'Noto Sans Myanmar 700']);
    expect(r?.registered).toBe(BUNDLED_FACES.length - 2);
    // A file that is not a font is never registered.
    writeFileSync(join(dir, 'truetype/noto/NotoSansMyanmar-Regular.ttf'), 'not a font');
    expect((await hub.fonts.registerBundled(dir))?.missing).toContain('Noto Sans Myanmar 400');
    // Without a fonts directory nothing is registered.
    const plain = await startHub();
    try {
      expect(await plain.fonts.bundled).toBeUndefined();
      expect(bundledRows(plain)).toEqual([]);
    } finally {
      await plain.cleanup();
    }
  });

  it('refuses to delete a bundled face', async () => {
    hub = await startHub({ fontsDir: fontsDir() });
    await hub.fonts.bundled;
    const ed = await login(hub.url, EDIT_PIN);
    const f = bundledRows(hub)[0]!;
    const res = await ed.fetch(`/fonts/${f.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(hub.lib.getFont(f.id)).toBeTruthy();
  });
});

/** A Google subset row of a CJK family, as the font-google job stores it. */
function cjkSubset(h: TestHub, family: string, range: string): Font {
  const hash = newId().toLowerCase().padEnd(64, '0').slice(0, 64);
  return h.lib.upsertFont({
    family,
    weight: 400,
    style: 'normal',
    file: { hash, bytes: 3, mime: 'font/woff2', path: `fonts/${hash}.woff2` },
    source: 'google',
    unicodeRange: range,
  });
}

describe('fonts on outputs', () => {
  it('sends every output the bundled faces, and CJK faces only in a goLive whose text needs them', async () => {
    hub = await startHub({ fontsDir: fontsDir() });
    await hub.fonts.bundled;
    const kr = [cjkSubset(hub, 'Noto Sans KR', 'U+AC00-D7A3'), cjkSubset(hub, 'Noto Sans KR', 'U+0-FF')];
    const tok = hub.lib.getSetting('outputs')[0]!.token!;
    const out = client(hub.url, '', { 'x-ordo-token': tok });
    const cfg = await out.json<OutputConfigRes>('/output/config');
    const families = new Set(cfg.fonts.map((f) => f.family));
    for (const f of [
      'Inter',
      'Carlito',
      'Liberation Sans',
      'Noto Sans',
      'Noto Sans Hebrew',
      'Noto Naskh Arabic',
    ])
      expect(families.has(f), f).toBe(true);
    expect(families.has('Noto Sans KR')).toBe(false);
    expect(cfg.fonts.find((f) => f.family === 'Noto Sans Thai')?.unicodeRange).toBe(SCRIPT_RANGES.Thai);

    const op = await login(hub.url, OPERATE_PIN);
    const goLive = async (slides: string[]) => {
      const p = song('Sunday');
      p.sections[0]!.slides = slides.map((t) => lyricSlide(t));
      hub!.lib.savePresentation(p, { create: true });
      const pl = hub!.lib.playlists.insert({
        id: newId(),
        rev: 1,
        name: 'Sunday',
        items: [{ id: newId(), kind: 'presentation', presentationId: p.id }],
      });
      await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
      const resolved = (await op.json<{ state: LiveState }>('/live')).state.resolved!;
      // The manifest outputs fill their service cache from.
      const manifest = await out.json<{ files: { hash: string }[] }>('/cache/manifest');
      await op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
      return { ...resolved, cached: new Set(manifest.files.map((f) => f.hash)) };
    };

    const latin = await goLive(['Amazing grace', 'how sweet the sound']);
    expect(latin.fonts.some((f) => f.family === 'Noto Sans KR')).toBe(false);

    const korean = await goLive(['Amazing grace', '주 하나님 지으신 모든 세계']);
    const shipped = korean.fonts.filter((f) => f.family === 'Noto Sans KR');
    expect(shipped.map((f) => f.id).sort()).toEqual(kr.map((f) => f.id).sort());
    for (const f of kr) expect(korean.cached.has(f.file.hash)).toBe(true);
    for (const f of kr) expect(latin.cached.has(f.file.hash)).toBe(false);

    const hebrew = await goLive(['הללויה']);
    expect(hebrew.fonts.filter((f) => f.family === 'Noto Sans Hebrew').length).toBe(2);
  });

  it('keeps CJK families out of the output config unless a look names them', () => {
    const face = (family: string): Font => ({
      id: family,
      family,
      weight: 400,
      style: 'normal',
      file: { hash: 'a'.repeat(64), bytes: 1, mime: 'font/woff2', path: 'fonts/a.woff2' },
      source: 'google',
    });
    const all = ['Inter', 'Noto Sans KR', 'noto sans jp', 'Venue Sans'].map(face);
    expect(outputFonts(all, DEFAULT_LOOKS).map((f) => f.family)).toEqual(['Inter', 'Venue Sans']);
    const look = structuredClone(DEFAULT_LOOKS[1]!);
    if (look.layers.slide.mode === 'lyricOnly') look.layers.slide.style.fontFamily = 'Noto Sans KR';
    expect(outputFonts(all, [look]).map((f) => f.family)).toEqual(['Inter', 'Noto Sans KR', 'Venue Sans']);
  });
});

describe('the hub listens once its bundled fonts are registered (design/27 §10)', () => {
  let lib: LibraryProcess | undefined;
  const gates: (() => void)[] = [];
  afterEach(async () => {
    for (const open of gates.splice(0)) open();
    vi.restoreAllMocks();
    await lib?.close();
    lib = undefined;
  });

  /**
   * The registration of the bundled fonts held at a gate, so no timing decides what a test sees: it starts
   * with the service, as it always does, and finishes when the returned function is called (or at the end of
   * the test, so no hub is left waiting).
   */
  function held(): () => void {
    const real = FontService.prototype.registerBundled;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    gates.push(open);
    vi.spyOn(FontService.prototype, 'registerBundled').mockImplementation(function (
      this: FontService,
      dir: string,
    ) {
      return gate.then(() => real.call(this, dir));
    });
    return open;
  }
  /** Whether `p` settled within `ms`. */
  const settledIn = (p: Promise<unknown>, ms: number) =>
    Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      sleep(ms).then(() => false),
    ]);
  const isBundled = (f: Font) => f.source === 'bundled';
  const every = BUNDLED_FACES.map(key).sort();

  it('does not listen until the registration is done, then lists every bundled face', async () => {
    const open = held();
    const p = startHub({ fontsDir: fontsDir(), fontsWaitMs: 10_000 });
    expect(await settledIn(p, 300), 'listening before the bundled fonts are registered').toBe(false);
    open();
    hub = await p;
    const ed = await login(hub.url, EDIT_PIN);
    const rows = await ed.json<Font[]>('/fonts');
    expect(rows.filter(isBundled).map(key).sort()).toEqual(every);
  });

  it('waits at most fontsWaitMs, then warns once and answers with the list it has', async () => {
    const open = held();
    const t0 = performance.now();
    hub = await startHub({ fontsDir: fontsDir(), fontsWaitMs: 150 });
    const waited = performance.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(100);
    expect(waited).toBeLessThan(budgetMs(2000));
    expect(bundledRows(hub)).toHaveLength(0);
    const warned = hub.ring.snapshot().filter((l) => l.includes('bundled fonts not registered in time'));
    expect(warned).toHaveLength(1);
    // The registration still finishes behind the answer.
    open();
    await hub.fonts.bundled;
    expect(bundledRows(hub).map(key).sort()).toEqual(every);
  });

  it('fontsWaitMs 0 does not wait, and says nothing', async () => {
    held();
    const p = startHub({ fontsDir: fontsDir(), fontsWaitMs: 0 });
    expect(await settledIn(p, budgetMs(5000)), 'startHub waited with fontsWaitMs 0').toBe(true);
    hub = await p;
    expect(bundledRows(hub)).toHaveLength(0);
    expect(
      hub.ring.snapshot().filter((l) => l.includes('bundled fonts not registered in time')),
    ).toHaveLength(0);
  });

  it('the library process says it is ready only once the registration is done', async () => {
    const open = held();
    const cfg = {
      minFreeBytes: 0, // the floor would refuse every upload on a volume with less free than it; it has its own tests (helpers.ts)
      dataDir: tempDir(),
      logToStdout: false,
      logLevel: 'warn',
      scheduleBackups: false,
      toolProbe: TEST_TOOLS,
      systemFaces: noSystemFaces,
      fontsDir: fontsDir(),
      fontsWaitMs: 10_000,
    };
    const p = createLibraryProcess(cfg, { secret: 's' });
    expect(await settledIn(p, 300), 'ready before the bundled fonts are registered').toBe(false);
    open();
    lib = await p;
    expect(lib.lib.listFonts().filter(isBundled).map(key).sort()).toEqual(every);
  });

  it('ORDO_FONTS_WAIT_MS is a whole number of milliseconds from 0 to 30,000, else 2,000', () => {
    const wait = (v: string | undefined) =>
      loadConfig(v === undefined ? {} : { ORDO_FONTS_WAIT_MS: v }).fontsWaitMs;
    expect([undefined, '', '0', '2500', '30000', '30001', '-1', '1.5', 'x'].map(wait)).toEqual([
      2000, 2000, 0, 2500, 30_000, 2000, 2000, 2000, 2000,
    ]);
    expect(loadConfig({ ORDO_FONTS_WAIT_MS: '2500' }, { fontsWaitMs: 5 }).fontsWaitMs).toBe(5);
  });
});
