/**
 * M4 scaffold of 'Re-import from PowerPoint' (design/27 §11, apps/operator/src/views/editor/M4.md item F):
 * the route checks the lock and the stored deck and queues the light `pptx-reimport` job with the request;
 * the plan route answers without writing. Item F replaces the stub expectations (an empty plan, a job that
 * changes nothing) as it builds `planReimport`, `mergeReimport` and the job.
 */
import { newId, type Playlist, type Presentation } from '@ordo/domain';
import type { Job, PptxReimportPlan, PptxReimportResult } from '@ordo/protocol';
import { buildDeck, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planReimport, queueReimport } from '../src/pptx/reimport.ts';
import { PPTX_JOB_CLASS, PPTX_JOBS } from '../src/pptx/shared.ts';
import {
  type Client,
  EDIT_PIN,
  login,
  OPERATE_PIN,
  song,
  startHub,
  type TestHub,
  tempDir,
} from './helpers.ts';
import { storeDeck, zipDeck } from './pptx-helpers.ts';

let hub: TestHub;
let ed: Client;
let hash: string;

beforeAll(async () => {
  hub = await startHub();
  ed = await login(hub.url, EDIT_PIN);
  const parts = buildDeck({
    slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: 914_400, cy: 914_400, fill: solid('336699') }) }],
  });
  hash = await storeDeck(hub, await zipDeck(parts, tempDir('ordo-reimport-')));
});
afterAll(async () => {
  await hub.cleanup();
});

/** A presentation imported from the stored deck (a slide as the native import writes it). */
async function imported(): Promise<Presentation> {
  const sid = newId();
  return ed.json<Presentation>('/presentations', {
    method: 'POST',
    json: {
      title: 'Sunday',
      kind: 'slides',
      sections: [
        {
          id: sid,
          label: 'Slides',
          short: 'S',
          slides: [
            {
              id: newId(),
              objects: [],
              pptx: { fileId: hash, index: 0, shown: 0, class: 'native', version: 1 },
            },
          ],
        },
      ],
      arrangements: [{ id: newId(), name: 'Default', sectionIds: [sid] }],
      source: { kind: 'pptx', fileId: hash },
    },
  });
}

describe("'Re-import from PowerPoint' (scaffold)", () => {
  it('is a light job kind of its own', () => {
    expect(PPTX_JOBS.reimport).toBe('pptx-reimport');
    expect(PPTX_JOB_CLASS['pptx-reimport']).toBe('light');
  });

  it('queues the job with the request, and the stub job saves nothing', async () => {
    const p = await imported();
    const slideId = p.sections[0]!.slides[0]!.id;
    const res = await ed.fetch(`/presentations/${p.id}/pptx-reimport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reset: [slideId] }),
    });
    expect(res.status).toBe(202);
    const job = (await res.json()) as Job;
    expect(job.kind).toBe('pptx-reimport');
    await hub.jobs.idle();
    const done = hub.jobs.get(job.id);
    expect(done.state).toBe('done');
    const result = done.result as PptxReimportResult;
    expect(result).toMatchObject({ presentationId: p.id, regenerated: 0, replaced: 0 });
    expect(result.rev).toBeUndefined();
    expect(hub.lib.presentations.must(p.id).rev).toBe(p.rev);
  });

  it('answers a plan without writing', async () => {
    const p = await imported();
    const plan = await ed.json<PptxReimportPlan>(`/presentations/${p.id}/pptx-reimport`);
    expect(plan).toEqual({ presentationId: p.id, fileId: hash, slides: [] });
    expect(hub.lib.presentations.must(p.id).rev).toBe(p.rev);
  });

  it('refuses a presentation without a stored deck, a bad body, and a live-locked presentation', async () => {
    const plain = await ed.json<Presentation>('/presentations', { method: 'POST', json: song() });
    expect((await ed.fetch(`/presentations/${plain.id}/pptx-reimport`, { method: 'POST' })).status).toBe(400);
    expect((await ed.fetch(`/presentations/${plain.id}/pptx-reimport`)).status).toBe(400);
    const p = await imported();
    const bad = await ed.fetch(`/presentations/${p.id}/pptx-reimport`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ everything: true }),
    });
    expect(bad.status).toBe(400);

    const op = await login(hub.url, OPERATE_PIN);
    const pl = await ed.json<Playlist>('/playlists', {
      method: 'POST',
      json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    try {
      expect((await ed.fetch(`/presentations/${p.id}/pptx-reimport`, { method: 'POST' })).status).toBe(423);
    } finally {
      await op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
    }
  });
});

describe('reimport.ts contracts (scaffold)', () => {
  it('queueReimport puts only the fields asked for in the payload', () => {
    const queued: unknown[] = [];
    const jobs = {
      enqueue: (kind: string, payload: unknown, cls: string) => {
        queued.push([kind, payload, cls]);
        return { id: 'j', kind } as Job;
      },
    };
    queueReimport({ jobs } as never, 'p1', 'h', { slideIds: ['s1'] }, 'edit');
    queueReimport({ jobs } as never, 'p2', 'h', {});
    expect(queued).toEqual([
      ['pptx-reimport', { presentationId: 'p1', hash: 'h', by: 'edit', slideIds: ['s1'] }, 'light'],
      ['pptx-reimport', { presentationId: 'p2', hash: 'h' }, 'light'],
    ]);
  });

  it('planReimport names the stored deck', () => {
    const p = { ...song(), source: { kind: 'pptx' as const, fileId: 'deck' } };
    expect(planReimport(p, {}, () => undefined)).toEqual({
      presentationId: p.id,
      fileId: 'deck',
      slides: [],
    });
  });
});
