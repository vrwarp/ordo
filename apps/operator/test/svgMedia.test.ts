import type { Media } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * SVG uploads and tiles in the operator (design/12 "Media pipeline", design/15 "Media library"): an SVG goes up
 * with the still the screens draw, and where it is picked its tile is the SVG itself (it moves there) with a
 * note that the screens show a still.
 */

const sent: FormData[] = [];
/** Calls of `api` (path, method, body) and how the next ones answer (a value, or an error to throw). */
const apiCalls: { path: string; method: string; body: unknown }[] = [];
let apiAnswers: ((path: string) => unknown)[] = [];
vi.mock('@ordo/client', async (orig) => ({
  ...(await orig<typeof import('@ordo/client')>()),
  upload: vi.fn(async (_path: string, fd: FormData) => {
    sent.push(fd);
    return { id: 'm1' };
  }),
  api: vi.fn(async (path: string, init: RequestInit & { json?: unknown } = {}) => {
    apiCalls.push({ path, method: init.method ?? 'GET', body: init.json ?? init.body });
    const answer = apiAnswers.shift()?.(path);
    if (answer instanceof Error) throw answer;
    return answer;
  }),
}));

const { ApiFailure } = await import('@ordo/client');
const { isSvgFile, mediaForm, rasterizeSvg, sendStill, uploadMedia } = await import(
  '../src/services/upload.ts'
);
const { svgNote, stillHash, tileHash } = await import('../src/services/thumbs.ts');
const { useLibrary } = await import('../src/state/library.ts');
const { MediaPickerDialog } = await import('../src/views/editor/BackgroundPicker.tsx');

const file = (hash: string, mime: string) => ({ hash, bytes: 10, mime, path: `files/${hash}` });
const media = (id: string, m: Partial<Media>): Media => ({
  id,
  rev: 1,
  name: id,
  tags: [],
  kind: 'image',
  original: file(`${id}-orig`, 'image/png'),
  state: 'ready',
  loop: false,
  isBackground: true,
  width: 1920,
  height: 1080,
  ...m,
});
const wave = media('wave', {
  original: file('wave-svg', 'image/svg+xml'),
  delivery: file('wave-png', 'image/png'),
});
const legacy = media('legacy', { original: file('legacy-svg', 'image/svg+xml') });
const photo = media('photo', {});

const svgFile = (name = 'wave.svg', type = 'image/svg+xml') =>
  new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 9"/>'], name, { type });

beforeEach(() => {
  sent.length = 0;
  apiCalls.length = 0;
  apiAnswers = [];
});

