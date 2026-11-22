import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecipeWire } from '../src/pptx/raster-recipe.ts';
import { RasterBrowser, rasterArgs } from '../src/pptx/rasterPage.ts';
import {
  anyServiceLive,
  drawRasters,
  RASTER_LIMITS_HUB,
  RASTER_PAGE_MS,
  RASTER_PDF_ROUTE,
  RASTER_WITH_LIBREOFFICE,
  type RasterDeps,
  type RasterItem,
  type RasterSession,
  rasterOffReason,
  rastersFor,
  WATCH_MS,
} from '../src/pptx/rasters.ts';
import { goldenRecipe } from './raster.recipes.test-util.ts';
import { makeStub } from './stub-chromium.test-util.ts';

/*
 * The maker side (RM-H1 to RM-H6, RM-D3 to RM-D5): the ladder, the loop with its live-safety rules, and the driver's
 * process rules, with STUB browsers (a fake session, or a stand-in executable that speaks the DevTools pipe), so no
 * Chromium is needed. The real Chromium is pptx-raster-page.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
let scratch = '';
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ordo-raster-maker-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const dummyPage = () => {
  const f = join(scratch, 'dummy-page.js');
  writeFileSync(f, '');
  return f;
};

/** A recipe that is small and valid, one per hash. */
const recipeFor = (n: number): RecipeWire => ({ ...goldenRecipe(), box: { x: n, y: 0, w: 40, h: 30 } });
const items = (n: number): RasterItem[] =>
  Array.from({ length: n }, (_, i) => ({ hash: `h${i}`.padEnd(8, '0'), recipe: recipeFor(i) }));
const fonts = async () => [];
const okDraw = (r: { w: number; h: number }) => ({
  ok: true as const,
  png: new Uint8Array(8),
  w: r.w,
  h: r.h,
  ms: 1,
});

/** A pacing object whose state the test flips. */
const pacing = (live = false) => {
  const p = { live, holding: () => p.live };
  return p;
};

/** Fake time for the live watcher: `setTimer` is the loop's, `advance` runs the due timers in steps of 50 ms. */
function fakeTime() {
  const timers: { fn: () => void; at: number }[] = [];
  let now = 0;
  return {
    get now() {
      return now;
    },
    get armed() {
      return timers.length;
    },
    setTimer(fn: () => void, ms: number) {
      const t = { fn, at: now + ms };
      timers.push(t);
      return () => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
      };
    },
    advance(ms: number) {
      for (let left = ms; left > 0; left -= 50) {
        now += Math.min(50, left);
        for (const t of [...timers].sort((a, b) => a.at - b.at))
          if (t.at <= now && timers.includes(t)) {
            timers.splice(timers.indexOf(t), 1);
            t.fn();
          }
      }
    },
  };
}

/** A fake session and its launch log. */
function fakeSessions(draw: (call: number, file: string) => Promise<unknown> | unknown = () => 'ok') {
  const log = { launches: 0, closes: 0, draws: 0, files: [] as string[] };
  const launch = async (): Promise<RasterSession> => {
    log.launches++;
    return {
      async draw(file) {
        const call = ++log.draws;
        log.files.push(file);
        const r = await draw(call, file);
        if (r === 'ok') return okDraw({ w: 80, h: 60 });
        return r as never;
      },
      async close() {
        log.closes++;
      },
    };
  };
  return { log, launch };
}

