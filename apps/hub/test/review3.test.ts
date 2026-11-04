/**
 * Fixes from the third review, hub side: a large ProPresenter library is decoded in batches that fit the
 * CPU pool's worker heap (H1), silent starts have their own budget and a known boot time shortens the
 * start grace (H2), an output token that the live process cannot check yet gets `bye retry` (H4), and a
 * backup without its manifest is still found (H5).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { importPro7, pro7Type } from '@ordo/importers';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { findBackup } from '../src/backup.ts';
import type { HubConfig } from '../src/config.ts';
import {
  importPro7Batched,
  importPro7InWorker,
  PRO7_BATCH_DOCS,
  type Pro7ImportOptions,
  type Pro7Result,
} from '../src/imports.ts';
import { createLibraryProcess, type LibraryProcess } from '../src/libproc.ts';
import { createLiveProcess, type LiveProcess } from '../src/liveproc.ts';
import { WORKER_LIMITS } from '../src/pool.ts';
import { MAX_SILENT_STARTS, Supervisor } from '../src/supervisor.ts';
import { byType, connectWs, EDIT_PIN, OPERATE_PIN, sleep, tempDir } from './helpers.ts';

const here = dirname(fileURLToPath(import.meta.url));

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _e, cb) {
      for (const l of String(chunk).split('\n')) if (l) lines.push(l);
      cb();
    },
  });
  return {
    log: pino({ level: 'info' }, stream),
    lines,
    has: (re: RegExp) => lines.some((l) => re.test(l)),
    count: (re: RegExp) => lines.filter((l) => re.test(l)).length,
  };
}

async function until(fn: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// --- H1: batched ProPresenter decode ------------------------------------------------------------------

const enc = new TextEncoder();
const uuid = (s: string) => ({ string: s });
const rtf = (text: string) =>
  enc.encode(
    `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639\n{\\fonttbl\\f0\\fnil\\fcharset0 HelveticaNeue-Bold;}\n` +
      `{\\colortbl;\\red255\\green255\\blue255;}\n\\pard\\qc\\partightenfactor0\n\n\\f0\\fs160 \\cf1 ${text.replace(/\n/g, '\\\n')}}`,
  );

function textCue(id: string, text: string, media?: string) {
  const actions: Record<string, unknown>[] = [
    {
      uuid: uuid(`A-${id}`),
      type: 'ACTION_TYPE_PRESENTATION_SLIDE',
      isEnabled: true,
      slide: {
        presentation: {
          baseSlide: {
            size: { width: 1920, height: 1080 },
            uuid: uuid(`S-${id}`),
            elements: [
              {
                element: {
                  uuid: uuid(`E-${id}`),
                  name: 'Lyrics',
                  bounds: { origin: { x: 100, y: 150 }, size: { width: 1720, height: 780 } },
                  opacity: 1,
                  text: { rtfData: rtf(text), verticalAlignment: 'VERTICAL_ALIGNMENT_MIDDLE' },
                },
              },
            ],
          },
        },
      },
    },
  ];
  if (media)
    actions.push({
      uuid: uuid(`M-${id}`),
      type: 'ACTION_TYPE_MEDIA',
      isEnabled: true,
      media: {
        layerType: 'LAYER_TYPE_BACKGROUND',
        element: {
          uuid: uuid(`ME-${id}`),
          url: { absoluteString: `file:///Users/worship/Documents/ProPresenter/Media/${encodeURI(media)}` },
        },
      },
    });
  return { uuid: uuid(id), name: '', isEnabled: true, actions };
}

/** A song document encoded with the importer's own proto: two cues, every fifth with a background. */
function songDoc(n: number): Uint8Array {
  const T = pro7Type('rv.data.Presentation');
  const obj = {
    applicationInfo: { platform: 'PLATFORM_MACOS', application: 'APPLICATION_PROPRESENTER' },
    uuid: uuid(`P-${n}`),
    name: `Song ${n}`,
    category: 'Songs',
    cues: [
      textCue(`C-${n}-1`, `Verse one of song ${n}\nline two`, n % 5 === 0 ? `bg${n % 3}.png` : undefined),
      textCue(`C-${n}-2`, `Chorus of song ${n}\nline two`),
    ],
    cueGroups: [
      { group: { uuid: uuid(`G-${n}-V`), name: 'Verse 1' }, cueIdentifiers: [uuid(`C-${n}-1`)] },
      { group: { uuid: uuid(`G-${n}-C`), name: 'Chorus' }, cueIdentifiers: [uuid(`C-${n}-2`)] },
    ],
  };
  const err = T.verify(T.fromObject(obj));
  if (err) throw new Error(err);
  return T.encode(T.fromObject(obj)).finish();
}

