/**
 * One stringify per library delta (design/28 §3.4, §5.3): broadcastLibrary serialised every batch twice (the
 * whole batch, and again without output tokens) on the live process's main thread, 37 ms together for one
 * 4 MiB deck on this machine (measured at d0f49cb). Now the second string is built only when a batch carries
 * outputs with tokens, and every socket receives exactly the bytes it received before.
 */
import { lyricSlide, newId } from '@ordo/domain';
import { PROTOCOL_VERSION } from '@ordo/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Change } from '../src/library.ts';
import { affectsContext } from '../src/librarylink.ts';
import {
  connectWs,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  sleep,
  song,
  startHub,
  type TestHub,
  type WsClient,
} from './helpers.ts';
import { phone } from './phones-helpers.ts';

/** broadcastLibrary as it was at d0f49cb (ws.ts:539-562): the strings each kind of socket got. */
function reference(changes: Change[], forOutputs: (ch: Change) => boolean) {
  const strip = (ch: Change): Change =>
    ch.kind === 'settings' && ch.id === 'outputs' && Array.isArray(ch.entity)
      ? { ...ch, entity: (ch.entity as { token?: string }[]).map(({ token: _t, ...o }) => o) }
      : ch;
  const full = JSON.stringify({ t: 'library.delta', v: PROTOCOL_VERSION, changes });
  const stripped = JSON.stringify({ t: 'library.delta', v: PROTOCOL_VERSION, changes: changes.map(strip) });
  const relevant = changes.filter(forOutputs);
  const toOutputs = relevant.length
    ? JSON.stringify({
        t: 'library.delta',
        v: PROTOCOL_VERSION,
        changes: relevant.map((ch) => ({ kind: ch.kind, id: ch.id, rev: ch.rev })),
      })
    : undefined;
  return { operate: full, edit: stripped, output: toOutputs };
}

describe('broadcastLibrary', () => {
  let hub: TestHub;
  const raw: Record<string, string[]> = { operate: [], edit: [], capped: [], output: [] };
  const sockets: WsClient[] = [];
  beforeAll(async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const ed = await login(hub.url, EDIT_PIN);
    const ph = await phone(hub.url);
    const out = hub.lib.getSetting('outputs')[0]!;
    const open = async (name: string, opts: Parameters<typeof connectWs>[1]) => {
      const ws = await connectWs(hub.url, opts);
      ws.ws.on('message', (d) => {
        const s = d.toString();
        if (s.includes('"library.delta"')) raw[name]!.push(s);
      });
      await ws.next((m) => m.t === 'welcome');
      sockets.push(ws);
    };
    await open('operate', { cookie: op.cookie });
    await open('edit', { cookie: ed.cookie, hello: { role: 'edit' } });
    await open('capped', { cookie: ph.cookie, hello: { role: 'edit' } });
    await open('output', { token: out.token, hello: { role: 'output', outputId: out.id } });
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await hub.cleanup();
  });

  const forOutputs = (ch: Change) => affectsContext(ch, new Set(['logo']));
  const big = () => {
    const s = song('Big');
    s.sections[0]!.slides = Array.from({ length: 400 }, (_, i) => lyricSlide(`Line ${i} `.repeat(40)));
    return s;
  };
  const batches: [string, () => Change[]][] = [
    ['a presentation', () => [{ kind: 'presentation', id: 'p', rev: 2, entity: big() }]],
    [
      'outputs with tokens',
      () => [{ kind: 'settings', id: 'outputs', entity: hub.lib.getSetting('outputs') }],
    ],
    [
      'mixed changes',
      () => [
        { kind: 'presentation', id: 'p', rev: 3, entity: song() },
        { kind: 'settings', id: 'outputs', entity: hub.lib.getSetting('outputs') },
        { kind: 'media', id: 'logo', rev: 4, entity: { id: 'logo' } },
        { kind: 'playlist', id: newId(), deleted: true },
      ],
    ],
    ['fonts', () => [{ kind: 'font', id: 'f1', rev: 1, entity: { id: 'f1', family: 'Venue Sans' } }]],
  ];

  for (const [what, make] of batches)
    it(`${what}: every kind of socket receives exactly the bytes it received before`, async () => {
      for (const k of Object.keys(raw)) raw[k] = [];
      const changes = make();
      const want = reference(changes, forOutputs);
      hub.sockets.broadcastLibrary(changes, forOutputs);
      await expect.poll(() => raw.operate!.length).toBe(1);
      await sleep(100);
      expect(raw.operate).toEqual([want.operate]);
      expect(raw.edit).toEqual([want.edit]);
      expect(raw.capped).toEqual([want.edit]);
      expect(raw.output).toEqual(want.output ? [want.output] : []);
      expect(raw.edit[0]).not.toContain('"token"');
    });

  it('a presentation batch is stringified once (twice before), a batch with tokens twice', () => {
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      hub.sockets.broadcastLibrary([{ kind: 'presentation', id: 'p', rev: 5, entity: big() }], forOutputs);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      hub.sockets.broadcastLibrary(
        [{ kind: 'settings', id: 'outputs', entity: hub.lib.getSetting('outputs') }],
        forOutputs,
      );
      // full, stripped, and the ids-only message for the outputs.
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });
});