describe('the maker ladder (RM-H1)', () => {
  const base = { prerender: true, lo: false, chromium: true, poppler: false };

  it("answers the matrix: Chromium first, LibreOffice as today, else today's boxes", () => {
    expect(rastersFor(base)).toBe('page');
    // A hub with LibreOffice keeps LibreOffice's art while RASTER_WITH_LIBREOFFICE is false (M-SR5), and says so.
    expect(rastersFor({ ...base, lo: true })).toBe(RASTER_WITH_LIBREOFFICE ? 'page' : 'off');
    expect(rasterOffReason({ ...base, lo: true })).toBe(RASTER_WITH_LIBREOFFICE ? undefined : 'libreoffice');
    expect(rastersFor({ ...base, poppler: true })).toBe('page');
    // no Chromium: no maker (the PDF route was not built), and the report line depends on LibreOffice
    expect(rastersFor({ ...base, chromium: false, poppler: true })).toBe('off');
    expect(rasterOffReason({ ...base, chromium: false, poppler: true })).toBe('no-maker');
    expect(rasterOffReason({ ...base, chromium: false })).toBe('no-maker');
    expect(rastersFor({ ...base, chromium: false, lo: true })).toBe('off');
    expect(rasterOffReason({ ...base, chromium: false, lo: true })).toBe('libreoffice');
    // a maker present: no off reason
    expect(rasterOffReason(base)).toBeUndefined();
  });

  it("a Reset slide and the switch off are 'off' without a report line", () => {
    for (const chromium of [true, false])
      for (const lo of [true, false])
        for (const poppler of [true, false]) {
          const a = { prerender: true, lo, chromium, poppler };
          expect(rastersFor({ ...a, request: 'off' })).toBe('off');
          expect(rasterOffReason({ ...a, request: 'off' })).toBeUndefined();
          expect(rastersFor({ ...a, prerender: false })).toBe('off');
          expect(rasterOffReason({ ...a, prerender: false })).toBeUndefined();
        }
  });

  it('pins its constants (the planner reads them)', () => {
    expect(RASTER_LIMITS_HUB).toEqual({ perImport: 200, importMs: 300_000, importBytes: 268_435_456 });
    expect(RASTER_PAGE_MS).toBe(60_000);
    expect(WATCH_MS).toBe(250);
    // shape-raster-2's measure M-SR5 (Q53.j): a hub with LibreOffice keeps LibreOffice's art, the own picture scores lower there.
    expect(RASTER_WITH_LIBREOFFICE).toBe(false);
    expect(RASTER_PDF_ROUTE).toBe(false);
  });

  it('anyServiceLive reads the pacing state; a hub with no pacing object is not live', () => {
    expect(anyServiceLive({ jobs: {} })).toBe(false);
    expect(anyServiceLive({ jobs: { pacing: pacing(true) } })).toBe(true);
    expect(anyServiceLive({ jobs: { pacing: pacing(false) } })).toBe(false);
  });
});

describe('the drawing loop (RM-H2, RM-H3)', () => {
  const run = (
    deps: Partial<RasterDeps>,
    list: RasterItem[],
    over: Partial<Parameters<typeof drawRasters>[2]> = {},
  ) => {
    const accepted: string[] = [];
    const controller = new AbortController();
    const result = drawRasters({ jobs: {}, ...deps }, list, {
      workDir: scratch,
      signal: controller.signal,
      fonts,
      accept: async (d) => {
        accepted.push(d.hash);
        return { ok: true };
      },
      ...over,
    });
    return { result, accepted, controller };
  };

  it('draws every picture in order and hands each to accept', async () => {
    const s = fakeSessions();
    const r = run({ launch: s.launch }, items(3));
    expect(await r.result).toEqual({ made: 3, failed: new Map() });
    expect(r.accepted).toEqual(['h0000000', 'h1000000', 'h2000000']);
    expect(s.log).toMatchObject({ launches: 1, closes: 1, draws: 3 });
  });

  it('a refused picture is in failed and the loop goes on; a recipe the validator refuses never reaches the browser', async () => {
    const s = fakeSessions();
    const list = items(3);
    list[1] = { hash: 'bad00000', recipe: { ...recipeFor(1), density: 3 } as never };
    const r = run({ launch: s.launch }, list, {
      accept: async (d) => (d.hash === 'h2000000' ? { ok: false, reason: 'too big' } : { ok: true }),
    });
    const out = await r.result;
    expect(out.made).toBe(1);
    expect(out.failed.get('bad00000')).toBe('recipe');
    expect(out.failed.get('h2000000')).toBe('too big');
    expect(out.stopped).toBeUndefined();
    expect(s.log.draws).toBe(2);
  });

  it('stop: true ends the loop and leaves every later item undrawn (not in failed)', async () => {
    const s = fakeSessions();
    const out = await run({ launch: s.launch }, items(5), {
      accept: async (d) =>
        d.hash === 'h1000000' ? { ok: false, reason: 'byte cap', stop: true } : { ok: true },
    }).result;
    expect(out.made).toBe(1);
    expect(out.stopped).toBe('byte cap');
    expect([...out.failed.keys()]).toEqual(['h1000000']);
    expect(s.log.draws).toBe(2);
  });

  it("no browser: every picture is 'no-browser'", async () => {
    const out = await run({ launch: () => Promise.reject(new Error('no Chromium')) }, items(3)).result;
    expect(out.made).toBe(0);
    expect(out.stopped).toBe('no-browser');
    expect([...out.failed.values()]).toEqual(['no-browser', 'no-browser', 'no-browser']);
  });

  it('a page error, an empty picture and a timeout each give their reason and the loop goes on', async () => {
    const s = fakeSessions((call) => {
      if (call === 1) return { ok: false, reason: 'page', detail: 'boom' };
      if (call === 2) return { ok: false, reason: 'empty' };
      if (call === 3) return { ok: false, reason: 'timeout' };
      return 'ok';
    });
    const out = await run({ launch: s.launch }, items(4)).result;
    expect(out.made).toBe(1);
    expect([...out.failed.entries()]).toEqual([
      ['h0000000', 'page'],
      ['h1000000', 'empty'],
      ['h2000000', 'timeout'],
    ]);
    // a timeout kills the browser, so the next picture has a fresh one
    expect(s.log.launches).toBe(2);
  });

  it('an aborted signal makes nothing and starts no browser', async () => {
    const s = fakeSessions();
    const controller = new AbortController();
    controller.abort();
    const out = await drawRasters({ jobs: {}, launch: s.launch }, items(2), {
      workDir: scratch,
      signal: controller.signal,
      fonts,
      accept: async () => ({ ok: true }),
    });
    expect(out).toEqual({ made: 0, failed: new Map(), stopped: 'aborted' });
    expect(s.log.launches).toBe(0);
  });

  it('RM-H3: one session a call, closed on every path, an exception in accept included', async () => {
    const s = fakeSessions();
    const out = await run({ launch: s.launch }, items(3), {
      accept: async () => {
        throw new Error('disk full');
      },
    }).result;
    expect(out.stopped).toBe('accept');
    expect(s.log).toMatchObject({ launches: 1, closes: 1 });
    const t = fakeSessions();
    await run({ launch: t.launch }, items(2)).result;
    expect(t.log).toMatchObject({ launches: 1, closes: 1 });
    const none = fakeSessions();
    await run({ launch: none.launch }, []).result;
    expect(none.log.launches).toBe(0);
  });

  it('stops at the wall-time budget between pictures', async () => {
    const s = fakeSessions();
    let t = 0;
    const out = await run({ launch: s.launch }, items(4), { budgetMs: 1000, now: () => (t += 600) }).result;
    expect(out.stopped).toBe('budget');
    expect(out.made).toBeGreaterThan(0);
    expect(out.made).toBeLessThan(4);
  });
});