/** A playlist document referencing documents by path (across batches) and one by name. */
function playlistDoc(byPath: number[], byName: number[]): Uint8Array {
  const T = pro7Type('rv.data.PlaylistDocument');
  const items = [
    ...byPath.map((n) => ({
      uuid: uuid(`I-${n}`),
      name: `Song ${n}`,
      presentation: {
        documentPath: {
          absoluteString: `file:///Users/worship/Documents/ProPresenter/Libraries/Default/Song%20${n}.pro`,
        },
      },
    })),
    ...byName.map((n) => ({ uuid: uuid(`IN-${n}`), name: `Song ${n}`, presentation: {} })),
    {
      uuid: uuid('I-LOOP'),
      name: 'Walk-in loop',
      cue: {
        uuid: uuid('CU-LOOP'),
        actions: [
          {
            uuid: uuid('MA-LOOP'),
            type: 'ACTION_TYPE_MEDIA',
            media: {
              element: {
                uuid: uuid('ME-LOOP'),
                url: { absoluteString: 'file:///Users/worship/Documents/ProPresenter/Media/loop.mp4' },
              },
            },
          },
        ],
      },
    },
  ];
  const obj = {
    type: 'TYPE_PRESENTATION',
    rootNode: {
      uuid: uuid('ROOT'),
      name: 'PRESENTATIONS',
      type: 'TYPE_ROOT',
      playlists: {
        playlists: [{ uuid: uuid('PL-1'), name: 'Sunday', type: 'TYPE_PLAYLIST', items: { items } }],
      },
    },
  };
  const err = T.verify(T.fromObject(obj));
  if (err) throw new Error(err);
  return T.encode(T.fromObject(obj)).finish();
}

/**
 * A library of `n` documents plus media placeholders, a playlist and one document copied into a
 * `.proPlaylist` bundle (the same bytes, sorted into the last batch: a copy across batches).
 */
function library(n: number, playlist: { byPath: number[]; byName: number[] }) {
  const files = new Map<string, Uint8Array>();
  for (let i = 1; i <= n; i++) files.set(`Libraries/Default/Song ${i}.pro`, songDoc(i));
  files.set('Playlists/Bundle.proPlaylist/Song 1.pro', songDoc(1));
  files.set('Playlists/PRESENTATIONS', playlistDoc(playlist.byPath, playlist.byName));
  for (const m of ['Media/bg0.png', 'Media/bg1.png', 'Media/bg2.png', 'Media/loop.mp4'])
    files.set(m, new Uint8Array(0));
  return files;
}

