/**
 * A narrower affectsContext (design/28 §3.4, §5.1): a media change touches the outputs' config, and the live
 * process's copy of it, only when the settings name that media (the logo, a holding image). Before P0 every
 * media change counted when no logo was set: a photo upload sent an output three library deltas (uploaded,
 * processing, ready), three config refetches, and in two processes three context refreshes first.
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_LOOKS, type Media } from '@ordo/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { SETTINGS_SCHEMAS } from '../src/library.ts';
import { affectsContext, CONTEXT_MEDIA_FIELDS, contextMediaIds } from '../src/librarylink.ts';
import { fixtures } from './fixtures.ts';
import {
  byType,
  connectWs,
  login,
  OPERATE_PIN,
  sleep,
  startHub,
  type TestHub,
  type WsClient,
} from './helpers.ts';
import { type TwoProcesses, twoProcesses } from './phones-helpers.ts';

/** Every field named `*MediaId` in a zod schema, as `a.b[].c` paths. */
function mediaIdPaths(schema: z.ZodType, at: string, out: Set<string>, depth = 0): Set<string> {
  if (depth > 30) return out;
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  const walk = (s: unknown, p: string) => mediaIdPaths(s as z.ZodType, p, out, depth + 1);
  switch (def.type) {
    case 'object':
      for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>)) {
        const p = at ? `${at}.${k}` : k;
        if (/mediaid$/i.test(k)) out.add(p);
        walk(v, p);
      }
      break;
    case 'array':
      walk(def.element, `${at}[]`);
      break;
    case 'record':
      walk(def.valueType, `${at}{}`);
      break;
    case 'union':
      for (const o of def.options as z.ZodType[]) walk(o, at);
      break;
    case 'intersection':
      walk(def.left, at);
      walk(def.right, at);
      break;
    case 'pipe':
      walk(def.in, at);
      walk(def.out, at);
      break;
    case 'lazy':
      walk((def.getter as () => z.ZodType)(), at);
      break;
    default:
      if (def.innerType) walk(def.innerType, at);
  }
  return out;
}

describe('contextMediaIds and affectsContext', () => {
  it('knows every *MediaId field of every settings key (a schema walk)', () => {
    const found = new Set<string>();
    for (const [key, schema] of Object.entries(SETTINGS_SCHEMAS)) mediaIdPaths(schema, key, found);
    expect([...found].sort()).toEqual([...CONTEXT_MEDIA_FIELDS].sort());
    expect(Object.keys(SETTINGS_SCHEMAS).sort()).toEqual(
      ['audio', 'general', 'keymap', 'looks', 'outputs', 'phones', 'surfaces'].sort(),
    );
  });

  it('collects the logo and the holding images', () => {
    const looks = DEFAULT_LOOKS.map((l, i) => (i === 1 ? { ...l, holdingMediaId: 'hold' } : l));
    expect([...contextMediaIds({ general: { logoMediaId: 'logo' }, looks })].sort()).toEqual([
      'hold',
      'logo',
    ]);
    expect(contextMediaIds(undefined).size).toBe(0);
    expect(contextMediaIds({ general: {}, looks: [] }).size).toBe(0);
  });

  it('counts settings and fonts always, media only when the settings name it', () => {
    const ids = new Set(['logo']);
    const rows: [Parameters<typeof affectsContext>[0], boolean][] = [
      [{ kind: 'settings', id: 'general' }, true],
      [{ kind: 'settings', id: 'phones' }, true],
      [{ kind: 'font', id: 'f' }, true],
      [{ kind: 'media', id: 'logo' }, true],
      [{ kind: 'media', id: 'photo' }, false],
      [{ kind: 'presentation', id: 'p' }, false],
      [{ kind: 'playlist', id: 'p' }, false],
      [{ kind: 'job', id: 'j' }, false],
      [{ kind: 'theme', id: 't' }, false],
    ];
    for (const [c, want] of rows) expect(affectsContext(c, ids), `${c.kind} ${c.id}`).toBe(want);
    // No logo set: a media change no longer counts (it did before P0).
    expect(affectsContext({ kind: 'media', id: 'photo' }, new Set())).toBe(false);
  });
});

describe('what reaches an output', () => {
  let hub: TestHub | undefined;
  let two: TwoProcesses | undefined;
  afterEach(async () => {
    await hub?.cleanup();
    await two?.close();
    hub = undefined;
    two = undefined;
  });

  async function photo(base: string, dir: string): Promise<Media> {
    const op = await login(base, OPERATE_PIN);
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(fixtures.png(dir))]), 'photo.png');
    return op.json<Media>('/media', { method: 'POST', body: fd });
  }
  const deltas = (ws: WsClient) => ws.messages.filter((m) => m.t === 'library.delta');

  it('a photo upload with no logo sends an output nothing; the logo and a holding image still do', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const out = hub.lib.getSetting('outputs')[0]!;
    const ws = await connectWs(hub.url, { token: out.token, hello: { role: 'output', outputId: out.id } });
    await ws.next(byType('welcome'));
    const m = await photo(hub.url, hub.dir);
    await hub.jobs.idle();
    await sleep(200);
    // Before P0: 3 (uploaded, processing, ready), each a config refetch.
    expect(deltas(ws)).toHaveLength(0);
    await op.json('/settings/general', {
      method: 'PUT',
      json: { ...hub.lib.getSetting('general'), logoMediaId: m.id },
    });
    await ws.next(byType('library.delta'));
    await op.json(`/media/${m.id}`, { method: 'PUT', json: { name: 'Logo' } });
    const d = await ws.next((x) => x.t === 'library.delta' && JSON.stringify(x.changes).includes(m.id));
    expect(d.changes).toEqual([{ kind: 'media', id: m.id, rev: expect.any(Number) }]);
    const hold = await photo(hub.url, hub.dir);
    await hub.jobs.idle();
    const looks = hub.lib
      .getSetting('looks')
      .map((l, i) => (i === 0 ? { ...l, holdingMediaId: hold.id } : l));
    await op.json('/settings/looks', { method: 'PUT', json: looks });
    await op.json(`/media/${hold.id}`, { method: 'PUT', json: { name: 'Lobby' } });
    await ws.next((x) => x.t === 'library.delta' && JSON.stringify(x.changes).includes(hold.id));
    ws.close();
  });

  it('two processes: no context refresh for a media change outside the context, one for a settings change', async () => {
    two = await twoProcesses();
    const op = await login(two.base, OPERATE_PIN);
    const refresh = vi.spyOn(two.live.link, 'refreshContext');
    const out = two.lib.lib.getSetting('outputs')[0]!;
    const ws = await connectWs(two.base, { token: out.token, hello: { role: 'output', outputId: out.id } });
    await ws.next(byType('welcome'));
    await photo(two.base, two.lib.cfg.dataDir);
    await expect.poll(() => two!.lib.lib.media.list().every((x) => x.state === 'ready')).toBe(true);
    await sleep(300);
    expect(refresh).not.toHaveBeenCalled();
    expect(deltas(ws)).toHaveLength(0);
    await op.json('/settings/general', {
      method: 'PUT',
      json: { ...two.lib.lib.getSetting('general'), venueName: 'Refreshed' },
    });
    expect(refresh).toHaveBeenCalled();
    expect(two.live.link.context?.settings.general.venueName).toBe('Refreshed');
    ws.close();
  });
});
