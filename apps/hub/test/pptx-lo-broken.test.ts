/**
 * A LibreOffice that is installed but does not answer (design/27 M9, `tools.ts` 'broken': a version probe that
 * timed out on a slow cold start, or failed once), and one still being checked. Neither is 'no LibreOffice':
 * the probe is tried again (`HubTools.recheck`), the follow-up defers while it does not answer and never
 * clears `pending` for good on its first try, and the routes answer 503 with a retry hint instead of 501.
 */
import type { Presentation } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import {
  body,
  buildDeck,
  CHART_CONTENT_TYPE,
  chartFrame,
  chartXml,
  para,
  run,
  sp,
  withPart,
} from '@ordo/pptx-scene/test-util.ts';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { JobDeferred, type JobCtx } from '../src/jobs.ts';
import { LO_PROBE_RETRIES, loJob } from '../src/pptx/fallback.ts';
import type { PptxLoPayload, PptxNativeResult } from '../src/pptx/shared.ts';
import { HubTools, type ToolInfo, type ToolState } from '../src/tools.ts';
import { EDIT_PIN, login, startHub, type TestHub } from './helpers.ts';
import { slidesOf, waitJob } from './pptx-helpers.ts';

const IN = 914_400;

const quiet = { info: () => undefined, warn: () => undefined };

/** A title slide and a chart slide (the chart waits for LibreOffice's art). */
async function deckZip(): Promise<Buffer> {
  const parts = buildDeck({
    slides: [
      { shapes: sp({ id: 2, x: IN, y: IN, cx: 6 * IN, cy: IN, txBody: body(para(run('Welcome'))) }) },
      {
        rels: [{ id: 'rId3', type: 'chart', target: '../charts/chart1.xml' }],
        shapes:
          sp({ id: 2, x: IN, y: IN / 2, cx: 6 * IN, cy: IN, txBody: body(para(run('Giving'))) }) +
          chartFrame({ id: 4, x: 5 * IN, y: 2 * IN, cx: 4 * IN, cy: 3 * IN, rId: 'rId3' }),
      },
    ],
  });
  withPart(parts, 'ppt/charts/chart1.xml', chartXml(), CHART_CONTENT_TYPE);
  const z = new JSZip();
  for (const [k, v] of parts) z.file(k, v);
  return z.generateAsync({ type: 'nodebuffer' });
}

async function upload(h: TestHub, fields: Record<string, string> = {}) {
  const ed = await login(h.url, EDIT_PIN);
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  fd.append('file', new Blob([new Uint8Array(await deckZip())]), 'Sunday.pptx');
  return ed.fetch('/import/document', { method: 'POST', body: fd });
}

describe('HubTools.recheck', () => {
  it('probes a broken LibreOffice again, at most once per interval, and never an absent or off one', async () => {
    let state: ToolState = 'broken';
    let probes = 0;
    const make = (recheckMs: number, mode: 'auto' | 'off' = 'auto') =>
      new HubTools(
        {
          libreoffice: { mode, exe: 'soffice' },
          toolProbe: (tool): ToolInfo => {
            if (tool !== 'libreoffice') return { state: 'available' };
            probes++;
            return { state, ...(state === 'broken' ? { reason: 'timed out after 30000 ms' } : {}) };
          },
        },
        quiet,
        { recheckMs },
      );
    const t = make(0);
    await t.ready;
    expect(t.libreoffice().state).toBe('broken');
    expect(probes).toBe(1);
    expect(await t.recheck()).toBe('broken');
    expect(probes).toBe(2);
    // It answers now (a slow cold start that finished): available, without a restart.
    state = 'available';
    expect(await t.recheck()).toBe('available');
    expect(t.has('libreoffice')).toBe(true);
    expect(t.capabilities().pptx.pictures).toBe(true);
    expect(await t.recheck()).toBe('available');
    expect(probes).toBe(3);
    // Within the interval callers share the last answer.
    state = 'broken';
    probes = 0;
    const slow = make(60_000);
    await slow.ready;
    await Promise.all([slow.recheck(), slow.recheck()]);
    await slow.recheck();
    expect(probes).toBe(2);
    // Absent and off are not probed again.
    state = 'absent';
    probes = 0;
    const absent = make(0);
    expect(await absent.recheck()).toBe('absent');
    expect(probes).toBe(1);
    const off = make(0, 'off');
    expect(await off.recheck()).toBe('off');
    expect(probes).toBe(1);
  });
});

