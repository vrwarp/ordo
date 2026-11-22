/**
 * The status store of the bake service (apps/operator/src/state/bake.ts): the CONTRACT that the editor's status
 * line and the Go-live check read (design/29 section 1.4). These cases pin its closed lists, its shape, what its
 * writers count and when they wake the readers, how a failure text is written and read back, and that the module
 * imports nothing but zustand (it is safe in the phone's compact layout).
 */
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BAKE_CODES,
  BAKE_GATES,
  BAKE_HOLDS,
  BAKE_STATES,
  type BakeCode,
  bakeId,
  describeFailure,
  dropPresentation,
  fixOf,
  pictureOf,
  progressOf,
  reasonFor,
  resetBake,
  type SlideBake,
  setGate,
  setHold,
  setPresentation,
  setRunning,
  setSlides,
  useBake,
} from '../src/state/bake.ts';

const slide = (
  p: string,
  s: string,
  state: SlideBake['state'],
  more: Partial<SlideBake> = {},
): SlideBake => ({
  presentationId: p,
  slideId: s,
  kind: 'slide',
  state,
  ...more,
});

/** Counts the store's notifications for the length of a callback. */
function notifications(run: () => void): number {
  let n = 0;
  const stop = useBake.subscribe(() => {
    n++;
  });
  run();
  stop();
  return n;
}

beforeEach(() => resetBake());

describe('the first state (S1) and an unknown slide (S2)', () => {
  it('starts unknown, empty and at zero', () => {
    const s = useBake.getState();
    expect(s.gate).toBe('unknown');
    expect(s.hold).toBeUndefined();
    expect(s.holdUntil).toBeUndefined();
    expect(s.running).toBeUndefined();
    expect(s.slides).toEqual({});
    expect(s.presentations).toEqual({});
    expect(s.totals).toEqual({ heavy: 0, ready: 0, making: 0, queued: 0, failed: 0 });
    expect(s.seq).toBe(0);
  });

  it('pictureOf never returns undefined and never throws', () => {
    const s = useBake.getState();
    expect(pictureOf(s, 'p', 's')).toEqual({
      state: 'none',
      presentationId: 'p',
      slideId: 's',
      kind: 'slide',
    });
    expect(pictureOf(s, '', '')).toEqual({ state: 'none', presentationId: '', slideId: '', kind: 'slide' });
    setSlides([slide('p', 's', 'ready', { key: 'k', sizes: [1920, 3840] })]);
    expect(pictureOf(useBake.getState(), 'p', 's')).toMatchObject({ state: 'ready', key: 'k' });
    expect(pictureOf(useBake.getState(), 'p', 'other').state).toBe('none');
  });
});

