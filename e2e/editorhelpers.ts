import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page } from '@playwright/test';
import pptxgen from 'pptxgenjs';
import { login } from './linkhelpers.ts';
import { ffmpeg, VERSES } from './pptxdecks.ts';
import { apiJson, importPptx, pptxHub } from './pptxlive.ts';

/**
 * Shared steps of the M4 editor specs (design/27 §15 M4 exit; apps/operator/src/views/editor/M4.md): a
 * synthetic church deck imported through the real upload route, the editor opened on it, an edit made in
 * the editor's UI, Save, a reload, and the presentation JSON compared (after save and reload it must be
 * identical). Each spec owns a hub on its own port (e2e/ports.ts, a row per spec).
 */

/** The operator's origin on a hub of `port` (the desktop operator, signed in with the operate PIN). */
export const opOrigin = (port: number) => `http://op.localhost:${port}`;

/** A hub with the bundled fonts, as the PowerPoint specs start one (`pptxlive.ts`). */
export const editorHub = pptxHub;

// ---- the church deck -----------------------------------------------------------------------------------

/** What the church deck's slides hold, in deck order (all text invented or public domain, WEB). */
export const CHURCH = {
  welcome: { title: 'Welcome to Morning Worship', notes: 'Greet people at the door.' },
  /** An announcement with a bold, coloured date inside plain text (exit: fix a typo inside it). */
  announcement: {
    before: 'Potluck lunch on ',
    date: 'Sunday 12 May',
    after: ' in the hall',
    second: 'Bring a dish to share',
    notes: 'Mention the sign-up sheet.',
  },
  /** John 3:16-17, the verse numbers raised (exit: add a verse, number verses, apply a theme). */
  verses: { notes: 'Read slowly.' },
  /** A 4:3 photo in a 16:9 box (exit: crop a photo, replace a picture of another aspect). */
  photo: { caption: 'Our new hall', notes: 'Thank the builders.' },
  /** A rounded rectangle with its text, one PowerPoint shape (exit: move a shape+text pair as one). */
  pair: { text: 'Coffee after the service', notes: 'Coffee is in the hall.' },
  /** Hidden in PowerPoint (exit: hide and unhide; Next skips it). */
  hidden: { text: 'A slide for the second service', notes: 'Only at the second service.' },
} as const;

/** The announcement's text as the editor's text field shows it. */
export const ANNOUNCEMENT_TEXT = `${CHURCH.announcement.before}${CHURCH.announcement.date}${CHURCH.announcement.after}\n${CHURCH.announcement.second}`;

/**
 * The church deck (pptxgenjs, as `pptxdecks.ts` writes its decks): 6 slides in the order of `CHURCH`, a
 * 16:9 gradient background picture on the first slide, Calibri text (drawn with the bundled Carlito).
 */
