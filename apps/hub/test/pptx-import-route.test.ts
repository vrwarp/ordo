/**
 * `POST /import/document` and the native PowerPoint import (design/27 §2, §3.2; M3 item H): a .pptx is
 * imported as editable slides unless pictures are asked for, with the native import's options in the job
 * payload. The jobs themselves are stand-ins here (items B and D test them): this checks what the route
 * queues, with which payload, and what it refuses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PptxRenderer } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { buildDeck, solid, sp } from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocPayload } from '../src/imports.ts';
import type { JobQueue } from '../src/jobs.ts';
import { PptxImports } from '../src/pptx/index.ts';
import type { PptxDeps, PptxNativePayload } from '../src/pptx/shared.ts';
import { documentImportForm } from '../src/routes.ts';
import { fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, startHub, type TestHub, tempDir } from './helpers.ts';

const fx = tempDir('ordo-fx-');

/** A one-slide deck built from parts (no real deck: design/27 §12), zipped like an upload. */
async function deckBytes(): Promise<Uint8Array<ArrayBuffer>> {
  const parts = buildDeck({
    slides: [{ shapes: sp({ id: 2, x: 0, y: 0, cx: 914_400, cy: 914_400, fill: solid('336699') }) }],
  });
  const z = new JSZip();
  for (const [k, v] of parts) z.file(k, v);
  return new Uint8Array(await z.generateAsync({ type: 'uint8array' }));
}

let hub: TestHub;
let ed: Client;
let deck: Uint8Array<ArrayBuffer>;
/** What the stand-in jobs were given, by job id. */
const seen = new Map<string, { kind: string; payload: unknown }>();

beforeAll(async () => {
  hub = await startHub();
  ed = await login(hub.url, EDIT_PIN);
  deck = await deckBytes();
  for (const kind of ['pptx-native', 'document'])
    hub.jobs.register<unknown>(kind, async (ctx) => {
      seen.set(ctx.id, { kind, payload: ctx.payload });
      return { presentationId: 'stand-in' };
    });
});
afterAll(async () => {
  await hub.cleanup();
});
beforeEach(() => seen.clear());

async function post(file: Uint8Array<ArrayBuffer>, name: string, fields: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([file]), name);
  return ed.fetch('/import/document', { method: 'POST', body: fd });
}

async function queued(res: Response): Promise<{ job: Job; payload: unknown }> {
  expect(res.status).toBe(202);
  const job = (await res.json()) as Job;
  await hub.jobs.idle();
  const got = seen.get(job.id);
  expect(got?.kind).toBe(job.kind);
  return { job, payload: got?.payload };
}

