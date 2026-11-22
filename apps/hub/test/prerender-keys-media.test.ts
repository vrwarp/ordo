/**
 * The keys at save read the library's picture files once per picture, not once per picture per slide (design/29
 * §1.3). A presentation of six heavy slides that show the same forty pictures asked the media table 240 times per
 * save (a prepared statement and a parsed row each: a third of the keys work of a save in the release's heavy-slide
 * measure); the answer cannot differ inside one call, so one call reads each picture once. The memo lives for one
 * call: a picture replaced between two saves is read again. The keys and the sigs do not move (the step 0 pins in
 * prerender-keys-pin.test.ts stay green); only the count of reads does.
 */
import { createHash } from 'node:crypto';
import type { Presentation, Slide } from '@ordo/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cpuPool } from '../src/pool.ts';
import { PrerenderKeys } from '../src/prerenderkeys.ts';
import { EDIT_PIN, login, startHub, type TestHub } from './helpers.ts';
import { bigSlide, presentationOf } from './prerender-helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await hub?.cleanup();
  hub = undefined;
});

const PICTURES = 40;
const hashOf = (s: string) => createHash('sha256').update(s).digest('hex');

function addMedia(h: TestHub, id: string, file: string) {
  h.db
    .prepare(
      `INSERT OR REPLACE INTO media (id, rev, name, kind, state, json, created_at, updated_at) VALUES (?, 1, ?, 'image', 'ready', ?, 'a', 'a')`,
    )
    .run(
      id,
      id,
      JSON.stringify({
        id,
        rev: 1,
        name: id,
        tags: [],
        kind: 'image',
        original: { hash: file, bytes: 1, mime: 'image/png', path: `media/${file.slice(0, 2)}/${id}.png` },
        state: 'ready',
        loop: false,
        isBackground: false,
      }),
    );
}

/** A heavy slide (300 shapes, forty pictures that every such slide shows) with the record that asks for a picture. */
function heavy(id: string): Slide {
  const s = bigSlide(id, 300, id);
  const images = Array.from({ length: PICTURES }, (_, i) => ({
    id: `img${i}`,
    type: 'image' as const,
    box: { x: (i % 8) * 200, y: 300 + Math.floor(i / 8) * 120, w: 190, h: 110, rotation: 0 },
    mediaId: `m${i}`,
    fit: 'contain' as const,
    opacity: 1,
    radius: 0,
  }));
  s.objects.splice(1, 0, ...(images as never[]));
  return { ...s, prerender: { why: ['count'], live: [] } };
}

async function saved(slides: Slide[]) {
  const ed = await login(hub!.url, EDIT_PIN);
  return ed.json<Presentation>('/presentations', { method: 'POST', json: presentationOf(slides, 'Shared') });
}
const keysOf = () => new PrerenderKeys(hub!.lib, hub!.store, cpuPool, { live: () => 'idle', log: hub!.log });

describe('the keys at save read each picture once per call', () => {
  it('six heavy slides showing the same forty pictures read the media table forty times, not 240', async () => {
    hub = await startHub();
    for (let i = 0; i < PICTURES; i++) addMedia(hub, `m${i}`, hashOf(`shared-${i}`));
    const p = await saved(Array.from({ length: 6 }, (_, k) => heavy(`h${k}`)));
    const stored = hub.lib.prerenderIndex.keysAt(p.id, p.rev);
    expect(stored).toHaveLength(6);

    const get = vi.spyOn(hub.lib.media, 'get');
    const again = await keysOf().keysFor(p);

    const reads = get.mock.calls.map((c) => c[0]);
    expect(new Set(reads).size).toBe(PICTURES);
    expect(reads).toHaveLength(PICTURES);
    // the rows are the ones the save wrote: the same sig for every slide, so nothing was asked of the pool
    expect(again.map((r) => [r.slideId, r.key, r.standbyId, r.sig]).sort()).toEqual(
      stored.map((r) => [r.slideId, r.key, r.standbyId, r.sig]).sort(),
    );
  });

  it('a picture replaced between two calls is read again: the memo lives for one call', async () => {
    hub = await startHub();
    for (let i = 0; i < PICTURES; i++) addMedia(hub, `m${i}`, hashOf(`shared-${i}`));
    const p = await saved([heavy('h0'), heavy('h1')]);
    const before = hub.lib.prerenderIndex.keysAt(p.id, p.rev);
    const keys = keysOf();
    const first = await keys.keysFor(p);
    expect(first.map((r) => r.sig).sort()).toEqual(before.map((r) => r.sig).sort());

    addMedia(hub, 'm7', hashOf('shared-7-replaced'));
    const second = await keys.keysFor(p);
    expect(second).toHaveLength(2);
    for (const r of second) {
      const was = before.find((b) => b.slideId === r.slideId)!;
      expect(r.sig).not.toBe(was.sig);
      expect(r.key).not.toBe(was.key);
    }
  });
});