describe('no picture starts while a service is live (RM-H4)', () => {
  it('a live service before the first picture: nothing is drawn, no browser is started', async () => {
    const s = fakeSessions();
    const out = await drawRasters({ jobs: { pacing: pacing(true) }, launch: s.launch }, items(3), {
      workDir: scratch,
      signal: new AbortController().signal,
      fonts,
      accept: async () => ({ ok: true }),
    });
    expect(out).toEqual({ made: 0, failed: new Map(), stopped: 'live' });
    expect(s.log.launches).toBe(0);
  });

  it('a service that goes live (or is in its grace) between pictures leaves the rest undrawn', async () => {
    const p = pacing(false);
    const s = fakeSessions();
    const out = await drawRasters({ jobs: { pacing: p }, launch: s.launch }, items(4), {
      workDir: scratch,
      signal: new AbortController().signal,
      fonts,
      accept: async (d) => {
        if (d.hash === 'h1000000') p.live = true;
        return { ok: true };
      },
    });
    expect(out.made).toBe(2);
    expect(out.stopped).toBe('live');
    expect(out.failed.size).toBe(0);
    expect(s.log.draws).toBe(2);
  });
});

describe('a service that goes live while the browser is starting (RM-H4b)', () => {
  const opts = (over: Partial<Parameters<typeof drawRasters>[2]> = {}) => ({
    workDir: scratch,
    signal: new AbortController().signal,
    fonts,
    accept: async () => ({ ok: true as const }),
    ...over,
  });

  it('the watcher is armed before the launch: a start that takes seconds is cut within one watcher period', async () => {
    const p = pacing(false);
    const ft = fakeTime();
    let killedAt = -1;
    let launches = 0;
    // a launch like the driver's: it hears the signal, kills its browser and fails
    const launch = (_dir: string, signal: AbortSignal) =>
      new Promise<RasterSession>((_, reject) => {
        launches++;
        signal.addEventListener(
          'abort',
          () => {
            killedAt = ft.now;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    const done = drawRasters({ jobs: { pacing: p }, launch }, items(3), opts({ setTimer: ft.setTimer }));
    expect(launches).toBe(1);
    expect(ft.armed).toBe(1);
    // no service live: the launch is left alone
    ft.advance(200);
    expect(killedAt).toBe(-1);
    p.live = true;
    const liveAt = ft.now;
    ft.advance(WATCH_MS);
    expect(killedAt).toBeGreaterThan(liveAt);
    expect(killedAt - liveAt).toBeLessThanOrEqual(WATCH_MS);
    // nothing was drawn, no picture is called failed (none began), and the watcher is not left armed
    expect(await done).toEqual({ made: 0, failed: new Map(), stopped: 'live' });
    expect(ft.armed).toBe(0);
  });

  it('a launch that does not hear the cut still ends there: the browser that came up is closed and no picture starts', async () => {
    const p = pacing(false);
    const s = fakeSessions();
    let up: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      up = r;
    });
    const launch = async () => {
      await gate;
      return s.launch();
    };
    const ft = fakeTime();
    const done = drawRasters({ jobs: { pacing: p }, launch }, items(3), opts({ setTimer: ft.setTimer }));
    // the service goes live before the next watcher tick, then the browser comes up
    p.live = true;
    up();
    expect(await done).toEqual({ made: 0, failed: new Map(), stopped: 'live' });
    expect(s.log).toMatchObject({ launches: 1, draws: 0, closes: 1 });
    expect(ft.armed).toBe(0);
  });

  it("a job abort while the browser starts is 'aborted', with no picture called failed", async () => {
    const controller = new AbortController();
    const ft = fakeTime();
    const launch = (_dir: string, signal: AbortSignal) =>
      new Promise<RasterSession>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const done = drawRasters(
      { jobs: {}, launch },
      items(2),
      opts({ signal: controller.signal, setTimer: ft.setTimer }),
    );
    controller.abort();
    expect(await done).toEqual({ made: 0, failed: new Map(), stopped: 'aborted' });
    expect(ft.armed).toBe(0);
  });
});

describe('the driver with a stand-in browser (RM-D3, RM-D4, RM-D5, RM-H5)', () => {
  let stub: ReturnType<typeof makeStub>;
  beforeAll(() => {
    stub = makeStub(join(scratch, 'stub'));
  });

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const pids = (): { main: number; child: number }[] =>
    existsSync(stub.pidsFile)
      ? readFileSync(stub.pidsFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [main, child] = l.split(' ').map(Number);
            return { main: main!, child: child! };
          })
      : [];
  const until = async (check: () => boolean, ms = 8000) => {
    const t0 = Date.now();
    while (!check()) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it('RM-D3: spawned niced in its own group with the memory flag and no port; close kills the whole group', async () => {
    stub.setMode('ok');
    const args = rasterArgs('/tmp/profile', { memoryMb: 700 });
    expect(args.some((a) => a.includes('remote-debugging-port'))).toBe(false);
    expect(args).toContain('--remote-debugging-pipe');
    expect(args).toContain('--js-flags=--max-old-space-size=700');
    expect(args).toContain('--host-resolver-rules=MAP * ~NOTFOUND');
    expect(args).toContain('--no-sandbox');
    expect(rasterArgs('/tmp/profile', { sandbox: true })).not.toContain('--no-sandbox');
    expect(rasterArgs('/tmp/profile', { noDevShm: true })).toContain('--disable-dev-shm-usage');

    const seen: { cmd: string; args: readonly string[]; detached: unknown }[] = [];
    const spy = ((cmd: string, a: readonly string[], o: { detached?: boolean }) => {
      seen.push({ cmd, args: a, detached: o.detached });
      return spawn(cmd, a as string[], o as never);
    }) as typeof spawn;
    const before = pids().length;
    const work = join(scratch, 'd3');
    const b = await RasterBrowser.launch(stub.exe, work, {
      signal: new AbortController().signal,
      spawnFn: spy,
      pageFile: dummyPage(),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cmd).toBe('nice');
    expect(seen[0]!.args.slice(0, 3)).toEqual(['-n', '19', stub.exe]);
    expect(seen[0]!.detached).toBe(true);
    await until(() => pids().length > before);
    const { main, child } = pids().at(-1)!;
    expect(main).toBe(b.pid);
    expect(alive(child)).toBe(true);
    await b.close();
    await until(() => !alive(main) && !alive(child), 3000);
    // no profile folder or temp file is left
    expect(readdirSync(work).filter((n) => n.startsWith('profile-'))).toEqual([]);
  });

  it('RM-D4: one browser at a time hub-wide: two loops never overlap two launches', async () => {
    stub.setMode('ok');
    let active = 0;
    let most = 0;
    const spy = ((cmd: string, a: readonly string[], o: object) => {
      const p: ChildProcess = spawn(cmd, a as string[], o as never);
      active++;
      most = Math.max(most, active);
      p.once('exit', () => active--);
      return p;
    }) as typeof spawn;
    const deps: RasterDeps = {
      jobs: {},
      chromium: stub.exe,
      pageFile: dummyPage(),
      launch: (dir, signal) =>
        RasterBrowser.launch(stub.exe, dir, {
          signal,
          spawnFn: spy,
          pageFile: dummyPage(),
        }) as Promise<RasterSession>,
    };
    const go = () =>
      drawRasters(deps, items(2), {
        workDir: scratch,
        signal: new AbortController().signal,
        fonts,
        accept: async () => ({ ok: true }),
      });
    const [a, b] = await Promise.all([go(), go()]);
    expect(a.made).toBe(2);
    expect(b.made).toBe(2);
    expect(most).toBe(1);
  });

  it("RM-D5: a crashed browser is relaunched once, then the rest of the run is 'crash'", async () => {
    stub.setMode('crash');
    let launches = 0;
    const deps: RasterDeps = {
      jobs: {},
      launch: (dir, signal) => {
        launches++;
        return RasterBrowser.launch(stub.exe, dir, {
          signal,
          pageFile: dummyPage(),
        }) as Promise<RasterSession>;
      },
    };
    const out = await drawRasters(deps, items(3), {
      workDir: scratch,
      signal: new AbortController().signal,
      fonts,
      accept: async () => ({ ok: true }),
    });
    expect(launches).toBe(2);
    expect(out.made).toBe(0);
    expect(out.stopped).toBe('crash');
    expect([...out.failed.values()]).toEqual(['crash', 'crash', 'crash']);
    stub.setMode('ok');
  });

  it('RM-H5: a picture in progress is stopped when a service goes live, and the whole group is killed', async () => {
    stub.setMode('hang');
    const p = pacing(false);
    // fake time: the watcher's timer is ours
    const timers: { fn: () => void; at: number; id: number }[] = [];
    let now = 0;
    let next = 0;
    const setTimer = (fn: () => void, ms: number) => {
      const t = { fn, at: now + ms, id: ++next };
      timers.push(t);
      return () => {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
      };
    };
    const advance = (ms: number) => {
      now += ms;
      for (const t of [...timers].sort((a, b) => a.at - b.at))
        if (t.at <= now && timers.includes(t)) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
    };
    const before = pids().length;
    let drawing = false;
    const deps: RasterDeps = {
      jobs: { pacing: p },
      launch: async (dir, signal) => {
        const s = await RasterBrowser.launch(stub.exe, dir, { signal, pageFile: dummyPage() });
        return {
          draw: (file, f, o) => {
            drawing = true;
            return s.draw(file, f, o);
          },
          close: () => s.close(),
        };
      },
    };
    const done = drawRasters(deps, items(3), {
      workDir: scratch,
      signal: new AbortController().signal,
      fonts,
      accept: async () => ({ ok: true }),
      setTimer,
    });
    await until(() => pids().length > before && drawing);
    const { main, child } = pids().at(-1)!;
    // no service live: the watcher looks and leaves the picture alone (the stub never answers)
    for (let i = 0; i < 8; i++) advance(250);
    expect(alive(main)).toBe(true);
    p.live = true;
    advance(250);
    const out = await done;
    expect(out.stopped).toBe('live');
    expect(out.failed.get('h0000000')).toBe('live');
    expect(out.made).toBe(0);
    // the browser and its child are gone, the later pictures were left undrawn
    await until(() => !alive(main) && !alive(child), 3000);
    expect(out.failed.size).toBe(1);
    stub.setMode('ok');
  });

  it('RM-H5b: a service that goes live while Chromium is still starting kills the whole group at the next watcher tick', async () => {
    stub.setMode('hang-launch');
    const p = pacing(false);
    const ft = fakeTime();
    const before = pids().length;
    const controller = new AbortController();
    const done = drawRasters({ jobs: { pacing: p }, chromium: stub.exe, pageFile: dummyPage() }, items(3), {
      workDir: scratch,
      signal: controller.signal,
      fonts,
      accept: async () => ({ ok: true }),
      setTimer: ft.setTimer,
    });
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    try {
      await until(() => pids().length > before && ft.armed > 0);
      const { main, child } = pids().at(-1)!;
      // the browser never answers its first call: the launch is still going on when the ticks look
      for (let i = 0; i < 4; i++) ft.advance(WATCH_MS);
      expect(alive(main)).toBe(true);
      expect(finished).toBe(false);
      p.live = true;
      ft.advance(WATCH_MS);
      await until(() => finished, 3000);
      expect(await done).toEqual({ made: 0, failed: new Map(), stopped: 'live' });
      await until(() => !alive(main) && !alive(child), 3000);
    } finally {
      // a failure must not leave the hub-wide browser slot held for the tests after this one
      controller.abort();
      await done.catch(() => undefined);
      stub.setMode('ok');
    }
  });

  it("RM-D6: a hung page is stopped by the deadline (fake time): 'timeout', the whole group killed", async () => {
    stub.setMode('hang');
    const before = pids().length;
    let fire: () => void = () => undefined;
    const timer = (fn: () => void, ms: number) => {
      expect(ms).toBe(RASTER_PAGE_MS);
      fire = fn;
      return () => undefined;
    };
    const b = await RasterBrowser.launch(stub.exe, join(scratch, 'd6'), {
      signal: new AbortController().signal,
      pageFile: dummyPage(),
    });
    await until(() => pids().length > before);
    const { main, child } = pids().at(-1)!;
    const file = join(scratch, 'd6.json');
    writeFileSync(file, JSON.stringify(recipeFor(0)));
    const drawing = b.draw(file, [], { timer });
    await new Promise((r) => setTimeout(r, 50));
    fire();
    const r = await drawing;
    expect(r).toEqual({ ok: false, reason: 'timeout' });
    await until(() => !alive(main) && !alive(child), 3000);
    await b.close();
    stub.setMode('ok');
  });

  it("a picture the job aborts is 'aborted' and kills the group too", async () => {
    stub.setMode('hang');
    const before = pids().length;
    const controller = new AbortController();
    // Wait until the browser is up and drawing has begun: that is the moment to abort (an abort
    // during the launch is a different path, 'aborted' with no picture begun).
    let drawing = false;
    const done = drawRasters(
      {
        jobs: {},
        launch: async (dir, signal) => {
          const s = await RasterBrowser.launch(stub.exe, dir, { signal, pageFile: dummyPage() });
          return {
            draw: (file, f, o) => {
              drawing = true;
              return s.draw(file, f, o);
            },
            close: () => s.close(),
          };
        },
      },
      items(2),
      {
        workDir: scratch,
        signal: controller.signal,
        fonts,
        accept: async () => ({ ok: true }),
        setTimer: () => () => undefined,
      },
    );
    await until(() => pids().length > before && drawing);
    const { main, child } = pids().at(-1)!;
    controller.abort();
    const out = await done;
    expect(out.stopped).toBe('aborted');
    expect(out.failed.get('h0000000')).toBe('aborted');
    await until(() => !alive(main) && !alive(child), 3000);
    stub.setMode('ok');
  });
});

describe('where the raster modules are used (RM-H6)', () => {
  /** Hub source files that import a raster module. */
  function importers(): string[] {
    const src = join(here, '../src');
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, name.name);
        if (name.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name.name)) {
          const text = readFileSync(path, 'utf8');
          if (/from\s+['"][^'"]*\/(?:rasters|rasterPage|raster-page|raster-recipe)(?:\.ts)?['"]/.test(text))
            out.push(relative(src, path));
        }
      }
    };
    walk(src);
    return out.sort();
  }

  it('only the hub import job and the raster modules themselves import them; nothing on a GO path or in a service does', () => {
    const allowed = new Set([
      'pptx/rasters.ts',
      'pptx/rasterPage.ts',
      'pptx/raster-page.ts',
      'pptx/raster-recipe.ts',
      // the planner's import job (the picture step runs inside the light import jobs only)
      'pptx/rasterStore.ts',
      'pptx/nativeJob.ts',
      'pptx/reimport.ts',
    ]);
    expect(importers().filter((f) => !allowed.has(f))).toEqual([]);
  });

  it('no source of the hub opens a DevTools port', () => {
    const src = join(here, '../src/pptx');
    for (const name of ['rasterPage.ts', 'rasters.ts', 'raster-page.ts', 'raster-recipe.ts']) {
      const code = readFileSync(join(src, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code, name).not.toMatch(/remote-debugging-port/);
    }
  });
});