describe('H1: a large ProPresenter library is decoded in batches', () => {
  it('imports a synthetic 2,000-document library through the pool within the worker heap', async () => {
    const files = library(2000, { byPath: [1, 700, 1500, 1999], byName: [1234] });
    const bytes = [...files.values()].reduce((s, b) => s + b.length, 0);
    const calls: { docs: number; phase?: string; refs: number }[] = [];
    const t0 = Date.now();
    const r = await importPro7Batched(files, {
      run: (f, o) => {
        calls.push({
          docs: [...f.keys()].filter((k) => k.endsWith('.pro')).length,
          phase: o.phase,
          refs: o.refs?.length ?? 0,
        });
        return importPro7InWorker(f, undefined, o);
      },
    });
    const ms = Date.now() - t0;
    console.log(
      `2,001 documents (${Math.round(bytes / 1024)} KB) decoded in ${ms} ms over ${calls.length} tasks`,
    );
    expect(ms).toBeLessThan(20_000);
    expect(WORKER_LIMITS.maxOldGenerationSizeMb).toBe(512);
    // 2,001 documents: five batches of PRO7_BATCH_DOCS, then the playlists against all of them.
    expect(calls.map((c) => c.phase)).toEqual([
      'documents',
      'documents',
      'documents',
      'documents',
      'documents',
      'playlists',
    ]);
    expect(calls.map((c) => c.docs)).toEqual([
      PRO7_BATCH_DOCS,
      PRO7_BATCH_DOCS,
      PRO7_BATCH_DOCS,
      PRO7_BATCH_DOCS,
      1,
      0,
    ]);
    expect(calls.map((c) => c.refs)).toEqual([0, 500, 1000, 1500, 2000, 2001]);
    expect(files.size).toBe(5); // the documents were handed over as they went
    // The copy in the bundle (last batch) is the document from the first batch, imported once.
    expect(r.presentations.length).toBe(2000);
    expect(new Set(r.presentations.map((p) => p.title)).size).toBe(2000);
    expect(r.log.filter((l) => /same document as Song 1\.pro; imported once/.test(l.message)).length).toBe(1);
    expect(r.log.filter((l) => /ProPresenter 7 proto/.test(l.message)).length).toBe(1);
    expect(r.log.filter((l) => l.level === 'error').length).toBe(0);
    expect(r.refs?.length).toBe(2001);
    // The playlist resolves documents from every batch, by path and by name.
    expect(r.playlists.length).toBe(1);
    const byTitle = new Map(r.presentations.map((p) => [p.title, p.id]));
    const items = r.playlists[0]!.items;
    expect(
      items
        .filter((i) => i.kind === 'presentation')
        .map((i) => (i as { presentationId: string }).presentationId),
    ).toEqual([1, 700, 1500, 1999, 1234].map((n) => byTitle.get(`Song ${n}`)));
    expect(items.at(-1)).toMatchObject({
      kind: 'media',
      mediaId: 'pro7media:Users/worship/Documents/ProPresenter/Media/loop.mp4',
    });
    // Media references are a union across batches and the playlist pass.
    expect(r.media.map((m) => m.path).sort()).toEqual([
      'Media/bg0.png',
      'Media/bg1.png',
      'Media/bg2.png',
      'Media/loop.mp4',
    ]);
    expect(r.presentations.filter((p) => p.backgroundMediaId).length).toBe(400);
  }, 60_000);

  it('a library of at most one batch is one call, as before', async () => {
    const files = library(3, { byPath: [2], byName: [] });
    const calls: Pro7ImportOptions[] = [];
    const r = await importPro7Batched(files, {
      run: (f, o) => {
        calls.push(o);
        return Promise.resolve(importPro7(f, o) as Pro7Result);
      },
      batch: 4,
    });
    expect(calls).toEqual([{}]);
    expect(r.presentations.length).toBe(3);
    expect(r.playlists[0]!.items.length).toBe(2);
    expect(files.size).toBe(9);
  });

  it('cancels between batches', async () => {
    const files = library(5, { byPath: [], byName: [] });
    const ctrl = new AbortController();
    let n = 0;
    await expect(
      importPro7Batched(files, {
        run: (f, o) => {
          if (++n === 2) ctrl.abort();
          return Promise.resolve(importPro7(f, o) as Pro7Result);
        },
        batch: 2,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/cancelled/);
    expect(n).toBe(2);
  });
});

// --- H2: silent starts -----------------------------------------------------------------------------------

describe('H2: a child that never reports ready is failed, not restarted forever', () => {
  let sup: Supervisor | undefined;
  afterEach(async () => {
    await sup?.shutdown('test');
    sup = undefined;
  });
  const make = (env: Record<string, string>, extra: Partial<ConstructorParameters<typeof Supervisor>[0]>) => {
    const cap = capture();
    const envObj = { ...process.env, ...env };
    const gaveUp: string[] = [];
    sup = new Supervisor({
      entry: join(here, 'fixtures/child.mjs'),
      execArgv: [],
      env: envObj,
      dataDir: tempDir(),
      log: cap.log,
      restartDelaysMs: [10],
      onGiveUp: (name) => gaveUp.push(name),
      ...extra,
    });
    return { cap, sup, env: envObj, gaveUp };
  };

  it('two silent starts in a row mark the live process failed although the crash budget is not spent', async () => {
    const {
      cap,
      sup: s,
      gaveUp,
    } = make(
      { FIXTURE_SLOW_START: 'live:60000' },
      { stallMs: { live: 200 }, startGraceMs: 400, budget: { max: 5, windowMs: 60_000 } },
    );
    await s.start();
    await until(() => s.status().find((p) => p.name === 'live')!.state === 'failed', 8000, 'live failed');
    const live = s.status().find((p) => p.name === 'live')!;
    expect(cap.count(/silent while starting; killing it/)).toBe(MAX_SILENT_STARTS);
    expect(cap.has(/never reports ready; leaving it down/)).toBe(true);
    expect(live.recentCrashes).toBe(MAX_SILENT_STARTS);
    expect(live.restarts).toBe(MAX_SILENT_STARTS - 1);
    expect(gaveUp).toEqual(['live']);
    expect(live.pid).toBeUndefined();
    // Nothing is restarted after that.
    await sleep(600);
    expect(s.status().find((p) => p.name === 'live')!.restarts).toBe(MAX_SILENT_STARTS - 1);
    expect(cap.count(/child process started/)).toBe(1 + MAX_SILENT_STARTS);
  });

  it('a ready in between resets the count, and a known boot time shortens the grace', async () => {
    const {
      cap,
      sup: s,
      env,
      gaveUp,
    } = make(
      {},
      // A slow restart so the test can change the fixture between a kill and the next start.
      { stallMs: { live: 200 }, startGraceMs: 10_000, minStartGraceMs: 300, restartDelaysMs: [400] },
    );
    await s.start();
    await until(() => s.status().every((p) => p.state === 'up'), 5000, 'both up');
    // The next start hangs. The grace is now 3× the measured boot (at least 300 ms), not 10 s.
    env.FIXTURE_SLOW_START = 'live:60000';
    const t0 = Date.now();
    s.kill('live');
    await until(() => cap.has(/silent while starting; killing it/), 5000, 'first silent kill');
    expect(Date.now() - t0).toBeLessThan(3000);
    const kill = cap.lines.find((l) => /silent while starting/.test(l))!;
    const graceMs = (JSON.parse(kill) as { graceMs: number }).graceMs;
    expect(graceMs).toBeGreaterThanOrEqual(300);
    expect(graceMs).toBeLessThan(10_000);
    // The second start comes up (a transient hang): the silent count is reset.
    env.FIXTURE_SLOW_START = '';
    await until(() => s.status().find((p) => p.name === 'live')!.state === 'up', 5000, 'live up again');
    expect(gaveUp).toEqual([]);
    // Two more silent starts are needed to fail it.
    env.FIXTURE_SLOW_START = 'live:60000';
    s.kill('live');
    await until(() => s.status().find((p) => p.name === 'live')!.state === 'failed', 8000, 'live failed');
    expect(cap.count(/silent while starting; killing it/)).toBe(1 + MAX_SILENT_STARTS);
    expect(gaveUp).toEqual(['live']);
  });

  it('the library keeps its long stall timeout as grace', () => {
    const { sup: s } = make({}, { stallMs: { library: 60_000, live: 5000 } });
    expect(s.startGrace('library')).toBe(60_000);
    expect(s.startGrace('live')).toBe(30_000);
  });
});

// --- H4: an output token before the library context ---------------------------------------------------

describe('H4: an output token the live process cannot check yet gets bye retry', () => {
  let libp: LibraryProcess | undefined;
  let livep: LiveProcess | undefined;
  afterEach(async () => {
    await livep?.close();
    await libp?.close();
    livep = libp = undefined;
  });
  const cfg = (dir: string): Partial<HubConfig> => ({
    dataDir: dir,
    domain: 'localhost',
    devPin: `${OPERATE_PIN}:${EDIT_PIN}`,
    logToStdout: false,
    logLevel: 'warn',
    scheduleBackups: false,
    appsDir: join(dir, 'no-apps'),
    importRoots: [join(dir, 'import')],
    host: '127.0.0.1',
    port: 0,
    healthIntervalMs: 100,
  });

  it('answers retry without a context, unauthorized with one', async () => {
    const dir = tempDir();
    const secret = 'test-secret';
    // The live process alone, before the library ever answered: no context copy.
    livep = await createLiveProcess(cfg(dir), { secret });
    expect(livep.link.context).toBeUndefined();
    const early = await connectWs(livep.url, { token: 'not-checkable-yet' });
    const bye = await early.next(byType('bye'), 3000);
    expect(bye.reason).toBe('retry');
    early.close();
    // The library comes up: the context is fetched, a bad token is unauthorized and a good one connects.
    libp = await createLibraryProcess(cfg(dir), { secret, onChanges: () => undefined });
    livep.setLibrary(libp.url, 'up');
    await until(() => livep!.link.context !== undefined, 5000, 'context');
    const bad = await connectWs(livep.url, { token: 'not-a-token' });
    bad.send({ t: 'hello', role: 'output', appVersion: '0.1.0' });
    expect((await bad.next(byType('bye'), 3000)).reason).toBe('unauthorized');
    bad.close();
    const tok = libp.lib.getSetting('outputs').find((o) => o.token)!.token!;
    const good = await connectWs(livep.url, { token: tok });
    good.send({ t: 'hello', role: 'output', appVersion: '0.1.0' });
    expect((await good.next(byType('welcome'), 3000)).t).toBe('welcome');
    good.close();
  }, 20_000);
});

// --- H5: a backup without its manifest ------------------------------------------------------------------

describe('H5: a backup whose manifest is missing is still found', () => {
  it('returns the database with no manifest', async () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'backups'));
    writeFileSync(join(dir, 'backups', 'ordo-2026-11-04.db'), 'not really sqlite');
    const found = await findBackup(dir, '2026-11-04');
    expect(found.db).toBe(join(dir, 'backups', 'ordo-2026-11-04.db'));
    expect(found.manifest).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
});
