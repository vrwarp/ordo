import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { body, buildDeck, para, run, solid, sp } from '../packages/pptx-scene/src/test-util.ts';
import { hubApi } from './linkhelpers.ts';
import { portOf } from './ports.ts';
import { zipParts } from './pptxdecks.ts';
import { apiJson, importPptx, pptxHub } from './pptxlive.ts';

/**
 * 'Make editable' on LibreOffice's page that a native import stored (1b tables-cells; design/27 §11 "Round
 * trip and migration", apps/hub/src/pptx/README.md "Make editable"), on a hub with LibreOffice (its port: e2e/
 * ports.ts row 'editor-reimport-lo'). The deck's one slide is eight boxes of 400 differently coloured runs:
 * past 64 KB with its formatting, so this hub keeps LibreOffice's page for it (version 2: class 'picture', the
 * page and its extracted text in `imported`, drawn by the LibreOffice follow-up). 'Make editable' answers 202
 * and the re-import job (it answered 200 and laid text boxes at once before), the job converts the slide again,
 * finds it LibreOffice's page again, and lays the page's text boxes over it as 'Make editable' always did: one
 * revision, the page picture at the bottom, the text editable over it. A table page an older import kept ends
 * as the table object instead: no build of this branch stores one, so that case is the hub tests'
 * (apps/hub/test/pptx-reimport.test.ts, main's and the interim rule's notes).
 */
const PORT = portOf('editor-reimport-lo');
const OUT = 'test-results/editor-reimport-lo';
const IN = 914_400;

type Job = {
  id: string;
  kind: string;
  state: string;
  log: string[];
  error?: string;
  result?: Record<string, unknown>;
};
type Obj = {
  id: string;
  type: string;
  text?: string;
  mediaId?: string;
  origin?: { src?: string; role?: string };
};
type StoredSlide = {
  id: string;
  objects: Obj[];
  notes?: string;
  imported?: { imageMediaId: string; textBoxes?: { text: string }[] };
  pptx?: { class?: string; pending?: boolean };
};
type Presentation = { id: string; rev: number; sections: { slides: StoredSlide[] }[] };

/** A one-slide deck of eight boxes of 400 differently coloured runs (as pptx-native.test.ts's 64 KB page). */
function bigDeck(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const runs = Array.from({ length: 400 }, (_, i) =>
    run(`w${i} `, '', solid(i % 2 ? 'FF0000' : '00FF00')),
  ).join('');
  const shapes = Array.from({ length: 8 }, (_, i) =>
    sp({ id: 2 + i, x: IN, y: i * 0.6 * IN, cx: 6 * IN, cy: IN / 2, txBody: body(para(runs)) }),
  ).join('');
  const file = join(dir, 'Announcements.pptx');
  writeFileSync(file, zipParts(buildDeck({ slides: [{ shapes }] })));
  return file;
}

/** Every job of the hub done (the import and its LibreOffice follow-up). */
async function settled(a: APIRequestContext): Promise<Job[]> {
  let jobs: Job[] = [];
  await expect
    .poll(
      async () => {
        const r = (await (await a.get('jobs')).json()) as Job[] | { jobs: Job[] };
        jobs = Array.isArray(r) ? r : r.jobs;
        return jobs.length > 0 && jobs.every((j) => j.state === 'done' || j.state === 'failed');
      },
      { timeout: 240_000 },
    )
    .toBe(true);
  return jobs;
}

async function storedSlide(a: APIRequestContext, id: string): Promise<{ p: Presentation; s: StoredSlide }> {
  const p = await apiJson<Presentation>(a, `presentations/${id}`);
  const slides = p.sections.flatMap((x) => x.slides);
  expect(slides).toHaveLength(1);
  return { p, s: slides[0]! };
}

test("'Make editable' on LibreOffice's 64 KB page answers 202 and the job, which lays its text boxes over it", async () => {
  test.setTimeout(420_000);
  rmSync(OUT, { recursive: true, force: true });
  const deck = bigDeck(OUT);
  const hub = await pptxHub(PORT);
  try {
    const a = await hubApi(PORT);
    const caps = await apiJson<{ libreoffice: { state: string } }>(a, 'capabilities');
    expect(caps.libreoffice.state, 'this hub has LibreOffice').not.toBe('off');
    const imp = await importPptx(a, deck);
    const jobs = await settled(a);
    const lo = jobs.filter((j) => j.kind === 'pptx-lo');
    expect(lo, 'the LibreOffice follow-up ran once').toHaveLength(1);
    expect(lo[0]!.state, lo[0]!.log.join('\n')).toBe('done');
    const id = String(imp.result!.presentationId);
    const { p: before, s: page } = await storedSlide(a, id);
    // LibreOffice's page (version 2): no objects, the page and its extracted text in `imported`, nothing waits.
    expect(page.pptx?.class).toBe('picture');
    expect(page.pptx?.pending).toBeUndefined();
    expect(page.objects).toEqual([]);
    const boxes = page.imported?.textBoxes ?? [];
    expect(boxes.length, "the page's text, as 'Make editable' shows it").toBeGreaterThan(0);

    // 'Make editable', as the Slide panel asks for it: 202 and the re-import job (not 200 and text boxes).
    const res = await a.post(`presentations/${id}/slides/${page.id}/make-editable`);
    expect(res.status(), await res.text()).toBe(202);
    const queued = (await res.json()) as Job;
    expect(queued.kind).toBe('pptx-reimport');
    let job: Job | undefined;
    await expect
      .poll(
        async () => {
          job = (await (await a.get(`jobs/${queued.id}`)).json()) as Job;
          return job.state;
        },
        { timeout: 180_000 },
      )
      .toMatch(/^(done|failed)$/);
    expect(job!.state, `${job!.error}\n${job!.log.join('\n')}`).toBe('done');
    // Still LibreOffice's page past 64 KB: not rebuilt, made editable as before, in one revision.
    expect(job!.result).toMatchObject({ replaced: 0, regenerated: 0, rev: before.rev + 1 });
    expect(job!.log.join('\n')).toMatch(/LibreOffice's page again/);

    const { s: after } = await storedSlide(a, id);
    expect(after.id).toBe(page.id);
    expect(after.imported).toBeUndefined();
    expect(after.pptx?.class).toBe('picture');
    // The page picture at the bottom, the page's text in boxes over it, the import's (origin pptx).
    expect(after.objects[0]).toMatchObject({ type: 'image', mediaId: page.imported!.imageMediaId });
    expect(after.objects[0]!.origin).toEqual({ src: 'pptx', role: 'bg' });
    const texts = after.objects.slice(1);
    expect(texts.map((o) => o.type)).toEqual(boxes.map(() => 'text'));
    expect(texts.map((o) => o.text)).toEqual(boxes.map((b) => b.text));
    for (const o of texts) expect(o.origin).toEqual({ src: 'pptx', role: 'text' });
    // Nothing more queued: no LibreOffice run for a page it already drew.
    const later = (await settled(a)).filter((j) => j.kind === 'pptx-lo');
    expect(later).toHaveLength(1);
  } finally {
    hub.kill();
  }
});