export async function churchDeck(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const bg = join(dir, 'background.png');
  const photo = join(dir, 'photo-4x3.png');
  ffmpeg(['-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0x1f3a5f:c1=0x3f6b2f', '-frames:v', '1', bg]);
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1', photo]);
  const data = (f: string) => `image/png;base64,${readFileSync(f).toString('base64')}`;
  const p = new pptxgen();
  p.layout = 'LAYOUT_WIDE';
  const font = 'Calibri';

  const s1 = p.addSlide();
  s1.background = { data: data(bg) };
  s1.addText(CHURCH.welcome.title, {
    x: 0.8,
    y: 2.5,
    w: 11.7,
    h: 2,
    fontFace: font,
    fontSize: 54,
    bold: true,
    color: 'FFFFFF',
    align: 'center',
  });
  s1.addNotes(CHURCH.welcome.notes);

  const a = CHURCH.announcement;
  const s2 = p.addSlide();
  s2.background = { color: 'FFFFFF' };
  s2.addText(
    [
      { text: a.before },
      { text: a.date, options: { bold: true, color: 'C00000' } },
      { text: a.after, options: { breakLine: true } },
      { text: a.second },
    ],
    { x: 0.8, y: 1.5, w: 11.7, h: 3, fontFace: font, fontSize: 40, color: '222222', valign: 'top' },
  );
  s2.addNotes(a.notes);

  const s3 = p.addSlide();
  s3.background = { color: 'F2EFE6' };
  s3.addText(
    VERSES.flatMap(([n, t], i) => [
      { text: n, options: { superscript: true } },
      { text: t, options: i < VERSES.length - 1 ? { breakLine: true } : {} },
    ]),
    { x: 0.8, y: 1.2, w: 11.7, h: 5, fontFace: font, fontSize: 44, color: '222222', valign: 'top' },
  );
  s3.addNotes(CHURCH.verses.notes);

  const s4 = p.addSlide();
  s4.background = { color: '0B3D2E' };
  s4.addImage({ data: data(photo), x: 2.2, y: 0.6, w: 8.9, h: 5 });
  s4.addText(CHURCH.photo.caption, {
    x: 0.8,
    y: 6,
    w: 11.7,
    h: 1,
    fontFace: font,
    fontSize: 36,
    color: 'FFFFFF',
    align: 'center',
  });
  s4.addNotes(CHURCH.photo.notes);

  const s5 = p.addSlide();
  s5.background = { color: 'FFFFFF' };
  s5.addText(CHURCH.pair.text, {
    shape: p.ShapeType.roundRect,
    rectRadius: 0.3,
    fill: { color: '1F4E79' },
    x: 3,
    y: 2.5,
    w: 7.3,
    h: 2.5,
    fontFace: font,
    fontSize: 40,
    color: 'FFFFFF',
    align: 'center',
    valign: 'middle',
  });
  s5.addNotes(CHURCH.pair.notes);

  const s6 = p.addSlide();
  s6.hidden = true;
  s6.background = { color: '3A3A3A' };
  s6.addText(CHURCH.hidden.text, {
    x: 0.8,
    y: 2.5,
    w: 11.7,
    h: 2,
    fontFace: font,
    fontSize: 48,
    color: 'FFFF66',
    align: 'center',
  });
  s6.addNotes(CHURCH.hidden.notes);

  const file = join(dir, 'Church deck.pptx');
  writeFileSync(file, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  return file;
}

// ---- the stored presentation ---------------------------------------------------------------------------

export type Obj = {
  id: string;
  type: 'text' | 'image' | 'shape';
  box: { x: number; y: number; w: number; h: number; rotation: number };
  text?: string;
  runs?: { start: number; end: number; [k: string]: unknown }[];
  paras?: (Record<string, unknown> | null)[];
  style?: Record<string, unknown>;
  mediaId?: string;
  crop?: { l: number; t: number; r: number; b: number };
  origin?: { src: string; shapeId?: number; ph?: string; role?: string; group?: number };
  locked?: boolean;
};
export type SlideRec = {
  id: string;
  objects: Obj[];
  notes?: string;
  hidden?: boolean;
  lyricObjectId?: string;
  backgroundMediaId?: string;
  /** The theme fields this slide overrides (`Slide.overrides`). */
  overrides?: string[];
  pptx?: { index: number; shown?: number; class: string; digest?: string };
  /** The slide's outgoing MIDI cues and Bottom-Third Stream text (`Slide.midiCues`, `bottomThirdText`). */
  midiCues?: { id: string; channel: number; type: string; number?: number; value?: number }[];
  bottomThirdText?: string;
};
export type PresentationRec = {
  id: string;
  rev: number;
  title: string;
  kind: string;
  sections: { id: string; slides: SlideRec[] }[];
  arrangements: { id: string; sectionIds: string[] }[];
  updatedAt?: string;
  createdAt?: string;
  [k: string]: unknown;
};

export const slidesOf = (p: Pick<PresentationRec, 'sections'>): SlideRec[] =>
  p.sections.flatMap((s) => s.slides);

/** Import the church deck (or another synthetic deck) as editable slides; the stored presentation. */
export async function importDeck(a: APIRequestContext, file: string): Promise<PresentationRec> {
  const job = await importPptx(a, file);
  return apiJson<PresentationRec>(a, `presentations/${job.result!.presentationId}`);
}

/** The stored presentation, as the hub has it now. */
export const stored = (a: APIRequestContext, id: string) =>
  apiJson<PresentationRec>(a, `presentations/${id}`);

// ---- the editor ----------------------------------------------------------------------------------------

/** What the editor reports on `window.__ordo.editor` (apps/operator/src/views/editor/inspect.ts). */
export type EditorInspect = {
  id?: string;
  baseRev?: number;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  slideId?: string;
  objectId?: string;
  objectIds: string[];
  draft?: PresentationRec;
};

/** What the editor holds now. */
export async function editorState(page: Page): Promise<EditorInspect> {
  return page.evaluate(
    () => (window as unknown as { __ordo: { editor(): EditorInspect } }).__ordo.editor() as EditorInspect,
  );
}

/** Sign in on the operator of `port` and open the editor on presentation `id`, its first slide shown. */
export async function openEditor(page: Page, port: number, id: string): Promise<void> {
  await login(page, opOrigin(port));
  await page.evaluate((pid) => {
    location.hash = `#/edit/${encodeURIComponent(pid)}`;
  }, id);
  await editorReady(page, id);
}

/** Wait until the editor shows presentation `id` with its canvas. */
export async function editorReady(page: Page, id: string): Promise<void> {
  await expect(page.locator('.canvasbox canvas').first()).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => {
      const s = await editorState(page).catch(() => undefined);
      return s?.id === id && !!s.draft;
    })
    .toBe(true);
}