describe('the writers (S3)', () => {
  it('one call with 500 slides is ONE notification, and the totals count the states', () => {
    const entries: SlideBake[] = [];
    for (let i = 0; i < 500; i++) {
      const state = (['ready', 'making', 'queued', 'failed', 'off', 'unsupported', 'none'] as const)[
        i % 7
      ] as SlideBake['state'];
      entries.push(slide(`p${i % 5}`, `s${i}`, state));
    }
    expect(notifications(() => setSlides(entries))).toBe(1);
    const s = useBake.getState();
    expect(Object.keys(s.slides)).toHaveLength(500);
    // 500 = 71 * 7 + 3: the first three states of the cycle (ready, making, queued) appear 72 times, the other four 71
    // times; off and unsupported count in `heavy` only, `none` not at all
    expect(s.totals).toEqual({
      heavy: 72 + 72 + 72 + 71 + 71 + 71,
      ready: 72,
      making: 72,
      queued: 72,
      failed: 71,
    });
    expect(s.seq).toBe(1);
  });

  it('the presentations hold counts that follow their slides', () => {
    setSlides([
      slide('a', '1', 'ready'),
      slide('a', '2', 'queued'),
      slide('a', '3', 'none'),
      slide('b', '1', 'failed'),
    ]);
    expect(useBake.getState().presentations).toEqual({
      a: { id: 'a', heavy: 2, ready: 1, making: 0, queued: 1, failed: 0 },
      b: { id: 'b', heavy: 1, ready: 0, making: 0, queued: 0, failed: 1 },
    });
    setPresentation('a', { listedAt: 5, usedBytes: 100, limitBytes: 1000 });
    expect(useBake.getState().presentations.a).toEqual({
      id: 'a',
      heavy: 2,
      ready: 1,
      making: 0,
      queued: 1,
      failed: 0,
      listedAt: 5,
      usedBytes: 100,
      limitBytes: 1000,
    });
    // the counts move with the slides and the hub-side facts stay
    setSlides([slide('a', '2', 'making')]);
    expect(useBake.getState().presentations.a).toMatchObject({
      heavy: 2,
      ready: 1,
      making: 1,
      queued: 0,
      usedBytes: 100,
    });
  });

  it('seq goes up by one per call that changes something and not at all for a repeat', () => {
    const e = slide('p', 's', 'queued', { sizes: [1920], waiting: 'hub-key' });
    expect(notifications(() => setSlides([e]))).toBe(1);
    expect(useBake.getState().seq).toBe(1);
    // the same writes again (a copy, an equal array, an undefined field, nothing named): nobody is woken
    expect(
      notifications(() => {
        setSlides([{ ...e, sizes: [1920], key: undefined }]);
        setSlides([]);
        setGate('unknown');
        setHold(undefined, undefined);
        setRunning(undefined);
        setPresentation('p', {});
        dropPresentation('nobody');
      }),
    ).toBe(0);
    const after = useBake.getState().seq;
    expect(after).toBe(1);
    expect(notifications(() => setSlides([{ ...e }]))).toBe(0);
    expect(useBake.getState().seq).toBe(after);
    // a change is one more
    expect(notifications(() => setSlides([{ ...e, sizes: [1920, 3840] }]))).toBe(1);
    expect(useBake.getState().seq).toBe(after + 1);
  });

  it('gate, hold and the running job change one at a time and name their changes', () => {
    expect(notifications(() => setGate('ready'))).toBe(1);
    expect(useBake.getState().gate).toBe('ready');
    expect(notifications(() => setGate('ready'))).toBe(0);
    expect(notifications(() => setHold('resume-wait', 123))).toBe(1);
    expect(useBake.getState()).toMatchObject({ hold: 'resume-wait', holdUntil: 123 });
    expect(notifications(() => setHold('resume-wait', 123))).toBe(0);
    expect(notifications(() => setHold('resume-wait', 124))).toBe(1);
    expect(notifications(() => setHold())).toBe(1);
    expect(useBake.getState().hold).toBeUndefined();
    const job = { presentationId: 'p', slideId: 's', key: 'k', since: 1, phase: 'files' as const };
    expect(notifications(() => setRunning(job))).toBe(1);
    expect(notifications(() => setRunning({ ...job }))).toBe(0);
    expect(notifications(() => setRunning({ ...job, phase: 'drawing' }))).toBe(1);
    expect(useBake.getState().running?.phase).toBe('drawing');
    expect(notifications(() => setRunning(undefined))).toBe(1);
    expect(useBake.getState().running).toBeUndefined();
  });

  it('entries can be removed, a presentation can be dropped and the totals follow', () => {
    setSlides([slide('a', '1', 'ready'), slide('a', '2', 'ready'), slide('b', '1', 'queued')]);
    setPresentation('a', { listedAt: 1 });
    setSlides([], [bakeId('a', '1'), 'a/never-there']);
    expect(useBake.getState().totals).toEqual({ heavy: 2, ready: 1, making: 0, queued: 1, failed: 0 });
    dropPresentation('a');
    const s = useBake.getState();
    expect(Object.keys(s.slides)).toEqual([bakeId('b', '1')]);
    expect(s.presentations.a).toBeUndefined();
    expect(s.totals).toEqual({ heavy: 1, ready: 0, making: 0, queued: 1, failed: 0 });
  });

  it('keeps the object of an unchanged presentation, so a reader of one is not woken by another', () => {
    setSlides([slide('a', '1', 'ready'), slide('b', '1', 'queued')]);
    const a = useBake.getState().presentations.a;
    setSlides([slide('b', '1', 'making')]);
    expect(useBake.getState().presentations.a).toBe(a);
  });
});

describe('progress (S4)', () => {
  it('counts 12 record slides of two presentations: 5 ready, 1 making, 4 queued, 2 failed', () => {
    const states: SlideBake['state'][] = [
      ...Array(5).fill('ready'),
      'making',
      ...Array(4).fill('queued'),
      ...Array(2).fill('failed'),
    ];
    setSlides(states.map((st, i) => slide(i < 7 ? 'p1' : 'p2', `s${i}`, st)));
    setSlides([slide('p1', 'plain', 'none')]);
    const s = useBake.getState();
    expect(progressOf(s)).toEqual({ total: 12, done: 5, making: 1, queued: 4, failed: 2 });
    expect(progressOf(s, ['p1'])).toEqual({ total: 7, done: 5, making: 1, queued: 1, failed: 0 });
    expect(progressOf(s, ['p2'])).toEqual({ total: 5, done: 0, making: 0, queued: 3, failed: 2 });
    expect(progressOf(s, ['p1', 'p2'])).toEqual(progressOf(s));
    expect(progressOf(s, ['nobody'])).toEqual({ total: 0, done: 0, making: 0, queued: 0, failed: 0 });
    expect(progressOf(s, [])).toEqual({ total: 0, done: 0, making: 0, queued: 0, failed: 0 });
  });

  it('a device that cannot make pictures still counts its record slides in the total', () => {
    setSlides([slide('p', '1', 'unsupported'), slide('p', '2', 'ready'), slide('p', '3', 'off')]);
    expect(progressOf(useBake.getState())).toEqual({ total: 3, done: 1, making: 0, queued: 0, failed: 0 });
  });
});