describe('SVG uploads', () => {
  it('knows an SVG by its type, else by its name', () => {
    expect(isSvgFile({ name: 'a.svg', type: 'image/svg+xml' })).toBe(true);
    expect(isSvgFile({ name: 'a.SVG', type: '' })).toBe(true);
    expect(isSvgFile({ name: 'a.png', type: 'image/svg+xml' })).toBe(true);
    expect(isSvgFile({ name: 'a.svg', type: 'image/png' })).toBe(false);
    expect(isSvgFile({ name: 'a.png', type: 'image/png' })).toBe(false);
  });

  it('sends the still beside the SVG as "raster"', async () => {
    const fd = mediaForm(
      svgFile('Moving wave.svg'),
      { isBackground: true, tags: ['a', 'b'] },
      new Blob(['png']),
    );
    expect((fd.get('file') as File).name).toBe('Moving wave.svg');
    expect((fd.get('raster') as File).name).toBe('Moving wave.png');
    expect(fd.get('isBackground')).toBe('true');
    expect(fd.get('tags')).toBe('a,b');
    expect(mediaForm(svgFile(), {}).get('raster')).toBeNull();
  });

  it('draws an SVG before it goes up, and nothing else', async () => {
    const drawn: string[] = [];
    const rasterize = async (f: File) => {
      drawn.push(f.name);
      return new Blob(['png'], { type: 'image/png' });
    };
    await uploadMedia(svgFile(), {}, () => {}, undefined, rasterize);
    await uploadMedia(
      new File(['x'], 'photo.png', { type: 'image/png' }),
      {},
      () => {},
      undefined,
      rasterize,
    );
    expect(drawn).toEqual(['wave.svg']);
    expect(sent.map((f) => !!f.get('raster'))).toEqual([true, false]);
    // When it cannot be drawn here, it goes up alone (outputs then draw it themselves).
    await uploadMedia(
      svgFile(),
      {},
      () => {},
      undefined,
      async () => undefined,
    );
    expect(sent[2]!.get('raster')).toBeNull();
    expect(sent[2]!.get('file')).not.toBeNull();
  });

  it('cannot draw without a page (a worker, a test): the SVG goes up alone', async () => {
    expect(await rasterizeSvg(svgFile())).toBeUndefined();
  });

  it('an SVG over the one-request limit goes up in chunks, then its still follows to /media/:id/still', async () => {
    const big = new File([new Uint8Array(25 * 1024 * 1024)], 'big.svg', { type: 'image/svg+xml' });
    const fresh = media('u-media', { original: file('big-svg', 'image/svg+xml'), state: 'uploaded' });
    const withStill = { ...fresh, delivery: file('big-png', 'image/png') };
    apiAnswers = [() => ({ id: 'up1', offset: 0, size: big.size }), () => withStill];
    const patches: number[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const offset = Number((init.headers as Record<string, string>)['upload-offset']);
      const end = offset + (init.body as Blob).size;
      patches.push(offset);
      return end < big.size
        ? new Response(null, { status: 204, headers: { 'upload-offset': String(end) } })
        : new Response(JSON.stringify(fresh), { status: 201, headers: { 'upload-offset': String(end) } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const drawn: string[] = [];
      const m = await uploadMedia(
        big,
        {},
        () => {},
        undefined,
        async (f) => {
          drawn.push(f.name);
          return new Blob(['png'], { type: 'image/png' });
        },
      );
      expect(patches).toEqual([0, 8 * 1024 * 1024, 16 * 1024 * 1024, 24 * 1024 * 1024]);
      expect(drawn).toEqual(['big.svg']);
      expect(apiCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /media/uploads',
        'PUT /media/u-media/still',
      ]);
      expect(((apiCalls[1]!.body as FormData).get('raster') as File).name).toBe('big.png');
      expect(m.delivery?.hash).toBe('big-png');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends the still again while the hub processes the SVG, and gives up on a refusal', async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    const busy = () => new ApiFailure(409, 'busy', 'being processed');
    apiAnswers = [busy, busy, () => ({ id: 'm9' })];
    expect(await sendStill('m9', 'wave.svg', new Blob(['png']), wait)).toEqual({ id: 'm9' });
    expect(apiCalls).toHaveLength(3);
    expect(waits).toHaveLength(2);
    // Refused (it has one already, a bad still, gone): the SVG stays as it is.
    apiCalls.length = 0;
    apiAnswers = [() => new ApiFailure(409, 'has_still', 'has one')];
    expect(await sendStill('m9', 'wave.svg', new Blob(['png']), wait)).toBeUndefined();
    apiAnswers = [() => new ApiFailure(400, 'bad_raster', 'not a PNG')];
    expect(await sendStill('m9', 'wave.svg', new Blob(['png']), wait)).toBeUndefined();
    expect(apiCalls).toHaveLength(2);
    // Busy for good: bounded.
    apiCalls.length = 0;
    apiAnswers = Array.from({ length: 20 }, () => busy);
    expect(await sendStill('m9', 'wave.svg', new Blob(['png']), wait)).toBeUndefined();
    expect(apiCalls).toHaveLength(10);
  });
});

describe('SVG tiles', () => {
  it('shows the SVG itself where it is picked; slides and outputs use its still', () => {
    expect(tileHash(wave)).toBe('wave-svg');
    expect(stillHash(wave)).toBe('wave-png');
    expect(tileHash(legacy)).toBe('legacy-svg');
    expect(tileHash(photo)).toBe('photo-orig');
    expect(tileHash(undefined)).toBeUndefined();
    expect(svgNote(wave)).toMatch(/still picture.*first frame.*moves in previews only/);
    expect(svgNote(photo)).toBeUndefined();
    // Without its still, each screen draws it itself (2026-11-13 review), and not at all past 2 MB.
    expect(svgNote(legacy)).toMatch(/without a still picture: each Audience screen draws it itself/);
    const big = { ...legacy, original: { ...legacy.original, bytes: 3 * 1024 * 1024 } };
    expect(svgNote(big)).toMatch(/over 2 MB: Audience screens do not show it/);
  });

  it('the picker says so on an SVG’s tile', () => {
    const state = { ...useLibrary.getState().data, media: [wave, photo] };
    Object.assign(useLibrary.getInitialState(), { data: state });
    useLibrary.setState({ data: state });
    const out = renderToStaticMarkup(
      createElement(MediaPickerDialog, { title: 'Background', onPick: () => {}, onClose: () => {} }),
    );
    // One tile has the badge (and its title says the same); the photo has neither.
    expect(out.match(/data-svg-note/g)).toHaveLength(1);
    expect(out).toContain('SVG · moves in previews only');
    expect(out).toContain('wave-svg');
    expect(out).not.toContain('wave-png');
  });
});
