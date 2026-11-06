/**
 * M4 scaffold (apps/operator/src/views/editor/M4.md): every M4 op exists with its contract, returns its input
 * itself while it is a stub (so the editor records no undo step for it), and is wired into the editor store;
 * the selection contract; the component stubs mount and draw nothing. Each item replaces its stub
 * expectations here with real tests as it builds its ops (as M3's `pptx-scaffold.test.ts` did).
 */
import { ApiFailure } from '@ordo/client';
import { DEFAULT_THEME, type ImageObject, type Presentation, type TextObject } from '@ordo/domain';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { readReimportPlan, readReimportResult } from '../src/lib/pptxReimport.ts';
import * as actions from '../src/views/editor/actions.ts';
import { CanvasGuides } from '../src/views/editor/CanvasGuides.tsx';
import { CropControl, CropHandles } from '../src/views/editor/CropControl.tsx';
import {
  currentObjects,
  openPresentation,
  selectObject,
  selectObjects,
  selectSlide,
  undo,
  useEditor,
} from '../src/views/editor/editorStore.ts';
import { FormatBar } from '../src/views/editor/FormatBar.tsx';
import { mergeThreeWay, theirsOf } from '../src/views/editor/merge.ts';
import { applyTheme, getSlide } from '../src/views/editor/ops.ts';
import {
  applyStyleToSimilar,
  CLEAR_FORMATTING,
  deleteObjects,
  duplicateObjects,
  editText,
  findReplace,
  findText,
  formatRange,
  groupMembers,
  hideSlide,
  isLocked,
  moveObjects,
  newSlideLike,
  parasTouched,
  refitText,
  reorderObjects,
  replaceBackground,
  replacePicture,
  resizeRange,
  RUN_FIELDS,
  selectionParas,
  selectionStyle,
  setCrop,
  setFlip,
  setMask,
  setParas,
  similarObjects,
  themedRuns,
  transformGroup,
  ungroup,
  useAsBackground,
  VISUAL_RUN_FIELDS,
  withObject,
  withSlide,
} from '../src/views/editor/ops/index.ts';
import { ParagraphStrip } from '../src/views/editor/ParagraphStrip.tsx';

const box = { x: 100, y: 100, w: 800, h: 300, rotation: 0 };
/** "Potluck on Sunday 12 May": the date bold and coloured. */
const announcement = (): TextObject => ({
  id: 't1',
  type: 'text',
  box,
  text: 'Potluck on Sunday 12 May',
  style: { ...DEFAULT_THEME.textBoxDefaults, autofit: 'shrink', fitScale: { font: 0.9, spacing: 1 } },
  opacity: 1,
  runs: [{ start: 11, end: 24, fontWeight: 700, color: { r: 200, g: 40, b: 40, a: 1 } }],
  paras: [{ align: 'center' }],
});
const picture = (): ImageObject => ({
  id: 'i1',
  type: 'image',
  box: { x: 1000, y: 100, w: 800, h: 450, rotation: 0 },
  mediaId: 'photo',
  fit: 'cover',
  opacity: 1,
  radius: 0,
});
const deck = (): Presentation => ({
  id: 'p1',
  rev: 3,
  title: 'Announcements',
  kind: 'slides',
  meta: { tags: [] },
  sections: [
    {
      id: 'sec',
      label: 'Main',
      short: 'M',
      slides: [
        { id: 's1', objects: [announcement(), picture()] },
        { id: 's2', objects: [] },
      ],
    },
  ],
  arrangements: [{ id: 'a', name: 'Default', sectionIds: ['sec'] }],
  archived: false,
});