const REASONS: readonly BakeCode[] = [
  'profile',
  'busy',
  'animated',
  'cut',
  'files',
  'font',
  'coverage',
  'media',
  'draw',
  'fonts',
  'frame',
  'canvas',
  'blank',
  'time',
  'cancelled',
  'size',
  'verify',
];

describe('failure texts (S5, S6)', () => {
  it('every code reads back as itself with its detail and its fix class', () => {
    const FIX: Record<string, string[]> = {
      again: ['time', 'cancelled', 'busy', 'fonts'],
      fix: ['font', 'coverage', 'media', 'files', 'budget', 'disk'],
      slide: ['animated', 'cut', 'size'],
      ordo: ['draw', 'frame', 'canvas', 'blank', 'verify', 'profile', 'kind'],
    };
    for (const [fix, codes] of Object.entries(FIX))
      for (const code of codes) {
        const detail = code === 'coverage' ? 'U+4E2D' : 'an ordinary detail: with a colon';
        expect(describeFailure(`${code}: ${detail}`)).toEqual({ code, fix, detail });
        expect(describeFailure(code)).toEqual({ code, fix, detail: '' });
        expect(fixOf(code as BakeCode)).toBe(fix);
      }
  });

  it('a text with no known prefix, an empty one, a long one and one with newlines are unknown and try again', () => {
    expect(describeFailure('the hub said no')).toEqual({
      code: 'unknown',
      fix: 'again',
      detail: 'the hub said no',
    });
    expect(describeFailure('')).toEqual({ code: 'unknown', fix: 'again', detail: '' });
    expect(describeFailure('timeout: later')).toMatchObject({ code: 'unknown', fix: 'again' });
    expect(describeFailure('time2: no')).toMatchObject({ code: 'unknown' });
    const long = describeFailure('x'.repeat(5000));
    expect(long.code).toBe('unknown');
    expect(long.detail).toHaveLength(200);
    const lines = describeFailure('a line\nand another\r\n\tand a third');
    expect(lines).toEqual({ code: 'unknown', fix: 'again', detail: 'a line and another and a third' });
    // an unknown code written by this build reads back as unknown, with its own prefix
    expect(describeFailure('unknown: whatever')).toEqual({
      code: 'unknown',
      fix: 'again',
      detail: 'whatever',
    });
  });

  it('never throws and always answers inside the bounds (property test over arbitrary strings)', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 400 }), fc.string({ unit: 'binary', maxLength: 400 })),
        (text) => {
          const d = describeFailure(text);
          expect(BAKE_CODES).toContain(d.code);
          expect(['again', 'fix', 'slide', 'ordo']).toContain(d.fix);
          expect(d.detail.length).toBeLessThanOrEqual(200);
          expect(d.detail).not.toMatch(/[\r\n]/);
        },
      ),
      { numRuns: 500 },
    );
    expect(describeFailure(undefined as unknown as string)).toMatchObject({ code: 'unknown' });
    expect(describeFailure(42 as unknown as string)).toMatchObject({ code: 'unknown' });
  });

  it('reasonFor writes the code first, once, on one line of at most 200 characters', () => {
    expect(reasonFor('font', 'Foo Sans')).toBe('font: Foo Sans');
    // the renderer's own text already begins with its code: not written twice
    expect(reasonFor('font', 'font: Foo Sans')).toBe('font: Foo Sans');
    expect(reasonFor('time', 'time')).toBe('time');
    expect(reasonFor('time')).toBe('time');
    expect(reasonFor('time', '')).toBe('time');
    expect(reasonFor('files', 'two\nlines\there')).toBe('files: two lines here');
    const big = reasonFor('draw', 'y'.repeat(900));
    expect(big.length).toBeLessThanOrEqual(200);
    expect(big.startsWith('draw: y')).toBe(true);
    expect(big).not.toMatch(/\n/);
  });

  it('a coverage detail is at most 32 characters: never more slide text than the renderer allows', () => {
    const text = reasonFor('coverage', 'coverage: ' + 'x'.repeat(500));
    expect(text).toBe(`coverage: ${'x'.repeat(31)}…`);
    expect(describeFailure(text).detail.length).toBeLessThanOrEqual(32);
    expect(reasonFor('coverage', 'z'.repeat(32))).toBe(`coverage: ${'z'.repeat(32)}`);
  });

  it('describeFailure(reasonFor(c, d)).code is c for every code', () => {
    for (const code of BAKE_CODES)
      for (const detail of ['', 'a detail', 'other: colon', 'x'.repeat(400), `${code}: again`]) {
        const text = reasonFor(code, detail);
        expect(describeFailure(text).code).toBe(code);
        expect(text.length).toBeLessThanOrEqual(200);
      }
  });
});

