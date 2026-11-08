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
import type { OutputConfigRes } from '@ordo/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLED_FACES,
  type BundledFace,
  bundledSubstitute,
  outputFonts,
  SCRIPT_RANGES,
} from '../src/fonts/bundled.ts';
import { normalizeUnicodeRange } from '../src/fonts/google.ts';
import { client, EDIT_PIN, login, OPERATE_PIN, song, startHub, type TestHub, tempDir } from './helpers.ts';

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