describe('the M4 ops (stubs keep their input)', () => {
  const p = deck();
  const t = announcement();
  const i = picture();
  const size = { id: 'other', width: 1000, height: 1000 };

  it('text ops (item A)', () => {
    expect(formatRange(t, 0, 7, { fontStyle: 'italic' })).toBe(t);
    expect(resizeRange(t, 0, 7, 1.1)).toBe(t);
    expect(setParas(t, 0, 0, { align: 'right' })).toBe(t);
    expect(refitText(t)).toBe(t);
    expect(themedRuns(t, [])).toBe(t);
    expect(selectionStyle(t, 11, 24)).toEqual({ style: {}, mixed: [] });
    expect(selectionParas(t, 0, 0)).toEqual({ para: {}, mixed: [] });
  });

  it('group ops (item B)', () => {
    expect(groupMembers(p.sections[0]!.slides[0]!, 't1')).toEqual(['t1']);
    expect(moveObjects(p, 's1', ['t1', 'i1'], 10, 0)).toBe(p);
    expect(transformGroup(p, 's1', ['t1', 'i1'], box, { ...box, w: 900 })).toBe(p);
    expect(deleteObjects(p, 's1', ['t1'])).toBe(p);
    expect(duplicateObjects(p, 's1', ['t1'])).toEqual({ p, ids: [] });
    expect(reorderObjects(p, 's1', ['t1'], 'front')).toBe(p);
    expect(ungroup(p, 's1', ['t1'])).toBe(p);
    expect(isLocked({ locked: true })).toBe(true);
    expect(isLocked({})).toBe(false);
  });

  it('picture ops (item D)', () => {
    expect(setCrop(i, { l: 0.1, t: 0, r: 0, b: 0 })).toBe(i);
    expect(setMask(i, { preset: 'ellipse' })).toBe(i);
    expect(setFlip(i, { flipH: true })).toBe(i);
    expect(replacePicture(i, size)).toBe(i);
  });

  it('slide ops (item E, built: apps/operator/test/slideOps.test.ts) keep their input when nothing changes', () => {
    expect(findText(p, 'Christmas')).toEqual([]);
    expect(findReplace(p, 'Sunday', 'Sunday')).toEqual({ p, replaced: 0 });
    expect(hideSlide(p, 's2', false)).toBe(p);
    expect(replaceBackground(p, 'gone', size, 'all')).toBe(p);
    expect(similarObjects(p, 's1', 't1')).toEqual([]);
    expect(applyStyleToSimilar(p, 's1', 't1')).toEqual({ p, changed: 0 });
    expect(newSlideLike(p, 'gone')).toEqual({ p });
    expect(useAsBackground(p, 's1', 'i1')).toBe(p);
  });
});

