/**
 * Pasting slide objects and text safely (design/21: clipboard HTML is untrusted input; design/15 "Clipboard"):
 * - an object paste keeps only objects that pass the schema (`SlideObject.safeParse`, its parsed data), the
 *   importers' sanitize dispatch and the render clamp, and drops their re-import identity (`origin.shapeId`,
 *   `ph`, `role`; the group stays so a pair still selects as one);
 * - the `data-ordo-objects` and `data-ordo-rich` payloads carry a format (`v`): ordo reads its own and the
 *   unversioned first format, and leaves a newer one alone;
 * - every add path stops at what the screens draw (`canAdd`: 200 objects, 16 pictures of a slide);
 * - the HTML reader stays linear and bounded on hostile HTML (the random inputs are in
 *   `clipboardHtml.fuzz.test.ts`).
 */
import {
  DEFAULT_THEME,
  type ImageObject,
  Presentation,
  type ShapeObject,
  SlideObject,
  type TextObject,
} from '@ordo/domain';
import { sanitizeObject } from '@ordo/importers/sanitize.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from '../src/state/toasts.ts';
import * as actions from '../src/views/editor/actions.ts';
import {
  currentObjects,
  openPresentation,
  selectObjects,
  selectSlide,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { getSlide, newShape, newText } from '../src/views/editor/ops.ts';
import {
  addRefusalText,
  CLIPBOARD_FORMAT,
  CLIPBOARD_LIMITS,
  canAdd,
  htmlToRichText,
  parseObjectsFromHtml,
  pastedObject,
  pasteRichText,
  richTextToHtml,
  serializeObjectsToHtml,
} from '../src/views/editor/ops/index.ts';

const bound = (ms: number) => ms * (process.env.CI ? 3 : 1);
const white = { r: 255, g: 255, b: 255, a: 1 };

const text = (id: string, extra: Partial<TextObject> = {}): TextObject => ({
  id,
  type: 'text',
  box: { x: 100, y: 100, w: 800, h: 200, rotation: 0 },
  text: 'Coffee after the service',
  style: { ...DEFAULT_THEME.textBoxDefaults },
  opacity: 1,
  ...extra,
});
const picture = (id: string, mediaId: string): ImageObject => ({
  id,
  type: 'image',
  box: { x: 0, y: 0, w: 400, h: 300, rotation: 0 },
  mediaId,
  fit: 'contain',
  opacity: 1,
  radius: 0,
});

/** `objects` as another page's clipboard HTML would carry them (any JSON, as a web page can write it). */
const payload = (objects: unknown[], extra: Record<string, unknown> = {}) =>
  `<meta charset="utf-8"><div data-ordo-objects="${JSON.stringify({ objects, ...extra })
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')}">x</div>`;

function deck(objects: SlideObject[]): Presentation {
  return {
    id: 'p-safe',
    rev: 1,
    title: 'Paste safety',
    kind: 'slides',
    meta: { tags: [] },
    sections: [
      {
        id: 'sec',
        label: 'Slides',
        short: 'S',
        slides: [
          { id: 's1', objects },
          { id: 's2', objects: [] },
        ],
      },
    ],
    arrangements: [{ id: 'a', name: 'Default', sectionIds: ['sec'] }],
    archived: false,
  } as Presentation;
}

const objectsOn = (slideId: string) => getSlide(useEditor.getState().draft!, slideId)!.objects;
const lastToast = () => useToasts.getState().list.at(-1)?.text;

describe('an object paste from the system clipboard', () => {
  it('keeps only objects that pass the schema, as the schema parsed them', () => {
    const html = payload([
      // No text and no style: the panel would crash on it, the hub refuse the save.
      { id: 'bad1', type: 'text', box: { x: 0, y: 0, w: 10, h: 10, rotation: 0 }, opacity: 1 },
      // A box no screen can draw.
      { ...newShape('rect'), id: 'bad2', box: { x: 0, y: 0, w: 1e300, h: 10, rotation: 0 } },
      { id: 'bad3', type: 'chart' },
      null,
      'text',
      // Valid, with a key no schema has.
      { ...text('ok'), evil: '<script>alert(1)</script>' },
    ]);
    const got = parseObjectsFromHtml(html);
    expect(got?.objects).toHaveLength(1);
    expect(got!.objects[0]!.id).toBe('ok');
    expect(got!.objects[0]).not.toHaveProperty('evil');
    expect(SlideObject.safeParse(got!.objects[0]).success).toBe(true);
  });

  it('drops the re-import identity and keeps the group (and `locked`, as Duplicate does)', () => {
    const shape: ShapeObject = {
      ...newShape('rect'),
      id: 'sh',
      locked: true,
      origin: { src: 'pptx', shapeId: 7, ph: 'title', role: 'body', group: 3 },
    };
    const lone = text('t', { origin: { src: 'pptx', shapeId: 9, ph: 'body' } });
    const got = parseObjectsFromHtml(payload([shape, lone]))!;
    expect(got.objects[0]!.origin).toEqual({ src: 'pptx', group: 3 });
    expect(got.objects[0]!.locked).toBe(true);
    expect(got.objects[1]!.origin).toBeUndefined();
  });

  it('reads its own format and the unversioned first one, and leaves a newer one alone', () => {
    const { html } = serializeObjectsToHtml([text('a')], 's1');
    expect(html).toContain(`&quot;v&quot;:${CLIPBOARD_FORMAT}`);
    expect(parseObjectsFromHtml(html)?.objects).toHaveLength(1);
    expect(parseObjectsFromHtml(payload([text('a')]))?.objects).toHaveLength(1);
    expect(parseObjectsFromHtml(payload([text('a')], { v: CLIPBOARD_FORMAT + 1 }))).toBeNull();
    expect(parseObjectsFromHtml(payload([text('a')], { v: '1' }))).toBeNull();
    // The rich-text payload too: a newer one falls back to the HTML's own text.
    const rich = richTextToHtml({ text: 'Amen', runs: [{ start: 0, end: 4, fontWeight: 700 }] });
    expect(rich).toContain(`&quot;v&quot;:${CLIPBOARD_FORMAT}`);
    expect(htmlToRichText(rich)?.runs).toEqual([{ start: 0, end: 4, fontWeight: 700 }]);
    const newer = `<div data-ordo-rich="${JSON.stringify({ v: 9, text: 'secret' }).replace(/"/g, '&quot;')}"><p>Amen</p></div>`;
    expect(htmlToRichText(newer)?.text).toBe('Amen');
  });

  it('runs each object through the sanitizer and keeps what it returns, schema-valid', () => {
    const spy = vi.fn((o: SlideObject) => sanitizeObject(o));
    const many = text('runs', {
      text: 'abcdef',
      // A run past the text and one out of order: the schema takes them, the sanitizer drops them.
      runs: [
        { start: 4, end: 99, fontWeight: 700 },
        { start: 0, end: 2, fontStyle: 'italic' },
      ],
      style: { ...DEFAULT_THEME.textBoxDefaults, fontSizePx: 4000 },
    });
    const got = parseObjectsFromHtml(payload([many, picture('p', 'm1')]), spy)!;
    expect(spy).toHaveBeenCalledTimes(2);
    const o = got.objects[0] as TextObject;
    expect(o.runs).toEqual([{ start: 4, end: 6, fontWeight: 700 }]);
    expect(o.style.fontSizePx).toBeLessThanOrEqual(1000);
    for (const x of got.objects) expect(SlideObject.safeParse(x).success).toBe(true);
    // A sanitizer that throws or refuses leaves the object out.
    expect(pastedObject(text('x'), () => undefined)).toBeUndefined();
    expect(
      pastedObject(text('x'), () => {
        throw new Error('no');
      }),
    ).toBeUndefined();
  });

  it('takes at most CLIPBOARD_LIMITS.objects objects', () => {
    const lots = Array.from({ length: 500 }, (_, i) => text(`t${i}`));
    expect(parseObjectsFromHtml(payload(lots))?.objects).toHaveLength(CLIPBOARD_LIMITS.objects);
  });

  it('pastes from the system clipboard through the real sanitizer, origin dropped, a fresh group kept', async () => {
    openPresentation(deck([text('t1')]));
    selectSlide('s2');
    const pair = [
      { ...newShape('rect'), id: 'a', origin: { src: 'pptx', shapeId: 4, group: 1 } },
      text('b', { origin: { src: 'pptx', shapeId: 5, ph: 'body', group: 1 } }),
      { id: 'junk', type: 'text' },
    ];
    const data = { getData: (t: string) => (t === 'text/html' ? payload(pair) : 'x') } as DataTransfer;
    const ids = await actions.tryPasteObjectsFromClipboard(data);
    expect(ids).toHaveLength(2);
    const pasted = objectsOn('s2');
    expect(pasted.map((o) => o.origin)).toEqual([
      { src: 'pptx', group: pasted[0]!.origin!.group },
      { src: 'pptx', group: pasted[0]!.origin!.group },
    ]);
    expect(Presentation.safeParse(useEditor.getState().draft).success).toBe(true);
  });

  it('says what was left out; nothing that fails is pasted, not even as text', async () => {
    openPresentation(deck([]));
    selectSlide('s1');
    const data = (objects: unknown[]) =>
      ({ getData: (t: string) => (t === 'text/html' ? payload(objects) : 'x') }) as DataTransfer;
    // Nothing passes: the paste is still the object paste (no text box made of the payload's text).
    const none = actions.tryPasteObjectsFromClipboard(data([{ id: 'x', type: 'text' }]));
    expect(none).not.toBeNull();
    expect(await none).toEqual([]);
    expect(objectsOn('s1')).toEqual([]);
    expect(lastToast()).toBe('1 pasted object could not be used on a slide: nothing was added.');
    // Some pass: they are pasted, and the toast says the rest was left out.
    const some = await actions.tryPasteObjectsFromClipboard(
      data([text('ok'), { id: 'y', type: 'shape' }, { id: 'z', type: 'text', box: {} }]),
    );
    expect(some).toHaveLength(1);
    expect(objectsOn('s1')).toHaveLength(1);
    expect(lastToast()).toBe(
      '2 pasted objects could not be used on a slide and were left out; the rest was pasted.',
    );
    // An empty or unreadable payload is not an object paste: the text is pasted instead.
    expect(actions.tryPasteObjectsFromClipboard(data([]))).toBeNull();
  });
});

describe('every add stops at what the screens draw (canAdd)', () => {
  const full = () => Array.from({ length: 200 }, (_, i) => text(`t${i}`));

  it('refuses past 200 objects and past 16 distinct pictures', () => {
    expect(canAdd({ objects: full().slice(1) }, [text('x')])).toBeNull();
    expect(canAdd({ objects: full() }, [text('x')])).toBe('objects');
    expect(canAdd({ objects: full().slice(2) }, [text('x'), text('y'), text('z')])).toBe('objects');
    const pics = Array.from({ length: 16 }, (_, i) => picture(`p${i}`, `m${i}`));
    expect(canAdd({ objects: pics }, [picture('n', 'm16')])).toBe('pictures');
    // Another copy of a picture the slide already shows costs nothing.
    expect(canAdd({ objects: pics }, [picture('n', 'm3')])).toBeNull();
    expect(canAdd({ objects: pics }, [text('x')])).toBeNull();
    expect(canAdd({ objects: [] }, [])).toBeNull();
    expect(addRefusalText('objects')).toMatch(/most objects a slide can show/);
    expect(addRefusalText('pictures')).toMatch(/most pictures a slide can show/);
  });

  beforeEach(() => useToasts.setState({ list: [] }));

  it('the toolbar add, Duplicate and an object paste each refuse on a full slide, with a toast', async () => {
    openPresentation(deck(full()));
    selectSlide('s1');
    expect(actions.addToSlide('s1', newText(DEFAULT_THEME))).toBe(false);
    expect(lastToast()).toMatch(/most objects a slide can show/);
    expect(objectsOn('s1')).toHaveLength(200);

    selectObjects(['t0']);
    actions.duplicateSelection();
    expect(objectsOn('s1')).toHaveLength(200);

    expect(actions.copySelection()).toBe(true);
    expect(await actions.tryPasteObjectsFromClipboard(null)).toEqual([]);
    expect(objectsOn('s1')).toHaveLength(200);
    expect(useEditor.getState().canUndo).toBe(false);

    // The other slide takes it.
    selectSlide('s2');
    expect(actions.addToSlide('s2', newText(DEFAULT_THEME))).toBe(true);
    expect(currentObjects()).toHaveLength(1);
  });

  it('a 17th picture is refused, with its own message', () => {
    openPresentation(deck(Array.from({ length: 16 }, (_, i) => picture(`p${i}`, `m${i}`))));
    expect(actions.mayAdd('s1', picture('n', 'm99'))).toBe(false);
    expect(lastToast()).toMatch(/most pictures a slide can show/);
    expect(actions.mayAdd('s1', picture('n', 'm0'))).toBe(true);
  });
});

describe('text paste bounds', () => {
  it('a paste never takes a text object past the schema’s 20,000 characters', () => {
    const o = text('t', { text: 'x'.repeat(19_990) });
    const r = pasteRichText(o, 5, 5, { text: '😀'.repeat(50) });
    expect(r.object.text.length).toBeLessThanOrEqual(CLIPBOARD_LIMITS.text);
    // Never half a surrogate pair.
    expect(/\p{Cs}/u.test(r.object.text)).toBe(false);
    expect(r.caret).toBe(5 + 10);
    expect(SlideObject.safeParse({ ...r.object, style: { ...r.object.style, color: white } }).success).toBe(
      true,
    );
  });

  it('reads hostile HTML in linear time without throwing', () => {
    const cases: [string, string][] = [
      ['deep nesting', '<div>'.repeat(200_000) + 'x'],
      ['unclosed tags', '<a href='.repeat(300_000)],
      ['unclosed comments', '<!--'.repeat(300_000)],
      ['unclosed scripts', '<script>'.repeat(300_000)],
      ['many paragraphs', '<p>verse</p>'.repeat(200_000)],
      ['bad references', '&#99999999999;&#x110000;&#0;'.repeat(50_000)],
      ['quotes', `<div title="${'"'.repeat(100_000)}">`],
      ['long attribute', `<div data-ordo-objects="${'a'.repeat(3_000_000)}">`],
      ['list nesting', '<ul><li>'.repeat(100_000)],
    ];
    for (const [name, html] of cases) {
      const t0 = performance.now();
      expect(() => htmlToRichText(html), name).not.toThrow();
      expect(() => parseObjectsFromHtml(html), name).not.toThrow();
      expect(performance.now() - t0, name).toBeLessThan(bound(3_000));
    }
    const r = htmlToRichText('<p>verse</p>'.repeat(200_000))!;
    expect(r.text.length).toBeLessThanOrEqual(CLIPBOARD_LIMITS.text);
    expect(htmlToRichText('a &#99999999999; b')?.text).toBe('a &#99999999999; b');
  });
});