describe('the closed lists (S7)', () => {
  it('states, gates and holds are exactly what the contract names', () => {
    expect([...BAKE_STATES]).toEqual(['none', 'queued', 'making', 'ready', 'failed', 'off', 'unsupported']);
    expect([...BAKE_GATES]).toEqual(['unknown', 'ready', 'off', 'unsupported']);
    expect([...BAKE_HOLDS]).toEqual(['starting', 'service', 'go-live', 'resume-wait', 'hub', 'disk']);
  });

  it('the codes are the renderer reasons, then the four of this service', () => {
    expect([...BAKE_CODES]).toEqual([...REASONS, 'budget', 'disk', 'kind', 'unknown']);
  });

  it.todo(
    "BAKE_CODES equals the renderer's BakeReason list plus budget, disk, kind and unknown (read from packages/renderer/src/bake.ts once bake-render has merged: turned on by the plan's commit)",
  );
});

describe('plates and the id (S8)', () => {
  it('bakeId is presentation/slide', () => {
    expect(bakeId('p', 's')).toBe('p/s');
  });

  it('an entry whose key holds a # (a later plate) is not counted in the totals, the counts or the progress', () => {
    setSlides([
      slide('p', 's1', 'ready'),
      slide('p', 's1#plate:1', 'ready'),
      slide('p', 's1#plate:2', 'making'),
      slide('p', 's2', 'queued'),
    ]);
    const s = useBake.getState();
    expect(Object.keys(s.slides)).toHaveLength(4);
    expect(s.totals).toEqual({ heavy: 2, ready: 1, making: 0, queued: 1, failed: 0 });
    expect(s.presentations.p).toMatchObject({ heavy: 2, ready: 1, making: 0, queued: 1 });
    expect(progressOf(s)).toEqual({ total: 2, done: 1, making: 0, queued: 1, failed: 0 });
    // the plate is still readable by its own id
    expect(pictureOf(s, 'p', 's1#plate:2').state).toBe('making');
  });
});

describe('isolation (S9)', () => {
  it('imports zustand and nothing else: no renderer, no hub, no services, no workers', () => {
    const src = readFileSync(new URL('../src/state/bake.ts', import.meta.url), 'utf8');
    const imports = src.match(/^import[^;]*;/gm) ?? [];
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatch(/from 'zustand'/);
    for (const banned of ['@ordo/renderer', 'apps/hub', 'services/', 'workers/', 'react', '@ordo/client'])
      expect(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')).not.toContain(
        `from '${banned}`,
      );
    // no dynamic import either
    expect(src).not.toMatch(/\bimport\(/);
  });
});

describe('what the two readers do (a consumer test)', () => {
  it('the editor reads one slide and the import report reads "5 of 12"', () => {
    setGate('ready');
    setSlides([
      slide('deck', 'a', 'ready', {
        key: 'k1',
        sizes: [1920, 3840],
        ms: 4100,
        bytes: 11_300_000,
        madeBy: 'operator 0.10.0 operate Linux',
      }),
      slide('deck', 'b', 'making'),
      slide('deck', 'c', 'failed', { reason: reasonFor('coverage', 'U+4E2D'), code: 'coverage', fix: 'fix' }),
      slide('deck', 'd', 'queued', { waiting: 'hold' }),
      slide('other', 'e', 'ready'),
    ]);
    setHold('service');
    const s = useBake.getState();
    expect(pictureOf(s, 'deck', 'a')).toMatchObject({ state: 'ready', sizes: [1920, 3840] });
    expect(pictureOf(s, 'deck', 'c')).toMatchObject({ state: 'failed', fix: 'fix' });
    const f = describeFailure(pictureOf(s, 'deck', 'c').reason ?? '');
    expect(f).toEqual({ code: 'coverage', fix: 'fix', detail: 'U+4E2D' });
    const p = progressOf(s, ['deck']);
    expect(`${p.done} of ${p.total}`).toBe('1 of 4');
    expect(s.hold).toBe('service');
    expect(s.gate).toBe('ready');
    expect(s.presentations.deck?.heavy).toBe(4);
  });
});