describe('text op contracts already in place', () => {
  it('editText is the domain edit: a typo fix inside the bold date keeps it bold, and keeps fitScale', () => {
    const t = announcement();
    const fixed = editText(t, 'Potluck on Sunday 19 May', 22);
    expect(fixed.runs).toEqual(t.runs);
    expect(fixed.style.fitScale).toEqual({ font: 0.9, spacing: 1 });
    expect(editText(t, t.text)).toBe(t);
  });

  it('CLEAR_FORMATTING removes every run field; a theme drops only the visual ones', () => {
    expect(Object.keys(CLEAR_FORMATTING).sort()).toEqual([...RUN_FIELDS].sort());
    expect(Object.values(CLEAR_FORMATTING).every((v) => v === undefined)).toBe(true);
    for (const k of VISUAL_RUN_FIELDS) expect(RUN_FIELDS).toContain(k);
    for (const k of ['fontWeight', 'fontStyle', 'underline', 'strike', 'baseline', 'caps'] as const)
      expect(VISUAL_RUN_FIELDS as readonly string[]).not.toContain(k);
  });

  it('parasTouched: a caret its paragraph, a selection every line it holds, soft lines with their paragraph', () => {
    const o = { text: 'one\ntwo\nthree\nfour', paras: [null, null, { soft: true }, null] };
    expect(parasTouched(o, 0, 0)).toEqual({ first: 0, last: 0 });
    expect(parasTouched(o, 5, 5)).toEqual({ first: 1, last: 2 });
    expect(parasTouched(o, 9, 9)).toEqual({ first: 1, last: 2 });
    expect(parasTouched(o, 0, 4)).toEqual({ first: 0, last: 0 });
    expect(parasTouched(o, 0, 5)).toEqual({ first: 0, last: 2 });
    expect(parasTouched(o, 15, 99)).toEqual({ first: 3, last: 3 });
  });

  it('applyTheme still keeps the lyric runs (themedRuns is a stub)', () => {
    const p = deck();
    const themed = applyTheme(p, DEFAULT_THEME);
    const t = getSlide(themed, 's1')!.objects[0] as TextObject;
    expect(t.runs).toEqual(announcement().runs);
    expect(t.paras).toEqual(announcement().paras);
  });

  it('withSlide and withObject keep identity when nothing changes', () => {
    const p = deck();
    expect(withSlide(p, 'nope', (s) => ({ ...s, hidden: true }))).toBe(p);
    expect(withSlide(p, 's1', (s) => s)).toBe(p);
    expect(withObject(p, 's1', 'nope', (o) => ({ ...o, opacity: 0.5 }))).toBe(p);
    expect(withObject(p, 's1', 't1', (o) => o)).toBe(p);
    const q = withObject(p, 's1', 't1', (o) => ({ ...o, opacity: 0.5 }));
    expect(getSlide(q, 's1')!.objects[0]!.opacity).toBe(0.5);
    expect(getSlide(q, 's2')).toBe(getSlide(p, 's2'));
  });
});

describe('the actions (store wiring)', () => {
  beforeEach(() => {
    openPresentation(deck());
    selectSlide('s1');
  });

  it('typing is one undo step, coalesced, and keeps the formatting', () => {
    actions.typeText('t1', 'Potluck on Sunday 19 May', 22);
    actions.typeText('t1', 'Potluck on Sunday 19 Ma', 23);
    let ed = useEditor.getState();
    expect(ed.dirty).toBe(true);
    const t = getSlide(ed.draft!, 's1')!.objects[0] as TextObject;
    expect(t.text).toBe('Potluck on Sunday 19 Ma');
    expect(t.runs![0]).toMatchObject({ start: 11, fontWeight: 700 });
    undo();
    ed = useEditor.getState();
    expect((getSlide(ed.draft!, 's1')!.objects[0] as TextObject).text).toBe('Potluck on Sunday 12 May');
    expect(ed.canUndo).toBe(false);
  });

  it('an op that changes nothing records no undo step and no unsaved change', () => {
    const before = useEditor.getState().draft;
    actions.formatSelection('t1', 0, 7, { fontStyle: 'italic' });
    actions.setParagraphs('t1', 0, 0, { align: 'right' });
    actions.refit('t1');
    actions.cropPicture('i1', { l: 0.1, t: 0, r: 0, b: 0 });
    actions.maskPicture('i1', { preset: 'ellipse' });
    actions.flipPicture('i1', { flipV: true });
    actions.replacePictureWith('i1', { id: 'other', width: 10, height: 10 });
    actions.setSlideHidden('s2', false);
    actions.replaceBackgroundWith('gone', { id: 'other' }, 'slide');
    actions.pictureToBackground('i1');
    expect(actions.findAndReplace('Christmas', 'Easter')).toBe(0);
    expect(actions.applyToSimilar('t1')).toBe(0);
    actions.addSlideLike('gone');
    selectObjects(['t1', 'i1']);
    actions.moveSelection(10, 0);
    actions.transformSelection(box, { ...box, x: 200 });
    actions.reorderSelection('back');
    actions.ungroupSelection();
    actions.duplicateSelection();
    actions.deleteSelection();
    const ed = useEditor.getState();
    expect(ed.draft).toBe(before);
    expect(ed.dirty).toBe(false);
    expect(ed.canUndo).toBe(false);
  });

  it('leaves locked objects alone', () => {
    openPresentation({
      ...deck(),
      sections: [
        { ...deck().sections[0]!, slides: [{ id: 's1', objects: [{ ...announcement(), locked: true }] }] },
      ],
    });
    actions.typeText('t1', 'Changed');
    expect(useEditor.getState().dirty).toBe(false);
  });
});

