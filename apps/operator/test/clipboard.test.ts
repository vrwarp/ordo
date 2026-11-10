import {
  DEFAULT_THEME,
  type ImageObject,
  type Presentation,
  type ShapeObject,
  type TextObject,
} from '@ordo/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import * as actions from '../src/views/editor/actions.ts';
import {
  currentObjects,
  openPresentation,
  selectObjects,
  selectSlide,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { getSlide } from '../src/views/editor/ops.ts';
import {
  htmlToRichText,
  parseObjectsFromHtml,
  pasteObjects,
  pasteRichText,
  richTextToHtml,
  serializeObjectsToHtml,
  sliceRichText,
} from '../src/views/editor/ops/index.ts';

const box = { x: 120, y: 140, w: 1200, h: 400, rotation: 0 };

function makeRichTextObject(): TextObject {
  return {
    id: 't1',
    type: 'text',
    box,
    text: '16 For God so loved the world\nThat he gave his only Son',
    style: { ...DEFAULT_THEME.text },
    opacity: 1,
    runs: [
      { start: 0, end: 2, baseline: 0.3, sizeScale: 0.75, fontWeight: 700 },
      {
        start: 14,
        end: 19,
        fontStyle: 'italic',
        underline: true,
        color: { r: 250, g: 204, b: 21, a: 1 },
        outline: { width: 2, color: { r: 0, g: 0, b: 0, a: 1 } },
      },
      { start: 30, end: 55, fontWeight: 700, caps: 'small', letterSpacing: 2 },
    ],
    paras: [
      { align: 'center', spaceAfterPx: 12 },
      { align: 'left', bullet: { char: '•' } },
    ],
  };
}

function makeDeck(): Presentation {
  const shape: ShapeObject = {
    id: 'sh1',
    type: 'shape',
    box: { x: 100, y: 100, w: 400, h: 200, rotation: 0 },
    shape: 'rect',
    fill: { r: 30, g: 60, b: 120, a: 1 },
    opacity: 1,
    radius: 8,
    origin: { group: 1 },
  };
  const label: TextObject = {
    ...makeRichTextObject(),
    origin: { group: 1 },
  };
  const pic: ImageObject = {
    id: 'img1',
    type: 'image',
    box: { x: 600, y: 100, w: 500, h: 300, rotation: 0 },
    mediaId: 'm1',
    fit: 'cover',
    opacity: 1,
    radius: 0,
  };
  return {
    id: 'p-clip',
    rev: 1,
    title: 'Clipboard Deck',
    kind: 'song',
    themeId: DEFAULT_THEME.id,
    meta: { tags: [] },
    sections: [
      {
        id: 'sec1',
        label: 'Verse 1',
        short: 'V1',
        slides: [
          { id: 's1', lyricObjectId: 't1', objects: [shape, label, pic] },
          { id: 's2', objects: [] },
        ],
      },
    ],
    arrangements: [{ id: 'arr1', name: 'Default', sectionIds: ['sec1'] }],
    archived: false,
  };
}

function mockClipboardData(): {
  data: DataTransfer;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  const data = {
    setData: (type: string, val: string) => {
      store.set(type, val);
    },
    getData: (type: string) => store.get(type) ?? '',
    items: [],
    files: [],
  } as unknown as DataTransfer;
  return { data, store };
}

describe('Layer 1: Intra-Ordo lossless rich text copy, cut & paste', () => {
  it('slices rich text with 0-indexed runs and paragraph styles and round-trips through HTML losslessly', () => {
    const o = makeRichTextObject();
    // Slice across the newline: "loved the world\nThat he gave" (offsets 14..42)
    const slice = sliceRichText(o, 14, 42);
    expect(slice.text).toBe('loved the world\nThat he gave');
    expect(slice.runs).toEqual([
      {
        start: 0,
        end: 5,
        fontStyle: 'italic',
        underline: true,
        color: { r: 250, g: 204, b: 21, a: 1 },
        outline: { width: 2, color: { r: 0, g: 0, b: 0, a: 1 } },
      },
      {
        start: 16,
        end: 28,
        fontWeight: 700,
        caps: 'small',
        letterSpacing: 2,
      },
    ]);
    expect(slice.paras).toEqual([
      { align: 'center', spaceAfterPx: 12 },
      { align: 'left', bullet: { char: '•' } },
    ]);

    const html = richTextToHtml(slice, o.style);
    expect(html).toContain('data-ordo-rich=');
    expect(html).toContain('<i><u><span');

    const decoded = htmlToRichText(html, o.style);
    expect(decoded).toEqual(slice);
  });

  it('splices rich text into a target TextObject and preserves both target and pasted formatting', () => {
    const o = makeRichTextObject();
    const badgeSlice = sliceRichText(o, 0, 3); // "16 " with superscript + sizeScale + bold
    const target: TextObject = {
      id: 't2',
      type: 'text',
      box,
      text: 'Hello world',
      style: { ...DEFAULT_THEME.text },
      opacity: 1,
      runs: [{ start: 6, end: 11, fontStyle: 'italic' }],
    };

    const res = pasteRichText(target, 6, 6, badgeSlice);
    expect(res.object.text).toBe('Hello 16 world');
    expect(res.caret).toBe(9);
    expect(res.overrides).toContain('runs.sizeScale');
    expect(res.object.runs).toEqual([
      { start: 6, end: 8, baseline: 0.3, sizeScale: 0.75, fontWeight: 700 },
      { start: 9, end: 14, fontStyle: 'italic' },
    ]);
  });

  it('supports copyTextSelection, cutTextSelection, and handleTextPaste through editor actions with undo', () => {
    openPresentation(makeDeck());
    selectSlide('s1');
    const clip = mockClipboardData();
    const s1 = () => getSlide(useEditor.getState().draft!, 's1')!;
    const t1 = () => s1().objects.find((x) => x.id === 't1') as TextObject;

    // Copy "loved" (14..19) which has italic, underline, gold color, and black outline.
    const copied = actions.copyTextSelection(t1(), 14, 19, clip.data);
    expect(copied?.text).toBe('loved');
    expect(clip.store.get('text/plain')).toBe('loved');
    expect(clip.store.get('text/html')).toContain('data-ordo-rich=');

    // Paste at the end of line 2 (offset 55)
    const caret = actions.handleTextPaste(t1(), 55, 55, clip.data);
    expect(caret).toBe(60);
    expect(t1().text.endsWith('Sonloved')).toBe(true);
    const lastRun = t1().runs![t1().runs!.length - 1]!;
    expect(lastRun).toMatchObject({
      start: 55,
      end: 60,
      fontStyle: 'italic',
      underline: true,
      color: { r: 250, g: 204, b: 21, a: 1 },
    });
    // Marks theme overrides on the lyric slide!
    expect(s1().overrides).toEqual(expect.arrayContaining(['runs.color', 'runs.outline']));

    // Undo restores the exact previous state in one step.
    undo();
    expect(t1().text).toBe('16 For God so loved the world\nThat he gave his only Son');
  });
});

describe('Layer 2: Cross-application HTML <-> Ordo rich text conversion', () => {
  it('converts Bible Gateway / Logos scripture HTML with superscript verse numbers and red-letter words', () => {
    const bibleHtml = `
      <div class="passage-text">
        <p>
          <sup class="versenum">16&nbsp;</sup>For God so loved the world,
          <span class="woj">that he gave his <i>only</i> Son</span>
        </p>
      </div>
    `;
    const parsed = htmlToRichText(bibleHtml, DEFAULT_THEME.text);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe('16 For God so loved the world, that he gave his only Son');
    expect(parsed!.runs).toEqual([
      { start: 0, end: 3, baseline: 0.3 },
      { start: 31, end: 48, color: { r: 220, g: 38, b: 38, a: 1 } },
      { start: 48, end: 52, color: { r: 220, g: 38, b: 38, a: 1 }, fontStyle: 'italic' },
      { start: 52, end: 56, color: { r: 220, g: 38, b: 38, a: 1 } },
    ]);
  });

  it('filters out default dark body text colors from Google Docs/Word when pasting into a light-text slide box', () => {
    const gdocsHtml = `
      <p style="text-align: center">
        <span style="color: #000000; background-color: #ffffff; font-weight: 700">Sunday Service</span>
        <span style="color: rgb(34, 34, 34)"> at </span>
        <span style="color: #eab308; background-color: #1e293b; text-decoration: underline">10:00 AM</span>
      </p>
    `;
    // Target box has white text (DEFAULT_THEME.text.color is white)
    const parsedForDarkSlide = htmlToRichText(gdocsHtml, DEFAULT_THEME.text)!;
    expect(parsedForDarkSlide.text).toBe('Sunday Service at 10:00 AM');
    expect(parsedForDarkSlide.runs).toEqual([
      // #000000 and #ffffff were stripped so text uses the slide's white color, while bold is kept!
      { start: 0, end: 14, fontWeight: 700 },
      // Intentional gold color (#eab308) and dark highlight (#1e293b) are preserved!
      {
        start: 18,
        end: 26,
        color: { r: 234, g: 179, b: 8, a: 1 },
        highlight: { r: 30, g: 41, b: 59, a: 1 },
        underline: true,
      },
    ]);
    expect(parsedForDarkSlide.paras).toEqual([{ align: 'center' }]);

    // When pasting into a light-background slide box (where text is dark), dark inline color is kept.
    const darkTextStyle = { ...DEFAULT_THEME.text, color: { r: 20, g: 20, b: 20, a: 1 } };
    const parsedForLightSlide = htmlToRichText(gdocsHtml, darkTextStyle)!;
    expect(parsedForLightSlide.runs?.[0]?.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('converts HTML bulleted and numbered lists into Ordo paragraphs with bullet metadata', () => {
    const listHtml = `
      <ul>
        <li>Welcome &amp; Announcements</li>
        <li>Opening Prayer</li>
      </ul>
      <ol start="3">
        <li>Scripture Reading</li>
      </ol>
    `;
    const parsed = htmlToRichText(listHtml, DEFAULT_THEME.text)!;
    expect(parsed.text).toBe('Welcome & Announcements\nOpening Prayer\nScripture Reading');
    expect(parsed.paras).toEqual([
      { bullet: { char: '•' } },
      { bullet: { char: '•' } },
      { bullet: { auto: 'arabicPeriod', startAt: 3 } },
    ]);
  });

  it('plain text paste (Paste and Match Style) inherits the surrounding run formatting', () => {
    const o = makeRichTextObject();
    // Paste plain text inside "loved" (14..19, italic + underline + gold)
    const res = pasteRichText(o, 16, 16, { text: 'GREATLY' });
    const runAtInsert = res.object.runs?.find((r) => r.start <= 16 && r.end >= 23);
    expect(runAtInsert).toMatchObject({
      fontStyle: 'italic',
      underline: true,
      color: { r: 250, g: 204, b: 21, a: 1 },
    });
  });
});

describe('Layer 3: Slide canvas object copy, cut & paste', () => {
  beforeEach(() => {
    openPresentation(makeDeck());
    selectSlide('s1');
  });

  it('serializes and parses slide objects via data-ordo-objects HTML and clones them with fresh IDs and groups', () => {
    const p = useEditor.getState().draft!;
    const s1 = getSlide(p, 's1')!;
    const { html, text } = serializeObjectsToHtml(s1.objects.slice(0, 2), 's1');
    expect(html).toContain('data-ordo-objects=');
    expect(text).toContain('16 For God so loved the world');

    const parsed = parseObjectsFromHtml(html);
    expect(parsed?.sourceSlideId).toBe('s1');
    expect(parsed?.objects).toHaveLength(2);

    const res = pasteObjects(p, 's1', parsed!.objects, { dx: 20, dy: 20 });
    const nextS1 = getSlide(res.p, 's1')!;
    expect(nextS1.objects).toHaveLength(5);
    expect(res.ids).toHaveLength(2);

    const [copyShape, copyText] = nextS1.objects.slice(3);
    expect(copyShape!.id).not.toBe('sh1');
    expect(copyText!.id).not.toBe('t1');
    expect(copyShape!.box.x).toBe(120);
    expect(copyShape!.box.y).toBe(120);
    // Both copies share a fresh group ID distinct from the original group 1!
    expect(copyShape!.origin?.group).toBeDefined();
    expect(copyShape!.origin?.group).not.toBe(1);
    expect(copyShape!.origin?.group).toBe(copyText!.origin?.group);
  });

  it('copies objects on slide 1 (offsetting on same slide) and pastes at original coordinates on slide 2', () => {
    const clip = mockClipboardData();
    selectObjects(['sh1', 't1'], 't1');
    expect(actions.copySelection(clip.data)).toBe(true);

    // Paste onto the same slide (s1): offsets by (+20, +20)
    const idsSame = actions.tryPasteObjectsFromClipboard(clip.data);
    expect(idsSame).toHaveLength(2);
    const pastedOnS1 = currentObjects();
    expect(pastedOnS1[0]!.box.x).toBe(120);
    expect(pastedOnS1[0]!.box.y).toBe(120);

    // Switch to slide 2 and paste: lands at exact original coordinates (100, 100)!
    selectSlide('s2');
    const freshClip = mockClipboardData();
    freshClip.data.setData('text/html', clip.store.get('text/html')!);
    freshClip.data.setData('text/plain', clip.store.get('text/plain')!);
    const idsOther = actions.tryPasteObjectsFromClipboard(freshClip.data);
    expect(idsOther).toHaveLength(2);
    const pastedOnS2 = currentObjects();
    expect(pastedOnS2[0]!.box.x).toBe(100);
    expect(pastedOnS2[0]!.box.y).toBe(100);
  });

  it('cuts objects from a slide and pastes them back at their original position', () => {
    const clip = mockClipboardData();
    selectObjects(['img1']);
    expect(actions.cutSelection(clip.data)).toBe(true);
    expect(getSlide(useEditor.getState().draft!, 's1')!.objects.some((o) => o.id === 'img1')).toBe(false);

    const ids = actions.tryPasteObjectsFromClipboard(clip.data);
    expect(ids).toHaveLength(1);
    const restored = currentObjects()[0]!;
    expect(restored.type).toBe('image');
    expect(restored.box.x).toBe(600);
    expect(restored.box.y).toBe(100);
  });
});