/** Open slide `n` (1-based, authoring order) in the editor's slide list. */
export async function openSlide(page: Page, n: number): Promise<void> {
  await page
    .locator('.ed-slide')
    .nth(n - 1)
    .click();
  const slides = slidesOf((await editorState(page)).draft!);
  await expect.poll(async () => (await editorState(page)).slideId).toBe(slides[n - 1]!.id);
  await frames(page);
}

/** Two animation frames: the canvas has drawn what the editor holds. */
export async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
}

/** The screen point of a logical slide point (1920x1080) on the editor's canvas. */
export async function canvasPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const stage = page.locator('.canvasbox .konvajs-content').first();
  const b = (await stage.boundingBox())!;
  return { x: b.x + (x / 1920) * b.width, y: b.y + (y / 1080) * b.height };
}

/** Click an object at its box's centre (Alt-click selects one member of a group, design/27 §11 item 5). */
export async function clickObject(
  page: Page,
  o: Pick<Obj, 'box'>,
  opts: { alt?: boolean } = {},
): Promise<void> {
  const at = await canvasPoint(page, o.box.x + o.box.w / 2, o.box.y + o.box.h / 2);
  if (opts.alt) await page.keyboard.down('Alt');
  try {
    await page.mouse.click(at.x, at.y);
  } finally {
    if (opts.alt) await page.keyboard.up('Alt');
  }
}

/** Select a text object on the open slide and focus its text field. */
export async function selectText(page: Page, o: Pick<Obj, 'id' | 'box'>): Promise<void> {
  // The canvas takes clicks once it has drawn the slide's hit regions (a frame after the slide opens).
  await expect(async () => {
    await clickObject(page, o);
    expect((await editorState(page)).objectId).toBe(o.id);
  }).toPass({ timeout: 15_000 });
  await page.locator('#ordo-text-editor').focus();
}

/** Select `[start, end)` in the focused text field, as a volunteer's drag does. */
export async function selectRange(page: Page, start: number, end: number): Promise<void> {
  await page.locator('#ordo-text-editor').evaluate(
    (el, [s, e]) => {
      const t = el as HTMLTextAreaElement;
      t.focus();
      t.setSelectionRange(s!, e!);
      t.dispatchEvent(new Event('select', { bubbles: true }));
    },
    [start, end],
  );
}

/** Save (the toolbar button) and wait until the editor is saved, with no conflict. */
export async function save(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => {
      const s = await editorState(page);
      return !s.dirty && !s.saving && !s.conflict;
    })
    .toBe(true);
}

/** The presentation without what a save changes by itself (its revision and timestamps). */
export function content(p: PresentationRec): Omit<PresentationRec, 'rev' | 'updatedAt' | 'createdAt'> {
  const { rev: _rev, updatedAt: _u, createdAt: _c, ...rest } = p;
  return rest;
}

/**
 * The exit check of every M4 spec (design/27 §15 M4): Save, then reload the page and reopen the editor; the
 * draft that was saved, the stored presentation and the editor's presentation after the reload must be the
 * same JSON. Returns the stored presentation.
 */
export async function saveAndReload(page: Page, a: APIRequestContext, id: string): Promise<PresentationRec> {
  const before = (await editorState(page)).draft!;
  await save(page);
  const saved = await stored(a, id);
  expect(content(saved), 'the stored presentation is the draft that was saved').toEqual(content(before));
  await page.reload();
  await editorReady(page, id);
  const after = (await editorState(page)).draft!;
  expect(after, 'after a reload the editor holds the stored presentation exactly').toEqual(saved);
  return saved;
}