describe('a hub whose LibreOffice does not answer (M9 wave 1 repair)', () => {
  it('plans the art, defers the follow-up while it does not answer, and keeps the slides waiting', async () => {
    const h = await startHub({
      libreoffice: { mode: 'auto', exe: 'soffice' },
      toolProbe: (tool) =>
        tool === 'libreoffice'
          ? { state: 'broken', reason: 'timed out after 30000 ms' }
          : { state: 'available' },
      jobs: { heavy: 0, light: 2 },
    });
    try {
      const res = await upload(h);
      expect(res.status, await res.clone().text()).toBe(202);
      const job = await waitJob(h, ((await res.json()) as Job).id, 120_000);
      expect(job.state, job.error).toBe('done');
      const result = job.result as PptxNativeResult;
      // Not 'no LibreOffice': the chart waits for its art, and nothing is listed missing.
      expect(result).toMatchObject({ libreoffice: true, pending: 1, missing: 0 });
      expect(job.log.some((l) => /LibreOffice does not answer yet/.test(l))).toBe(true);
      const lo = h.jobs.get(result.loJobId!);
      expect(lo.state).toBe('queued');
      // LibreOffice's heavy work, not the light clearing a hub without it does.
      expect(
        (h.lib.db.prepare('SELECT class FROM jobs WHERE id = ?').get(lo.id) as { class: string }).class,
      ).toBe('heavy');
      const payload = JSON.parse(
        (h.lib.db.prepare('SELECT payload FROM jobs WHERE id = ?').get(lo.id) as { payload: string }).payload,
      ) as PptxLoPayload;
      const ctx: JobCtx<PptxLoPayload> = {
        id: lo.id,
        payload,
        signal: new AbortController().signal,
        log: () => undefined,
        progress: () => undefined,
        setPayload: (pl) => {
          ctx.payload = pl;
        },
      };
      const handler = loJob(h.imports.pptx.deps, {
        reimport: () => {
          throw new Error('never re-imported while LibreOffice may answer');
        },
      });
      // Deferred with backoff, LibreOffice probed again each time; the slide keeps waiting.
      const deferred = await handler(ctx).catch((e: unknown) => e);
      expect(deferred).toBeInstanceOf(JobDeferred);
      expect((deferred as JobDeferred).message).toMatch(/LibreOffice does not answer on this hub/);
      expect(ctx.payload.probes).toBe(1);
      const chart = () => slidesOf(h.lib.presentations.must(result.presentationId))[1]!;
      expect(chart().pptx).toMatchObject({ pending: true });
      expect(chart().pptx!.missing).toBeUndefined();
      // Past the last attempt the slide keeps version 1, marked failed (not missing: LibreOffice is there).
      ctx.payload = { ...ctx.payload, probes: LO_PROBE_RETRIES };
      const out = (await handler(ctx)) as { failed: number };
      expect(out.failed).toBe(1);
      expect(chart().pptx).toMatchObject({ class: 'hybrid', failed: true });
      expect(chart().pptx!.pending).toBeUndefined();
      expect(chart().pptx!.missing).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  }, 120_000);

  it('answers 503 with a retry hint while LibreOffice does not answer, and removes the upload', async () => {
    const h = await startHub({
      libreoffice: { mode: 'auto', exe: 'soffice' },
      toolProbe: (tool) =>
        tool === 'libreoffice' ? { state: 'broken', reason: 'exited with 1' } : { state: 'available' },
    });
    try {
      const res = await upload(h, { renderer: 'libreoffice' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('120');
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'libreoffice_not_answering',
      );
      const { readdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      expect(readdirSync(join(h.dir, 'uploads'))).toEqual([]);
      // 'Show original' by LibreOffice too.
      const native = await upload(h);
      const job = await waitJob(h, ((await native.json()) as Job).id, 120_000);
      const p = h.lib.presentations.must((job.result as PptxNativeResult).presentationId) as Presentation;
      const ed = await login(h.url, EDIT_PIN);
      const ref = await ed.fetch(`/presentations/${p.id}/pptx-reference`, {
        method: 'POST',
        json: { showPicture: [] },
      });
      expect(ref.status).toBe(503);
    } finally {
      await h.cleanup();
    }
  }, 120_000);

  it('answers 503 while LibreOffice is still being checked after the routes wait', async () => {
    let answer: (i: ToolInfo) => void = () => undefined;
    const h = await startHub({
      libreoffice: { mode: 'auto', exe: 'soffice' },
      toolProbe: (tool) =>
        tool === 'libreoffice'
          ? new Promise<ToolInfo>((r) => {
              answer = r;
            })
          : { state: 'available' },
    });
    try {
      const res = await upload(h, { renderer: 'libreoffice' });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('30');
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('libreoffice_checking');
    } finally {
      answer({ state: 'available' });
      await h.cleanup();
    }
  }, 60_000);
});