describe('the selection (design/27 §11 item 5)', () => {
  beforeEach(() => {
    openPresentation(deck());
    selectSlide('s1');
  });

  it('one object is the whole selection; several keep the slide z order and their primary', () => {
    selectObject('i1');
    expect(useEditor.getState()).toMatchObject({ objectId: 'i1', objectIds: ['i1'] });
    selectObjects(['i1', 't1', 'gone']);
    expect(useEditor.getState()).toMatchObject({ objectId: 'i1', objectIds: ['t1', 'i1'] });
    selectObjects(['i1', 't1'], 't1');
    expect(useEditor.getState().objectId).toBe('t1');
    expect(currentObjects().map((o) => o.id)).toEqual(['t1', 'i1']);
    selectObject(undefined);
    expect(useEditor.getState()).toMatchObject({ objectId: undefined, objectIds: [] });
    selectObjects(['i1']);
    selectSlide('s2');
    expect(useEditor.getState()).toMatchObject({ objectId: undefined, objectIds: [] });
  });
});

describe('the component stubs', () => {
  it('mount and draw nothing yet', () => {
    const range = { start: 0, end: 4 };
    for (const el of [
      createElement(FormatBar, { o: announcement(), range, readOnly: false }),
      createElement(ParagraphStrip, { o: announcement(), range, readOnly: false }),
      createElement(CropControl, { o: picture(), readOnly: false }),
    ])
      expect(renderToStaticMarkup(el)).toBe('');
    expect(CropHandles({ objects: [], scale: 0.5, readOnly: false })).toBeNull();
    expect(CanvasGuides({ objects: [], scale: 0.5 })).toBeNull();
  });
});

describe('merge on 409 (item H)', () => {
  it('never merges while it is a stub', () => {
    const p = deck();
    expect(mergeThreeWay(p, p, p).merged).toBeUndefined();
  });

  it('theirsOf reads the version that won from a 409, and nothing else', () => {
    const current = deck();
    expect(theirsOf(new ApiFailure(409, 'conflict', 'Changed', { rev: 3, current }))?.id).toBe('p1');
    expect(theirsOf(new ApiFailure(409, 'conflict', 'Changed', { current: { id: 'x' } }))).toBeUndefined();
    expect(theirsOf(new ApiFailure(423, 'locked', 'Locked', { current }))).toBeUndefined();
    expect(theirsOf(new Error('409'))).toBeUndefined();
  });
});

describe("'Re-import from PowerPoint' answers (item F)", () => {
  it('reads a plan and a result defensively', () => {
    expect(readReimportPlan(undefined)).toBeUndefined();
    expect(
      readReimportPlan({
        presentationId: 'p1',
        fileId: 'deck',
        slides: [
          { slideId: 's1', number: 1, kind: 'page', action: 'replace', userObjects: 2 },
          { slideId: 's2', number: 2, kind: 'future-kind', action: 'replace' },
          'garbage',
        ],
      }),
    ).toEqual({
      presentationId: 'p1',
      fileId: 'deck',
      slides: [{ slideId: 's1', number: 1, kind: 'page', action: 'replace', userObjects: 2 }],
    });
    expect(readReimportResult({ presentationId: 'p1', rev: 4, regenerated: 3, replaced: -1 })).toEqual({
      presentationId: 'p1',
      rev: 4,
      regenerated: 3,
      keptEdited: 0,
      replaced: 0,
      userObjects: 0,
    });
    expect(readReimportResult({ rev: 4 })).toBeUndefined();
  });
});
