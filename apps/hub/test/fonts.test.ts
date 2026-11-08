import { existsSync, readFileSync } from 'node:fs';
import { brotliCompressSync, deflateSync } from 'node:zlib';
import type { Font } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/config.ts';
import { cssUrls, parseFontCss, searchGoogleFonts } from '../src/fonts/google.ts';
import { faceFromFilename, readFontFace } from '../src/fonts/sfnt.ts';
import { type Client, EDIT_PIN, login, startHub, type TestHub } from './helpers.ts';

const DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const DEJAVU_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const INTER_OTF = '/usr/share/fonts/opentype/inter/Inter-Thin.otf';

type Table = { tag: string; data: Buffer };
function sfntTables(buf: Buffer): Table[] {
  const n = buf.readUInt16BE(4);
  const out: Table[] = [];
  for (let i = 0; i < n; i++) {
    const e = 12 + i * 16;
    const off = buf.readUInt32BE(e + 8);
    const len = buf.readUInt32BE(e + 12);
    out.push({ tag: buf.toString('latin1', e, e + 4), data: buf.subarray(off, off + len) });
  }
  return out;
}

/** WOFF 1.0 container around a TTF (zlib per table). */
function toWoff(ttf: Buffer): Buffer {
  const tables = sfntTables(ttf);
  const header = Buffer.alloc(44);
  const dir = Buffer.alloc(20 * tables.length);
  const datas: Buffer[] = [];
  let off = 44 + dir.length;
  tables.forEach((t, i) => {
    const comp = deflateSync(t.data);
    const use = comp.length < t.data.length ? comp : t.data;
    dir.write(t.tag, i * 20, 'latin1');
    dir.writeUInt32BE(off, i * 20 + 4);
    dir.writeUInt32BE(use.length, i * 20 + 8);
    dir.writeUInt32BE(t.data.length, i * 20 + 12);
    const padded = Buffer.concat([use, Buffer.alloc((4 - (use.length % 4)) % 4)]);
    datas.push(padded);
    off += padded.length;
  });
  header.write('wOFF', 0, 'latin1');
  ttf.copy(header, 4, 0, 4);
  header.writeUInt32BE(off, 8);
  header.writeUInt16BE(tables.length, 12);
  return Buffer.concat([header, dir, ...datas]);
}

/** A WOFF2 carrying only head/name/OS/2 (untransformed): enough for metadata parsing. */
function toWoff2Meta(ttf: Buffer): Buffer {
  const idx: Record<string, number> = { head: 1, name: 5, 'OS/2': 6 };
  const tables = sfntTables(ttf).filter((t) => t.tag in idx);
  const base128 = (n: number) => {
    const bytes: number[] = [];
    do {
      bytes.unshift(n & 0x7f);
      n = Math.floor(n / 128);
    } while (n > 0);
    return bytes.map((b, i) => (i < bytes.length - 1 ? b | 0x80 : b));
  };
  const dir = Buffer.from(tables.flatMap((t) => [idx[t.tag]!, ...base128(t.data.length)]));
  const comp = brotliCompressSync(Buffer.concat(tables.map((t) => t.data)));
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  ttf.copy(header, 4, 0, 4);
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt32BE(comp.length, 20);
  const all = Buffer.concat([header, dir, comp]);
  all.writeUInt32BE(all.length, 8);
  return all;
}

describe('sfnt parsing', () => {
  it('reads family, weight and style from TTF, OTF, WOFF and WOFF2', () => {
    const ttf = readFileSync(DEJAVU);
    expect(readFontFace(ttf)).toMatchObject({ family: 'DejaVu Sans', weight: 400, style: 'normal' });
    const bold = readFileSync(DEJAVU_BOLD);
    expect(readFontFace(bold)).toMatchObject({ family: 'DejaVu Sans', weight: 700 });
    expect(readFontFace(toWoff(bold))).toMatchObject({ family: 'DejaVu Sans', weight: 700 });
    expect(readFontFace(toWoff2Meta(bold))).toMatchObject({ family: 'DejaVu Sans', weight: 700 });
    if (existsSync(INTER_OTF))
      expect(readFontFace(readFileSync(INTER_OTF))).toMatchObject({ family: 'Inter', weight: 100 });
  });
  it('derives a face from a filename', () => {
    expect(faceFromFilename('OpenSans-SemiBoldItalic.woff2')).toEqual({
      family: 'Open Sans',
      weight: 600,
      style: 'italic',
    });
    expect(faceFromFilename('Lato-Black.ttf')).toEqual({ family: 'Lato', weight: 900, style: 'normal' });
  });
});

const FAKE_CSS = `
/* latin-ext */
@font-face {
  font-family: 'Test Sans';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/testsans/v1/ext400.woff2) format('woff2');
  unicode-range: U+0100-02BA;
}
/* latin */
@font-face {
  font-family: 'Test Sans';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/testsans/v1/latin400.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
/* latin */
@font-face {
  font-family: 'Test Sans';
  font-style: italic;
  font-weight: 300 500;
  src: url(https://fonts.gstatic.com/s/testsans/v1/latinItalic.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`;