describe('POST /import/document', () => {
  it('imports a PowerPoint as editable slides by default', async () => {
    const { job, payload } = await queued(await post(deck, 'Sunday Service.pptx'));
    expect(job.kind).toBe('pptx-native');
    const p = payload as PptxNativePayload;
    expect(p).toEqual({ hash: p.hash, name: 'Sunday Service.pptx', options: {} });
    // The deck is stored by its SHA-256 before the job starts.
    expect(hub.lib.getFile(p.hash)).toBeTruthy();
  });

  it('keeps the native options in the payload', async () => {
    const { job, payload } = await queued(
      await post(deck, 'a.pptx', { renderer: 'native', extendBackgrounds: '0', transitionSounds: '1' }),
    );
    expect(job.kind).toBe('pptx-native');
    expect((payload as PptxNativePayload).options).toEqual({
      extendBackgrounds: false,
      transitionSounds: true,
    });
  });

  it('imports pictures when LibreOffice or pptx-preview is asked for', async () => {
    const lo = await queued(await post(deck, 'b.pptx', { renderer: 'libreoffice', extendBackgrounds: '1' }));
    expect(lo.job.kind).toBe('document');
    expect(lo.payload).toEqual({ hash: (lo.payload as DocPayload).hash, name: 'b.pptx', ext: 'pptx' });
    const ppv = await queued(await post(deck, 'c.pptx', { renderer: 'pptx-preview' }));
    expect(ppv.job.kind).toBe('document');
    expect((ppv.payload as DocPayload).renderer).toBe('pptx-preview');
  });

  it('imports a PDF as pictures whatever the PowerPoint choice', async () => {
    const pdf = new Uint8Array(readFileSync(fixtures.pdf(fx, 1)));
    for (const renderer of [undefined, 'native']) {
      const { job, payload } = await queued(await post(pdf, 'Notices.pdf', renderer ? { renderer } : {}));
      expect(job.kind).toBe('document');
      expect(payload).toMatchObject({ name: 'Notices.pdf', ext: 'pdf' });
      expect((payload as DocPayload).renderer).toBeUndefined();
    }
  });

  it('refuses unknown values, queues nothing and keeps no upload', async () => {
    const uploads = join(hub.dir, 'uploads');
    const { readdirSync, existsSync } = await import('node:fs');
    const files = () => (existsSync(uploads) ? readdirSync(uploads).length : 0);
    const before = files();
    const jobs = hub.jobs.list().length;
    const bad: Record<string, string>[] = [
      { renderer: 'keynote' },
      { extendBackgrounds: 'maybe' },
      { renderer: 'NATIVE' },
    ];
    for (const fields of bad) {
      const res = await post(deck, 'x.pptx', fields);
      expect(res.status).toBe(400);
    }
    expect(hub.jobs.list().length).toBe(jobs);
    expect(files()).toBe(before);
  });

  it('does not widen the stored renderer: native lives only in the form and the payload', () => {
    expect(PptxRenderer.safeParse('native').success).toBe(false);
    expect(PptxRenderer.options).toEqual(['libreoffice', 'pptx-preview']);
  });
});

describe('documentImportForm', () => {
  it('reads the renderer and the options', () => {
    expect(documentImportForm({})).toEqual({ renderer: 'native', options: {} });
    expect(documentImportForm({ renderer: '' })).toEqual({ renderer: 'native', options: {} });
    expect(documentImportForm({ renderer: 'libreoffice', extendBackgrounds: 'false' })).toEqual({
      renderer: 'libreoffice',
      options: { extendBackgrounds: false },
    });
    expect(documentImportForm({ extendBackgrounds: 'on', transitionSounds: 'off' }).options).toEqual({
      extendBackgrounds: true,
      transitionSounds: false,
    });
    expect(documentImportForm({ extendBackgrounds: '' }).options).toEqual({});
  });

  it('refuses what it does not know with a 400', () => {
    const bad: Record<string, string>[] = [
      { renderer: 'keynote' },
      { transitionSounds: 'yes' },
      { extendBackgrounds: '2' },
    ];
    for (const f of bad)
      expect(() => documentImportForm(f)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it('reads only its own fields, never inherited ones', () => {
    const fields = Object.create({ renderer: 'keynote', extendBackgrounds: 'maybe' }) as Record<
      string,
      string
    >;
    expect(documentImportForm(fields)).toEqual({ renderer: 'native', options: {} });
  });
});

describe('queueReference', () => {
  it('names the slides that switch to the picture only when asked', () => {
    const queued: unknown[] = [];
    const jobs = {
      register: () => undefined,
      enqueue: (_kind: string, payload: unknown) => {
        queued.push(payload);
        return { id: 'j' } as never;
      },
    } as unknown as JobQueue;
    const pptx = new PptxImports({ jobs, locked: () => false } as unknown as PptxDeps);
    pptx.queueReference('p1', 'h');
    pptx.queueReference('p1', 'h', 'edit@1', []);
    pptx.queueReference('p1', 'h', undefined, ['s1']);
    expect(queued).toEqual([
      { presentationId: 'p1', hash: 'h' },
      { presentationId: 'p1', hash: 'h', by: 'edit@1', showPicture: [] },
      { presentationId: 'p1', hash: 'h', showPicture: ['s1'] },
    ]);
  });
});
