import type { APIRequestContext } from '@playwright/test';
import { heavyForm } from '../packages/domain/src/heavyform.ts';
import type { Presentation, Slide, SlideObject } from '../packages/domain/src/index.ts';
import type { SlideFile } from '../packages/domain/src/slidefile.ts';

/**
 * A slide kept as a slide file, for a spec to start from (import-files step 1(f), the e2e twin of
 * `apps/hub/test/prerender-helpers.ts`): a heavy slide of small shapes made by the domain's own `heavyForm` (the stand-in,
 * the head and the pages, as an import writes them), its pages and head uploaded through `PUT /files/slide/:hash` (pages
 * first, then the head, as the hub asks), and the presentation body that carries the stand-in. The editor, Go live and
 * the guards of a detailed slide are specs of their own tracks (editor-light, golive-lines, import-files); they start here
 * instead of importing a deck. Nothing in it is a third-party deck's.
 */

const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h, rotation: 0 });

/** `n` small rectangles in a grid, ids `s0`..`s<n-1>`, each its own colour. */
export function smallShapes(n: number): SlideObject[] {
  return Array.from(
    { length: n },
    (_, i) =>
      ({
        id: `s${i}`,
        type: 'shape',
        box: box(20 + (i % 60) * 30, 20 + Math.floor(i / 60) * 6, 24, 5),
        shape: 'rect',
        fill: { r: (i * 7) % 256, g: (i * 13) % 256, b: (i * 29) % 256, a: 1 },
        opacity: 1,
        radius: 0,
      }) as SlideObject,
  );
}

/** A title and a body text box, so the stand-in has words to show until a picture exists. */
export function wordsOf(title: string, body: string): SlideObject[] {
  const style = {
    fontFamily: 'Carlito',
    fontWeight: 400,
    fontStyle: 'normal',
    fontSizePx: 64,
    color: { r: 255, g: 255, b: 255, a: 1 },
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
  };
  return [
    { id: 'title', type: 'text', box: box(100, 60, 1700, 120), text: title, style, opacity: 1 },
    { id: 'body', type: 'text', box: box(100, 220, 1700, 600), text: body, style, opacity: 1 },
  ] as unknown as SlideObject[];
}

export type SlideFileFixture = {
  /** The full slide (what the file holds). */
  full: Slide;
  /** The stand-in a presentation carries: its `prerender.file` names `name`. */
  standIn: Slide;
  /** The slide file as `heavyForm` made it (the head, the pages and their names and bytes). */
  file: SlideFile;
  /** The head's name: `standIn.prerender.file.ref`. */
  name: string;
  /** The body of a presentation holding the stand-in (POST /presentations), a song with one section of one slide. */
  presentation: Record<string, unknown>;
};

export type SlideFileOptions = {
  /** The slide's id (default 'heavy'). */
  slideId?: string;
  /** The presentation's title (default 'Detailed slide'). */
  title?: string;
  /** The words of the slide: a title and a body (default two short lines). */
  words?: { title: string; body: string };
  /** The reasons the record names (default `['count']`). */
  why?: ('bytes' | 'count')[];
};

/** A slide of `n` small shapes and some words, made into its full form: the stand-in, the head and the pages. Pure; no hub needed. */
export function slideFileOf(n: number, opts: SlideFileOptions = {}): SlideFileFixture {
  const words = opts.words ?? { title: 'A detailed slide', body: 'Every shape of it is in the slide file.' };
  const full = {
    id: opts.slideId ?? 'heavy',
    objects: [...smallShapes(n), ...wordsOf(words.title, words.body)],
  } as Slide;
  const r = heavyForm(full, { why: opts.why ?? ['count'] });
  if (!r.ok) throw new Error(`the slide did not get a file: ${r.reason}`);
  const sectionId = 'sec-heavy';
  const presentation: Record<string, unknown> = {
    title: opts.title ?? 'Detailed slide',
    kind: 'song',
    meta: { tags: [] },
    sections: [{ id: sectionId, label: 'Slides', short: 'S', slides: [r.standIn] }],
    arrangements: [{ id: 'arr-heavy', name: 'Default', sectionIds: [sectionId] }],
    archived: false,
  };
  return { full, standIn: r.standIn, file: r.file, name: r.file.name, presentation };
}

/** PUT the pages of a slide file, then its head (the hub refuses a head whose pages it does not have). Returns the head's name. */
export async function uploadSlideFile(api: APIRequestContext, file: SlideFile): Promise<string> {
  for (const p of file.pages) {
    const r = await api.put(`files/slide/${p.name}`, { data: p.page });
    if (r.status() !== 200 && r.status() !== 201)
      throw new Error(`page ${p.name}: ${r.status()} ${await r.text()}`);
  }
  const r = await api.put(`files/slide/${file.name}`, { data: file.head });
  if (r.status() !== 200 && r.status() !== 201) throw new Error(`head: ${r.status()} ${await r.text()}`);
  return file.name;
}

/**
 * `slideFileOf(n)`, its file uploaded, and a presentation holding the stand-in created on the hub: returns the fixture and
 * the presentation as the hub stored it (`id`, `rev`).
 */
export async function slideFileFixture(
  api: APIRequestContext,
  n: number,
  opts: SlideFileOptions = {},
): Promise<SlideFileFixture & { id: string; saved: Presentation }> {
  const fx = slideFileOf(n, opts);
  await uploadSlideFile(api, fx.file);
  const r = await api.post('presentations', { data: fx.presentation });
  if (r.status() !== 201) throw new Error(`presentation: ${r.status()} ${await r.text()}`);
  const saved = (await r.json()) as Presentation;
  return { ...fx, id: saved.id, saved };
}