describe('fonts API', () => {
  let hub: TestHub;
  let ed: Client;
  const requested: { url: string; ua?: string }[] = [];
  const woff2 = toWoff2Meta(readFileSync(DEJAVU));
  const fakeFetch: FetchLike = async (url, init) => {
    requested.push({ url, ua: init?.headers?.['User-Agent'] });
    const ok = (body: string | Buffer) => ({
      ok: true,
      status: 200,
      text: async () => body.toString(),
      arrayBuffer: async () => {
        const b = Buffer.from(body);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    });
    if (url.startsWith('https://fonts.googleapis.com/css2?family=Test+Sans')) {
      // First (variant list) URL fails like an unknown tuple would; the range URL succeeds.
      if (url.includes('100..900')) return ok(FAKE_CSS);
      return { ok: false, status: 400, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    }
    if (url.startsWith('https://fonts.gstatic.com/')) return ok(woff2);
    return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
  };

  beforeAll(async () => {
    hub = await startHub({ fetch: fakeFetch });
    ed = await login(hub.url, EDIT_PIN);
  });
  afterAll(async () => {
    await hub.cleanup();
  });

  it('uploads TTF/WOFF, honours form overrides, lists and deletes', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(DEJAVU)]), 'DejaVuSans.ttf');
    const res = await ed.fetch('/fonts/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(201);
    const [f] = (await res.json()) as Font[];
    expect(f).toMatchObject({ family: 'DejaVu Sans', weight: 400, style: 'normal', source: 'upload' });
    expect(f!.file.mime).toBe('font/ttf');
    const fd2 = new FormData();
    fd2.append('family', 'Venue Sans');
    fd2.append('weight', '800');
    fd2.append('file', new Blob([new Uint8Array(toWoff(readFileSync(DEJAVU_BOLD)))]), 'whatever.woff');
    const [g] = await ed.json<Font[]>('/fonts/upload', { method: 'POST', body: fd2 });
    expect(g).toMatchObject({ family: 'Venue Sans', weight: 800, style: 'normal' });
    expect(g!.file.mime).toBe('font/woff');
    const bad = new FormData();
    bad.append('file', new Blob([Buffer.from('not a font')]), 'x.ttf');
    expect((await ed.fetch('/fonts/upload', { method: 'POST', body: bad })).status).toBe(415);
    expect((await ed.json<Font[]>('/fonts')).length).toBe(2);
    expect((await ed.fetch(`/files/${g!.file.hash}`)).status).toBe(200);
    expect((await ed.fetch(`/fonts/${g!.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await ed.json<Font[]>('/fonts')).length).toBe(1);
    // The file is gone with its last reference.
    expect((await ed.fetch(`/files/${g!.file.hash}`)).status).toBe(404);
  });

  it('searches the bundled Google Fonts list', async () => {
    const r = await ed.json<{ family: string }[]>('/fonts/google/search?q=mont');
    expect(r[0]!.family).toBe('Montserrat');
    expect(searchGoogleFonts('').length).toBeGreaterThan(40);
    expect(searchGoogleFonts('serif').some((f) => f.family === 'Lora')).toBe(true);
    expect(cssUrls('Open Sans')[0]).toMatch(/family=Open\+Sans:ital,wght@0,300;.*1,800/);
    // Every unicode-range subset is a face of its own (design/27 §10).
    const faces = parseFontCss(FAKE_CSS);
    const regular = faces.filter((f) => f.style === 'normal' && f.weights[0] === 400);
    expect(regular.map((f) => [f.url.replace(/.*\//, ''), f.unicodeRange, f.subset])).toEqual([
      ['ext400.woff2', 'U+100-2BA', 'latin-ext'],
      ['latin400.woff2', 'U+0-FF,U+131', 'latin'],
    ]);
    expect(faces.filter((f) => f.style === 'italic').map((f) => f.weights[0])).toEqual([300, 400, 500]);
  });

  it('fetches a Google family through a job with a desktop UA', async () => {
    const res = await ed.fetch('/fonts/google', { method: 'POST', json: { family: 'Test Sans' } });
    expect(res.status).toBe(202);
    const job = (await res.json()) as Job;
    await hub.jobs.idle();
    const done = await ed.json<Job>(`/jobs/${job.id}`);
    expect(done.state).toBe('done');
    const css = requested.find((r) => r.url.includes('100..900'));
    expect(css?.ua).toMatch(/Chrome\/\d+/);
    expect(requested.filter((r) => r.url.includes('gstatic')).length).toBe(3);
    const fonts = (await ed.json<Font[]>('/fonts')).filter((f) => f.family === 'Test Sans');
    expect(fonts.map((f) => `${f.style}${f.weight} ${f.unicodeRange}`).sort()).toEqual([
      'italic300 U+0-FF',
      'italic400 U+0-FF',
      'italic500 U+0-FF',
      'normal400 U+0-FF,U+131',
      'normal400 U+100-2BA',
    ]);
    expect(fonts.every((f) => f.source === 'google' && f.file.mime === 'font/woff2')).toBe(true);
    // Unknown family → failed job with a readable error.
    const j2 = await ed.json<Job>('/fonts/google', { method: 'POST', json: { family: 'Nope Font' } });
    await hub.jobs.idle();
    const f2 = await ed.json<Job>(`/jobs/${j2.id}`);
    expect(f2.state).toBe('failed');
    expect(f2.error).toMatch(/no family "Nope Font"/);
  });
});
