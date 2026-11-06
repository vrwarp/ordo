import { DEFAULT_LYRIC_STYLE, LOOK_MAIN, type TextObject } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';

import type { AssetJob } from '../messages.ts';
import { FALLBACK_FAMILIES, jobFontFamilies } from '../raster.ts';
import { fontString } from '../text2d.ts';
import {
  type FaceLike,
  type FontFile,
  FontResolver,
  LEGACY_FONT_ENV,
  faceKey,
  hash8,
  installFontEnv,
  internalFamilyName,
} from './fonts.ts';
import { layoutRich } from './rich.ts';
import { testMeasurer } from './test-util.ts';
import type { FaceRequest } from './types.ts';

type Face = FaceLike & { name: string; desc: FontFaceDescriptors; data: ArrayBuffer | string };

/** A fake face set, clock, timers and file store: what a drawer's FontHost provides. */
function fakeHost(opts: { failData?: Set<string>; failParse?: Set<string> } = {}) {
  const failData = opts.failData ?? new Set<string>();
  const failParse = opts.failParse ?? new Set<string>();
  const set = new Set<Face>();
  let now = 1000;
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const reads: string[] = [];
  const host = {
    set: {
      add: (f: FaceLike) => set.add(f as Face),
      delete: (f: FaceLike) => set.delete(f as Face),
    },
    async data(f: FontFile) {
      reads.push(f.hash);
      if (failData.has(f.hash)) throw new Error('file unavailable');
      return f.hash.startsWith('url:') ? f.hash.slice(4) : new TextEncoder().encode(f.hash).buffer;
    },
    face(name: string, data: ArrayBuffer | string, desc: FontFaceDescriptors): Face {
      const hash = typeof data === 'string' ? `url:${data}` : new TextDecoder().decode(data);
      return {
        name,
        desc,
        data,
        load: () => (failParse.has(hash) ? Promise.reject(new Error('bad font data')) : Promise.resolve()),
      };
    },
    timer(fn: () => void, ms: number) {
      const t = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    now: () => now,
  };
  return {
    host,
    set,
    reads,
    failData,
    failParse,
    /** Names in the face set, with how many faces each. */
    names: () => {
      const m = new Map<string, number>();
      for (const f of set) m.set(f.name, (m.get(f.name) ?? 0) + 1);
      return m;
    },
    /** Move the clock and run the timers that are due (their rounds included). */
    async advance(ms: number) {
      now += ms;
      for (const t of timers.splice(0)) {
        if (t.cancelled) continue;
        if (t.at <= now) t.fn();
        else timers.push(t);
      }
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
  };
}

const face = (
  family: string,
  hash: string,
  weight = 400,
  style: 'normal' | 'italic' = 'normal',
): FontFile => ({
  family,
  weight,
  style,
  hash,
});

const req = (family: string, over: Partial<FaceRequest> = {}): FaceRequest => ({
  family,
  fallbacks: [],
  weight: 400,
  italic: false,
  smallCaps: false,
  sizePx: 40,
  script: '',
  ...over,
});

/** The family list of a CSS font string. */
const families = (font: string) => font.replace(/^.*?\d+(?:\.\d+)?px /, '');

afterEach(() => installFontEnv(LEGACY_FONT_ENV));

describe('internal family names', () => {
  it("are 'o' + 8 hex digits of the scope, the family and its sorted face keys", () => {
    const a = internalFamilyName('', 'Open Sans', ['b', 'a']);
    expect(a).toMatch(/^o[0-9a-f]{8}$/);
    expect(internalFamilyName('', ' open sans ', ['a', 'b'])).toBe(a);
    expect(internalFamilyName('pres-1', 'Open Sans', ['a', 'b'])).not.toBe(a);
    expect(internalFamilyName('', 'Open Sans', ['a', 'b', 'c'])).not.toBe(a);
    expect(hash8('')).toBe('811c9dc5');
    expect(faceKey({ ...face('X', 'h', 700, 'italic'), unicodeRange: 'U+0590-05FF' })).toBe(
      'h|700|italic|U+0590-05FF',
    );
  });
});

describe('FontResolver', () => {
  it('registers every face of a family under one fresh name and uses it only once loaded', async () => {
    const h = fakeHost();
    const r = new FontResolver(h.host);
    expect(families(r.font(req('Open Sans')))).toBe('"Open Sans", "Inter", "Segoe UI", Arial, sans-serif');
    const p = r.sync([
      face('Open Sans', 'r'),
      face('Open Sans', 'b', 700),
      face('Open Sans', 'i', 400, 'italic'),
    ]);
    // Not loaded yet: the family string is unchanged and the faces are not in the set.
    expect(r.font(req('Open Sans'))).toContain('"Open Sans"');
    expect(h.set.size).toBe(0);
    const res = await p;
    expect(res).toEqual({ loaded: 3, failed: [], ready: ['open sans'] });
    const name = r.nameOf('open sans')!;
    expect(name).toBe(
      internalFamilyName('', 'Open Sans', ['r|400|normal|', 'b|700|normal|', 'i|400|italic|']),
    );
    expect([...h.names()]).toEqual([[name, 3]]);
    expect(r.generation).toBe(1);
    expect(r.font(req('OPEN SANS', { weight: 700, italic: true, smallCaps: true }))).toBe(
      `italic small-caps 700 40px "${name}", "Inter", "Segoe UI", Arial, sans-serif`,
    );
    expect([...h.set].map((f) => f.desc)).toContainEqual({ weight: '700', style: 'normal' });
  });

  it('builds stacks of loaded names: exact face, fallbacks, script fallback, original name, Inter, generics', async () => {
    const h = fakeHost();
    const r = new FontResolver(h.host);
    await r.sync([
      face('Calibri', 'cal'),
      face('Carlito', 'car'),
      face('Noto Sans Hebrew', 'heb'),
      face('Noto Naskh Arabic', 'ara'),
      face('Inter', 'int'),
    ]);
    const n = (f: string) => `"${r.nameOf(f)}"`;
    const stack = (q: FaceRequest) => families(r.font(q));
    // Unloaded fallbacks are left out; a script fallback is used only for its script.
    expect(stack(req('Calibri', { fallbacks: ['Carlito', 'Missing'], script: 'Hebr' }))).toBe(
      `${n('Calibri')}, ${n('Carlito')}, ${n('Noto Sans Hebrew')}, ${n('Inter')}, "Inter", "Segoe UI", Arial, sans-serif`,
    );
    expect(stack(req('Calibri', { script: 'Arab' }))).toContain(n('Noto Naskh Arabic'));
    expect(stack(req('Calibri'))).not.toContain(n('Noto Sans Hebrew'));
    // A family that has not loaded keeps its own name after the shipped faces (the last resort).
    expect(stack(req('Century Gothic', { fallbacks: ['Carlito'], script: 'Hebr' }))).toBe(
      `${n('Carlito')}, ${n('Noto Sans Hebrew')}, "Century Gothic", ${n('Inter')}, "Inter", "Segoe UI", Arial, sans-serif`,
    );
    // Nothing twice, and a hostile script code finds nothing.
    expect(stack(req('Inter', { fallbacks: ['inter', 'Calibri', 'calibri'], script: '__proto__' }))).toBe(
      `${n('Inter')}, ${n('Calibri')}, "Inter", "Segoe UI", Arial, sans-serif`,
    );
    expect(stack(req('', { fallbacks: [] }))).toBe(`${n('Inter')}, "Inter", "Segoe UI", Arial, sans-serif`);
  });

  it('loads a changed face set under a new name, retires the old faces and bumps the generation once', async () => {
    const h = fakeHost();
    const r = new FontResolver(h.host);
    await r.sync([face('Lato', 'a')]);
    const first = r.nameOf('Lato')!;
    const gen = r.generation;
    // The same list again changes nothing.
    expect(await r.sync([face('Lato', 'a')])).toEqual({ loaded: 1, failed: [], ready: [] });
    expect(r.generation).toBe(gen);
    expect(h.reads).toEqual(['a']);
    const res = await r.sync([face('Lato', 'a'), face('Lato', 'b', 700)]);
    const second = r.nameOf('Lato')!;
    expect(second).not.toBe(first);
    expect(res.ready).toEqual(['lato']);
    expect(r.generation).toBe(gen + 1);
    expect([...h.names()]).toEqual([[second, 2]]);
    // Back to the first face set: a third name, never the first one again (it was resolved before).
    await r.sync([face('Lato', 'a')]);
    const third = r.nameOf('Lato')!;
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
    expect([...h.names()]).toEqual([[third, 1]]);
  });

  it('loads a family without its broken face, then retries it with backoff and announces the late load', async () => {
    const h = fakeHost({ failData: new Set(['bold']) });
    const r = new FontResolver(h.host);
    const changes: { families: string[]; late: boolean }[] = [];
    r.onChange((c) => changes.push(c));
    const res = await r.sync([face('Roboto', 'reg'), face('Roboto', 'bold', 700)]);
    expect(res.loaded).toBe(1);
    expect(res.failed).toEqual(['Roboto 700: file unavailable']);
    const partial = r.nameOf('Roboto')!;
    expect(partial).toBe(internalFamilyName('', 'Roboto', ['reg|400|normal|']));
    expect(changes).toEqual([{ families: ['roboto'], late: false }]);
    // Still failing at the first retry (2 s): backs off to 4 s.
    await h.advance(2000);
    expect(h.reads.filter((x) => x === 'bold')).toHaveLength(2);
    await h.advance(2000);
    expect(h.reads.filter((x) => x === 'bold')).toHaveLength(2);
    // The file arrives; the next retry registers both faces under a new name.
    h.failData.clear();
    const gen = r.generation;
    await h.advance(2000);
    const full = r.nameOf('Roboto')!;
    expect(full).not.toBe(partial);
    expect(r.generation).toBe(gen + 1);
    expect(changes.at(-1)).toEqual({ families: ['roboto'], late: true });
    expect([...h.names()]).toEqual([[full, 2]]);
    expect(r.stats()).toEqual({ loaded: 2, failed: [] });
    expect(h.pending()).toBe(0);
  });

  it('retries failed faces at once on the next sync, and drops faces that fail to parse', async () => {
    const h = fakeHost({ failParse: new Set(['bad']) });
    const r = new FontResolver(h.host);
    const res = await r.sync([face('Gelasio', 'bad')]);
    expect(res).toEqual({ loaded: 0, failed: ['Gelasio 400: bad font data'], ready: [] });
    expect(r.isLoaded('Gelasio')).toBe(false);
    expect(h.set.size).toBe(0);
    h.failParse.clear();
    expect((await r.sync([face('Gelasio', 'bad')])).loaded).toBe(1);
    expect(r.isLoaded('gelasio')).toBe(true);
  });

  it('keeps families a later list leaves out, without retrying them', async () => {
    const h = fakeHost({ failData: new Set(['x2']) });
    const r = new FontResolver(h.host);
    await r.sync([face('Service Font', 'x1'), face('Service Font', 'x2', 700)]);
    await r.sync([face('Config Font', 'c1')]);
    expect(r.isLoaded('Service Font')).toBe(true);
    expect(r.isLoaded('Config Font')).toBe(true);
    expect(h.pending()).toBe(0);
    expect(r.stats()).toEqual({ loaded: 2, failed: [] });
  });

  it('runs the rounds of one family in order when lists arrive while loading', async () => {
    const h = fakeHost();
    const r = new FontResolver(h.host);
    const a = r.sync([face('Merriweather', 'm1')]);
    const b = r.sync([face('Merriweather', 'm1'), face('Merriweather', 'm2', 700)]);
    await Promise.all([a, b]);
    expect(r.nameOf('Merriweather')).toBe(
      internalFamilyName('', 'Merriweather', ['m1|400|normal|', 'm2|700|normal|']),
    );
    expect([...h.names().values()]).toEqual([2]);
  });

  it('passes unicode-range, keeps scoped faces apart and ignores malformed entries', async () => {
    const h = fakeHost();
    const r = new FontResolver(h.host);
    const res = await r.sync([
      { ...face('Noto Sans', 'cyr'), unicodeRange: 'U+0400-045F' },
      { ...face('Calibri', 'emb'), scope: 'pres-1' },
      { ...face('', 'x') },
      { family: 'Y' } as FontFile,
    ]);
    expect(res.loaded).toBe(2);
    expect([...h.set].find((f) => f.data instanceof ArrayBuffer && f.desc.unicodeRange)?.desc).toEqual({
      weight: '400',
      style: 'normal',
      unicodeRange: 'U+0400-045F',
    });
    // A deck-embedded face is registered, but only its own presentation may use it (M8).
    expect(r.isLoaded('Calibri')).toBe(false);
    expect(r.isLoaded('Calibri', 'pres-1')).toBe(true);
  });

  it('hands a URL source to the face factory', async () => {
    const h = fakeHost();
    const r = new FontResolver(h.host);
    await r.sync([face('Remote', 'url:/api/v1/files/abc')]);
    expect([...h.set][0]!.data).toBe('/api/v1/files/abc');
  });

  it('reports every face failed where there is no face set, and never schedules a retry', async () => {
    const h = fakeHost();
    const r = new FontResolver({ ...h.host, set: undefined });
    const res = await r.sync([face('Lato', 'a')]);
    expect(res.failed).toEqual(['Lato 400: no font face set here']);
    expect(h.pending()).toBe(0);
    expect(new FontResolver().font(req('Lato'))).toContain('"Lato"');
  });

  it('accepts faces registered elsewhere (loaded) and stops retrying when disposed', async () => {
    const r = new FontResolver();
    r.loaded({ family: 'Golden', internal: 'o0000beef' });
    expect(r.generation).toBe(1);
    expect(r.font(req('golden'))).toContain('"o0000beef"');
    const h = fakeHost({ failData: new Set(['z']) });
    const r2 = new FontResolver(h.host);
    await r2.sync([face('Z', 'z')]);
    expect(h.pending()).toBe(1);
    r2.dispose();
    expect(h.pending()).toBe(0);
  });
});

describe('drawers through the installed resolver', () => {
  const style = {
    ...DEFAULT_LYRIC_STYLE,
    fontFamily: 'Open Sans',
    fontSizePx: 50,
    fontStyle: 'italic' as const,
  };

  it('legacy fontString is byte for byte today’s string without a resolver', () => {
    expect(fontString(style, 0.5)).toBe(
      'italic 700 25px "Open Sans", "Inter", "Segoe UI", Arial, sans-serif',
    );
    expect(fontString(style, 2, 10, 'Hebr')).toBe(
      'italic 700 20px "Open Sans", "Inter", "Segoe UI", Arial, sans-serif',
    );
  });

  it('legacy fontString resolves through the installed resolver, with the script fallback', async () => {
    const h = fakeHost();
    const r = new FontResolver(h.host);
    await r.sync([face('Open Sans', 'os', 700, 'italic'), face('Noto Sans Hebrew', 'he')]);
    installFontEnv(r);
    expect(fontString(style, 0.5)).toBe(
      `italic 700 25px "${r.nameOf('Open Sans')}", "Inter", "Segoe UI", Arial, sans-serif`,
    );
    expect(fontString(style, 1, 30, 'Hebr')).toContain(`"${r.nameOf('Noto Sans Hebrew')}"`);
  });

  it('a face loaded after a first layout is used by the next one (the memo follows the generation)', async () => {
    const h = fakeHost({ failData: new Set(['late']) });
    const r = new FontResolver(h.host);
    await r.sync([face('Late Sans', 'late')]);
    const o: TextObject = {
      id: 't',
      type: 'text',
      box: { x: 0, y: 0, w: 800, h: 200, rotation: 0 },
      text: 'Amazing grace',
      style: { ...style, fontStyle: 'normal', fontFamily: 'Late Sans', lineModel: 'office' },
      opacity: 1,
    };
    const m = testMeasurer();
    const before = layoutRich(m, o, r);
    expect(before.lines[0]!.segs[0]!.font).toContain('"Late Sans"');
    expect(layoutRich(m, o, r)).toBe(before);
    h.failData.clear();
    await h.advance(2000);
    const after = layoutRich(m, o, r);
    expect(after).not.toBe(before);
    expect(after.lines[0]!.segs[0]!.font).toContain(`"${r.nameOf('Late Sans')}"`);
    expect(after.lines[0]!.segs[0]!.font).not.toContain('"Late Sans"');
  });
});

describe('families a job draws with', () => {
  it('cover run, bullet and fallback fonts; Inter is not a system fallback', () => {
    const text: TextObject = {
      id: 't',
      type: 'text',
      box: { x: 0, y: 0, w: 800, h: 200, rotation: 0 },
      text: '17 For God\nso loved',
      style: {
        ...DEFAULT_LYRIC_STYLE,
        fontFamily: 'Calibri',
        fallbackFonts: ['Carlito', 'Noto Sans Hebrew'],
      },
      opacity: 1,
      runs: [{ start: 0, end: 2, fontFamily: 'Georgia', baseline: 0.3 }],
      paras: [{ bullet: { char: '•', fontFamily: 'Arial' } }, null],
    };
    const job: AssetJob = {
      kind: 'slide',
      layer: 1,
      key: 'k',
      cueIndex: 0,
      slide: { id: 's', objects: [text] },
      isSong: false,
      look: LOOK_MAIN,
      images: {},
    };
    expect(jobFontFamilies(job).sort()).toEqual([
      'arial',
      'calibri',
      'carlito',
      'georgia',
      'noto sans hebrew',
    ]);
    // What the asset worker reports when not loaded: the families text asks for.
    expect(jobFontFamilies(job, { fallbacks: false }).sort()).toEqual(['arial', 'calibri', 'georgia']);
    expect(FALLBACK_FAMILIES.has('inter')).toBe(false);
    expect(FALLBACK_FAMILIES.has('arial')).toBe(true);
  });
});
