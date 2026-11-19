import {
  type Box,
  type ImageObject,
  type Media,
  placeCells,
  playingObject,
  type Presentation,
  type Section,
  type ShapeObject,
  type Slide,
  type SlideObject,
  TABLE_LIMITS,
  type TextObject,
  type Theme,
} from '@ordo/domain';
import {
  type ContextMenuEntry,
  fmtShortcut,
  normalizeContextMenuEntries,
} from '../../components/ContextMenu.tsx';
import {
  alignSelection,
  applyToSimilar,
  canRowCol,
  copySelection,
  copySlideSelection,
  copyTableCellSelection,
  cropPicture,
  cutSelection,
  cutSlideSelection,
  cutTableCellSelection,
  deleteSelection,
  distributeTableCols,
  distributeTableRows,
  duplicateSelection,
  flipPicture,
  maskPicture,
  mergeTableCells,
  moveTableCol,
  moveTableRow,
  pictureToBackground,
  placeSelection,
  refit,
  removeSlideBackground,
  reorderSelection,
  rowCol,
  setSlideHidden,
  setTableBandedRows,
  setTableHeaderRow,
  splitTableCell,
  ungroupSelection,
} from './actions.ts';
import { startCrop } from './CropControl.tsx';
import {
  change,
  selectCell,
  selectCellRange,
  selectObject,
  selectObjects,
  useEditor,
} from './editorStore.ts';
import { makePlaying, playInPlace, posterOnly, setPlay } from './mediaOps.ts';
import {
  duplicateSlide,
  markOverride,
  newShape,
  newText,
  resetSlideToTheme,
  updateObject,
  updateSlide,
} from './ops.ts';
import {
  canMergeCells,
  canMoveCol,
  canMoveRow,
  canSplitCell,
  clearTableCells,
  groupMembers,
  hasBandedRows,
  hasGroup,
  hasHeaderRow,
  isLocked,
  newTable,
  normalizeRange,
  type TableRange,
} from './ops/index.ts';
import { coversSlide, slideBackground } from './ops/slides.ts';
import { type AlignTo, nearBox, placementArea, presetIn } from './placement.ts';
import { fitTable } from './tableFit.ts';
import { type ContrastMode, contrastChoice } from './TextControls.tsx';

const PLACEMENT_PRESETS: readonly { id: string; label: string; box: Box }[] = [
  { id: 'center', label: 'Center Screen', box: { x: 120, y: 140, w: 1680, h: 800, rotation: 0 } },
  { id: 'lower-third', label: 'Lower Third', box: { x: 120, y: 720, w: 1680, h: 280, rotation: 0 } },
  { id: 'bottom', label: 'Bottom Third', box: { x: 120, y: 640, w: 1680, h: 380, rotation: 0 } },
  { id: 'top', label: 'Top Banner', box: { x: 120, y: 80, w: 1680, h: 280, rotation: 0 } },
];

const ALIGN_ENTRIES: readonly [AlignTo, string][] = [
  ['left', 'Align left'],
  ['cx', 'Center horizontally'],
  ['right', 'Align right'],
  ['top', 'Align top'],
  ['cy', 'Center vertically'],
  ['bottom', 'Align bottom'],
];

const SHAPE_CHOICES: readonly [ShapeObject['shape'], string][] = [
  ['rect', 'Rectangle'],
  ['ellipse', 'Ellipse'],
  ['line', 'Line'],
];

const CONTRAST_CHOICES: readonly [ContrastMode, string][] = [
  ['clean', 'Clean (none)'],
  ['shadow', 'Shadow'],
  ['outline', 'Outline'],
  ['heavy', 'Heavy (outline + shadow)'],
];

export type CanvasContextMenuArgs = {
  p: Presentation;
  slide: Slide;
  theme: Theme;
  readOnly: boolean;
  objectIds: readonly string[];
  primaryId?: string;
  cell?: number;
  cellRange?: TableRange;
  mediaLookup: (id: string) => Media | undefined;
  onPaste: (plainOnly: boolean) => void;
  onEditText: (objectId: string) => void;
  onOpenInspector: (tab: 'object' | 'slide') => void;
  onOpenBackgroundPicker: () => void;
  onOpenImagePicker: () => void;
  onOpenVideoPicker: () => void;
  onReplacePicture: (objectId: string) => void;
  onReplaceVideo: (objectId: string) => void;
  onAddObject: (o: SlideObject) => void;
  onToast?: (msg: string, tone?: 'ok' | 'warn' | 'error') => void;
};

function alignSubmenu(disabled: boolean): ContextMenuEntry {
  return {
    kind: 'submenu',
    label: 'Align to slide',
    disabled,
    items: ALIGN_ENTRIES.map(([to, label]) => ({
      label,
      disabled,
      onSelect: () => alignSelection(to),
    })),
  };
}

function arrangeSubmenu(disabled: boolean): ContextMenuEntry {
  return {
    kind: 'submenu',
    label: 'Arrange',
    disabled,
    items: [
      { label: 'Bring to front', disabled, onSelect: () => reorderSelection('front') },
      { label: 'Bring forward', disabled, onSelect: () => reorderSelection('forward') },
      { label: 'Send backward', disabled, onSelect: () => reorderSelection('backward') },
      { label: 'Send to back', disabled, onSelect: () => reorderSelection('back') },
    ],
  };
}

function buildTextObjectMenu(o: TextObject, args: CanvasContextMenuArgs): ContextMenuEntry[] {
  const { p, slide, readOnly } = args;
  const isSong = p.kind === 'song';
  const isLyric =
    isSong &&
    (slide.lyricObjectId === o.id ||
      (!slide.lyricObjectId && slide.objects.find((x) => x.type === 'text')?.id === o.id));
  const themed = isLyric && !!p.themeId;
  const area = placementArea(p);
  const currentContrast: ContrastMode =
    o.style.outline && o.style.shadow
      ? 'heavy'
      : o.style.outline
        ? 'outline'
        : o.style.shadow
          ? 'shadow'
          : 'clean';

  return normalizeContextMenuEntries([
    { label: 'Edit text', shortcut: 'Enter', disabled: readOnly, onSelect: () => args.onEditText(o.id) },
    { kind: 'separator' },
    { label: 'Cut', shortcut: fmtShortcut('X'), disabled: readOnly, onSelect: () => void cutSelection() },
    { label: 'Copy', shortcut: fmtShortcut('C'), onSelect: () => void copySelection() },
    { label: 'Paste', shortcut: fmtShortcut('V'), disabled: readOnly, onSelect: () => args.onPaste(false) },
    {
      label: 'Duplicate',
      shortcut: fmtShortcut('D'),
      disabled: readOnly,
      onSelect: () => duplicateSelection(),
    },
    { kind: 'separator' },
    {
      kind: 'submenu',
      label: 'Screen placement',
      disabled: readOnly,
      items: PLACEMENT_PRESETS.map((preset) => {
        const targetBox = presetIn(preset.box, area);
        return {
          label: preset.label,
          checked: nearBox(o.box, targetBox),
          disabled: readOnly,
          onSelect: () => placeSelection((_from, a) => presetIn(preset.box, a)),
        };
      }),
    },
    {
      kind: 'submenu',
      label: 'Contrast',
      disabled: readOnly,
      items: CONTRAST_CHOICES.map(([mode, label]) => ({
        label,
        checked: currentContrast === mode,
        disabled: readOnly,
        onSelect: () => {
          const choice = contrastChoice(o.style, mode);
          change((q) => {
            let next = updateObject(q, slide.id, o.id, (x) =>
              x.type === 'text' ? { ...x, style: choice.style } : x,
            );
            if (themed && choice.overrides.length) {
              next = updateSlide(next, slide.id, (s) => choice.overrides.reduce(markOverride, s));
            }
            return next;
          });
        },
      })),
    },
    alignSubmenu(readOnly),
    { label: 'Re-fit text', disabled: readOnly, onSelect: () => refit(o.id) },
    isSong &&
      !isLyric && {
        label: 'Set as lyric box',
        disabled: readOnly,
        onSelect: () => change((q) => updateSlide(q, slide.id, (s) => ({ ...s, lyricObjectId: o.id }))),
      },
    {
      label: 'Apply style to similar boxes',
      disabled: readOnly,
      onSelect: () => {
        const n = applyToSimilar(o.id);
        args.onToast?.(
          n ? `Applied style to ${n} similar ${n === 1 ? 'box' : 'boxes'}.` : 'No other similar boxes found.',
          n ? 'ok' : 'warn',
        );
      },
    },
    { kind: 'separator' },
    arrangeSubmenu(readOnly),
    { label: 'Open inspector', onSelect: () => args.onOpenInspector('object') },
    { kind: 'separator' },
    { label: 'Delete', shortcut: 'Del', danger: true, disabled: readOnly, onSelect: () => deleteSelection() },
  ]);
}

function buildShapeObjectMenu(o: ShapeObject, args: CanvasContextMenuArgs): ContextMenuEntry[] {
  const { slide, readOnly } = args;
  return normalizeContextMenuEntries([
    { label: 'Cut', shortcut: fmtShortcut('X'), disabled: readOnly, onSelect: () => void cutSelection() },
    { label: 'Copy', shortcut: fmtShortcut('C'), onSelect: () => void copySelection() },
    { label: 'Paste', shortcut: fmtShortcut('V'), disabled: readOnly, onSelect: () => args.onPaste(false) },
    {
      label: 'Duplicate',
      shortcut: fmtShortcut('D'),
      disabled: readOnly,
      onSelect: () => duplicateSelection(),
    },
    { kind: 'separator' },
    !o.geom && {
      kind: 'submenu',
      label: 'Change shape',
      disabled: readOnly,
      items: SHAPE_CHOICES.map(([shape, label]) => ({
        label,
        checked: o.shape === shape,
        disabled: readOnly,
        onSelect: () =>
          change((q) => updateObject(q, slide.id, o.id, (x) => (x.type === 'shape' ? { ...x, shape } : x))),
      })),
    },
    alignSubmenu(readOnly),
    arrangeSubmenu(readOnly),
    { label: 'Open style inspector', onSelect: () => args.onOpenInspector('object') },
    { kind: 'separator' },
    { label: 'Delete', shortcut: 'Del', danger: true, disabled: readOnly, onSelect: () => deleteSelection() },
  ]);
}

function buildImageOrVideoMenu(o: ImageObject, args: CanvasContextMenuArgs): ContextMenuEntry[] {
  const { p, slide, readOnly, mediaLookup } = args;
  const mediaItem = mediaLookup(o.mediaId);
  const isVideoMedia = mediaItem?.kind === 'video' || !!o.play;
  const currentPlaying = playingObject(slide);
  const isThisPlaying = !!o.play && currentPlaying?.id === o.id;
  const anotherPlaying = !!o.play && !!currentPlaying && currentPlaying.id !== o.id;
  const canUseAsBg = coversSlide(p, o) && !o.play;

  const videoEntries: (ContextMenuEntry | false)[] = isVideoMedia
    ? [
        { kind: 'separator' },
        o.play
          ? {
              label: 'Use poster only',
              disabled: readOnly,
              onSelect: () => change((q) => updateObject(q, slide.id, o.id, posterOnly)),
            }
          : {
              label: 'Play video in place',
              disabled: readOnly,
              onSelect: () => change((q) => updateObject(q, slide.id, o.id, playInPlace)),
            },
        anotherPlaying && {
          label: 'Play this one instead',
          disabled: readOnly,
          onSelect: () => change((q) => makePlaying(q, slide.id, o.id)),
        },
        !!o.play && {
          kind: 'submenu',
          label: 'Playback',
          disabled: readOnly,
          items: [
            {
              label: 'Auto-start with slide',
              checked: o.play.start !== 'click',
              disabled: readOnly,
              onSelect: () =>
                change((q) =>
                  updateObject(q, slide.id, o.id, (x) =>
                    setPlay(x, { start: o.play?.start === 'click' ? 'auto' : 'click' }),
                  ),
                ),
            },
            {
              label: 'Loop',
              checked: !!o.play.loop,
              disabled: readOnly,
              onSelect: () =>
                change((q) => updateObject(q, slide.id, o.id, (x) => setPlay(x, { loop: !o.play?.loop }))),
            },
            {
              label: 'Mute audio',
              checked: !!o.play.muted,
              disabled: readOnly,
              onSelect: () =>
                change((q) => updateObject(q, slide.id, o.id, (x) => setPlay(x, { muted: !o.play?.muted }))),
            },
            { kind: 'separator' },
            {
              label: 'Hold last frame on end',
              checked: (o.play.onEnd ?? 'hold') === 'hold',
              disabled: readOnly,
              onSelect: () =>
                change((q) => updateObject(q, slide.id, o.id, (x) => setPlay(x, { onEnd: 'hold' }))),
            },
            {
              label: 'Go black on end',
              checked: o.play.onEnd === 'black',
              disabled: readOnly,
              onSelect: () =>
                change((q) => updateObject(q, slide.id, o.id, (x) => setPlay(x, { onEnd: 'black' }))),
            },
            {
              label: 'Advance slide on end',
              checked: o.play.onEnd === 'advance',
              disabled: readOnly,
              onSelect: () =>
                change((q) => updateObject(q, slide.id, o.id, (x) => setPlay(x, { onEnd: 'advance' }))),
            },
          ],
        },
        isThisPlaying && { kind: 'label', label: 'Plays on this slide' },
      ]
    : [];

  return normalizeContextMenuEntries([
    { label: 'Cut', shortcut: fmtShortcut('X'), disabled: readOnly, onSelect: () => void cutSelection() },
    { label: 'Copy', shortcut: fmtShortcut('C'), onSelect: () => void copySelection() },
    { label: 'Paste', shortcut: fmtShortcut('V'), disabled: readOnly, onSelect: () => args.onPaste(false) },
    {
      label: 'Duplicate',
      shortcut: fmtShortcut('D'),
      disabled: readOnly,
      onSelect: () => duplicateSelection(),
    },
    { kind: 'separator' },
    !isVideoMedia && { label: 'Crop…', disabled: readOnly, onSelect: () => startCrop(o.id) },
    !isVideoMedia &&
      !!o.crop && { label: 'Reset crop', disabled: readOnly, onSelect: () => cropPicture(o.id, undefined) },
    {
      label: isVideoMedia ? 'Replace video…' : 'Replace image…',
      disabled: readOnly,
      onSelect: () => (isVideoMedia ? args.onReplaceVideo(o.id) : args.onReplacePicture(o.id)),
    },
    !isVideoMedia && {
      kind: 'submenu',
      label: 'Mask',
      disabled: readOnly,
      items: [
        {
          label: 'None',
          checked: !o.mask,
          disabled: readOnly,
          onSelect: () => maskPicture(o.id, undefined),
        },
        {
          label: 'Rounded',
          checked: o.mask?.preset === 'roundRect',
          disabled: readOnly,
          onSelect: () => maskPicture(o.id, { preset: 'roundRect' }),
        },
        {
          label: 'Oval',
          checked: o.mask?.preset === 'ellipse',
          disabled: readOnly,
          onSelect: () => maskPicture(o.id, { preset: 'ellipse' }),
        },
      ],
    },
    {
      kind: 'submenu',
      label: 'Fit',
      disabled: readOnly,
      items: [
        {
          label: 'Contain',
          checked: (o.fit ?? 'contain') === 'contain',
          disabled: readOnly,
          onSelect: () =>
            change((q) =>
              updateObject(q, slide.id, o.id, (x) => (x.type === 'image' ? { ...x, fit: 'contain' } : x)),
            ),
        },
        {
          label: 'Cover',
          checked: o.fit === 'cover',
          disabled: readOnly,
          onSelect: () =>
            change((q) =>
              updateObject(q, slide.id, o.id, (x) => (x.type === 'image' ? { ...x, fit: 'cover' } : x)),
            ),
        },
        {
          label: 'Stretch',
          checked: o.fit === 'stretch',
          disabled: readOnly,
          onSelect: () =>
            change((q) =>
              updateObject(q, slide.id, o.id, (x) => (x.type === 'image' ? { ...x, fit: 'stretch' } : x)),
            ),
        },
      ],
    },
    {
      kind: 'submenu',
      label: 'Flip',
      disabled: readOnly,
      items: [
        {
          label: 'Flip horizontal',
          checked: !!o.flipH,
          disabled: readOnly,
          onSelect: () => flipPicture(o.id, { flipH: !o.flipH }),
        },
        {
          label: 'Flip vertical',
          checked: !!o.flipV,
          disabled: readOnly,
          onSelect: () => flipPicture(o.id, { flipV: !o.flipV }),
        },
      ],
    },
    canUseAsBg && {
      label: 'Use as slide background',
      disabled: readOnly,
      onSelect: () => pictureToBackground(o.id),
    },
    ...videoEntries,
    { kind: 'separator' },
    alignSubmenu(readOnly),
    arrangeSubmenu(readOnly),
    { label: 'Open inspector', onSelect: () => args.onOpenInspector('object') },
    { kind: 'separator' },
    { label: 'Delete', shortcut: 'Del', danger: true, disabled: readOnly, onSelect: () => deleteSelection() },
  ]);
}

function buildTableMenu(o: ShapeObject, args: CanvasContextMenuArgs): ContextMenuEntry[] {
  const { readOnly, cell, cellRange } = args;
  const t = o.table!;
  const hasCell = cell !== undefined || !!cellRange;
  const activeRange =
    cellRange ?? (cell !== undefined ? normalizeRange(t, { r0: 0, c0: 0, r1: 0, c1: 0 }) : undefined);
  const canMerge = !!cellRange && canMergeCells(t, cellRange);
  const canSplit = cell !== undefined && canSplitCell(t, cell);

  if (hasCell) {
    return normalizeContextMenuEntries([
      {
        label: cellRange ? 'Cut cells' : 'Cut cell',
        shortcut: fmtShortcut('X'),
        disabled: readOnly,
        onSelect: () => void cutTableCellSelection(),
      },
      {
        label: cellRange ? 'Copy cells' : 'Copy cell',
        shortcut: fmtShortcut('C'),
        onSelect: () => void copyTableCellSelection(),
      },
      {
        label: 'Paste',
        shortcut: fmtShortcut('V'),
        disabled: readOnly,
        onSelect: () => args.onPaste(false),
      },
      {
        label: 'Paste plain text',
        shortcut: fmtShortcut('V', { shift: true }),
        disabled: readOnly,
        onSelect: () => args.onPaste(true),
      },
      {
        label: cellRange ? 'Clear cell contents' : 'Clear cell',
        shortcut: 'Del',
        disabled: readOnly,
        onSelect: () => {
          const slideId = useEditor.getState().slideId;
          if (!slideId) return;
          change((q) =>
            updateObject(q, slideId, o.id, (x) =>
              x.type === 'shape' && x.table ? fitTable(x, clearTableCells(x, cell, cellRange)) : x,
            ),
          );
        },
      },
      { kind: 'separator' },
      {
        kind: 'submenu',
        label: 'Insert',
        disabled: readOnly,
        items: [
          {
            label: 'Row above',
            disabled: readOnly || !canRowCol(t, 'rowAbove', cell),
            onSelect: () => {
              const next = rowCol(o.id, 'rowAbove', cell);
              if (next !== undefined) selectCell(o.id, next);
            },
          },
          {
            label: 'Row below',
            disabled: readOnly || !canRowCol(t, 'rowBelow', cell),
            onSelect: () => {
              const next = rowCol(o.id, 'rowBelow', cell);
              if (next !== undefined) selectCell(o.id, next);
            },
          },
          {
            label: 'Column left',
            disabled: readOnly || !canRowCol(t, 'colLeft', cell),
            onSelect: () => {
              const next = rowCol(o.id, 'colLeft', cell);
              if (next !== undefined) selectCell(o.id, next);
            },
          },
          {
            label: 'Column right',
            disabled: readOnly || !canRowCol(t, 'colRight', cell),
            onSelect: () => {
              const next = rowCol(o.id, 'colRight', cell);
              if (next !== undefined) selectCell(o.id, next);
            },
          },
        ],
      },
      canMerge && {
        label: 'Merge cells',
        disabled: readOnly,
        onSelect: () => void mergeTableCells(o.id, cellRange!),
      },
      canSplit && {
        label: 'Split cell',
        disabled: readOnly,
        onSelect: () => void splitTableCell(o.id, cell!),
      },
      {
        kind: 'submenu',
        label: 'Table options',
        disabled: readOnly,
        items: [
          {
            label: 'Distribute columns evenly',
            disabled: readOnly,
            onSelect: () => distributeTableCols(o.id, cellRange ?? activeRange),
          },
          {
            label: 'Distribute rows evenly',
            disabled: readOnly,
            onSelect: () => distributeTableRows(o.id, cellRange ?? activeRange),
          },
          { kind: 'separator' },
          {
            label: 'Header row',
            checked: hasHeaderRow(t),
            disabled: readOnly,
            onSelect: () => setTableHeaderRow(o.id, !hasHeaderRow(t)),
          },
          {
            label: 'Banded rows',
            checked: hasBandedRows(t),
            disabled: readOnly,
            onSelect: () => setTableBandedRows(o.id, !hasBandedRows(t)),
          },
        ],
      },
      { kind: 'separator' },
      {
        label: 'Delete row',
        danger: true,
        disabled: readOnly || !canRowCol(t, 'deleteRow', cell),
        onSelect: () => {
          const next = rowCol(o.id, 'deleteRow', cell);
          selectCell(o.id, next);
        },
      },
      {
        label: 'Delete column',
        danger: true,
        disabled: readOnly || !canRowCol(t, 'deleteCol', cell),
        onSelect: () => {
          const next = rowCol(o.id, 'deleteCol', cell);
          selectCell(o.id, next);
        },
      },
      { kind: 'separator' },
      { label: 'Select entire table', shortcut: 'Esc', onSelect: () => selectCell(o.id, undefined) },
      { label: 'Open table inspector', onSelect: () => args.onOpenInspector('object') },
    ]);
  }

  return normalizeContextMenuEntries([
    {
      label: 'Cut table',
      shortcut: fmtShortcut('X'),
      disabled: readOnly,
      onSelect: () => void cutSelection(),
    },
    { label: 'Copy table', shortcut: fmtShortcut('C'), onSelect: () => void copySelection() },
    { label: 'Paste', shortcut: fmtShortcut('V'), disabled: readOnly, onSelect: () => args.onPaste(false) },
    {
      label: 'Duplicate table',
      shortcut: fmtShortcut('D'),
      disabled: readOnly,
      onSelect: () => duplicateSelection(),
    },
    { kind: 'separator' },
    {
      label: 'Distribute columns evenly',
      disabled: readOnly,
      onSelect: () => distributeTableCols(o.id),
    },
    {
      label: 'Distribute rows evenly',
      disabled: readOnly,
      onSelect: () => distributeTableRows(o.id),
    },
    {
      label: 'Header row',
      checked: hasHeaderRow(t),
      disabled: readOnly,
      onSelect: () => setTableHeaderRow(o.id, !hasHeaderRow(t)),
    },
    {
      label: 'Banded rows',
      checked: hasBandedRows(t),
      disabled: readOnly,
      onSelect: () => setTableBandedRows(o.id, !hasBandedRows(t)),
    },
    { kind: 'separator' },
    alignSubmenu(readOnly),
    arrangeSubmenu(readOnly),
    { label: 'Open table inspector', onSelect: () => args.onOpenInspector('object') },
    { kind: 'separator' },
    {
      label: 'Delete table',
      shortcut: 'Del',
      danger: true,
      disabled: readOnly,
      onSelect: () => deleteSelection(),
    },
  ]);
}

/** Build the canvas context menu for the current selection (empty canvas, single object, table, multi-select, locked). */
export function buildCanvasContextMenu(args: CanvasContextMenuArgs): ContextMenuEntry[] {
  const { p, slide, theme, readOnly, objectIds, primaryId } = args;
  const selectedObjs = slide.objects.filter((o) => objectIds.includes(o.id));
  const primary = primaryId ? slide.objects.find((o) => o.id === primaryId) : selectedObjs[0];

  // Empty canvas (no object selected)
  if (!primary || selectedObjs.length === 0) {
    const hasOwnBg = !!slide.backgroundMediaId || !!slideBackground(p, slide);
    const hasThemeOverrides = !!p.themeId && (slide.overrides?.length ?? 0) > 0;
    return normalizeContextMenuEntries([
      { label: 'Paste', shortcut: fmtShortcut('V'), disabled: readOnly, onSelect: () => args.onPaste(false) },
      {
        label: 'Paste as plain text',
        shortcut: fmtShortcut('V', { shift: true }),
        disabled: readOnly,
        onSelect: () => args.onPaste(true),
      },
      { kind: 'separator' },
      {
        kind: 'submenu',
        label: 'Insert',
        disabled: readOnly,
        items: [
          { label: 'Text box', disabled: readOnly, onSelect: () => args.onAddObject(newText(theme)) },
          { label: 'Image…', disabled: readOnly, onSelect: () => args.onOpenImagePicker() },
          { label: 'Video…', disabled: readOnly, onSelect: () => args.onOpenVideoPicker() },
          { kind: 'separator' },
          { label: 'Rectangle', disabled: readOnly, onSelect: () => args.onAddObject(newShape('rect')) },
          { label: 'Ellipse', disabled: readOnly, onSelect: () => args.onAddObject(newShape('ellipse')) },
          { label: 'Line', disabled: readOnly, onSelect: () => args.onAddObject(newShape('line')) },
          { kind: 'separator' },
          {
            label: 'Table (3×3)',
            disabled: readOnly,
            onSelect: () => args.onAddObject(newTable(theme, { rows: 3, cols: 3 })),
          },
        ],
      },
      { kind: 'separator' },
      {
        label: 'Change background…',
        disabled: readOnly,
        onSelect: () => args.onOpenBackgroundPicker(),
      },
      hasOwnBg && {
        label: p.backgroundMediaId ? 'Use presentation background' : 'Remove background',
        disabled: readOnly,
        onSelect: () => removeSlideBackground(slide.id),
      },
      {
        label: slide.hidden ? 'Show slide' : 'Hide slide',
        disabled: readOnly,
        onSelect: () => setSlideHidden(slide.id, !slide.hidden),
      },
      hasThemeOverrides && {
        label: 'Reset slide to theme',
        disabled: readOnly,
        onSelect: () => change((q) => updateSlide(q, slide.id, (s) => resetSlideToTheme(s, theme))),
      },
      { kind: 'separator' },
      { label: 'Copy slide', shortcut: fmtShortcut('C'), onSelect: () => void copySlideSelection() },
      {
        label: 'Cut slide',
        shortcut: fmtShortcut('X'),
        disabled: readOnly,
        onSelect: () => void cutSlideSelection(),
      },
      {
        label: 'Duplicate slide',
        disabled: readOnly,
        onSelect: () => change((q) => duplicateSlide(q, slide.id)),
      },
      { kind: 'separator' },
      slide.objects.length > 0 && {
        label: 'Select all objects',
        onSelect: () =>
          selectObjects(
            slide.objects.map((o) => o.id),
            slide.objects[slide.objects.length - 1]?.id,
          ),
      },
      { label: 'Open slide inspector', onSelect: () => args.onOpenInspector('slide') },
    ]);
  }

  // Multi-selection (2+ objects)
  if (selectedObjs.length > 1) {
    const grouped = hasGroup(selectedObjs);
    return normalizeContextMenuEntries([
      { kind: 'label', label: `${selectedObjs.length} objects selected` },
      { label: 'Cut', shortcut: fmtShortcut('X'), disabled: readOnly, onSelect: () => void cutSelection() },
      { label: 'Copy', shortcut: fmtShortcut('C'), onSelect: () => void copySelection() },
      { label: 'Paste', shortcut: fmtShortcut('V'), disabled: readOnly, onSelect: () => args.onPaste(false) },
      {
        label: 'Duplicate',
        shortcut: fmtShortcut('D'),
        disabled: readOnly,
        onSelect: () => duplicateSelection(),
      },
      { kind: 'separator' },
      alignSubmenu(readOnly),
      arrangeSubmenu(readOnly),
      grouped && { label: 'Ungroup', disabled: readOnly, onSelect: () => ungroupSelection() },
      { label: 'Open inspector', onSelect: () => args.onOpenInspector('object') },
      { kind: 'separator' },
      {
        label: `Delete ${selectedObjs.length} objects`,
        shortcut: 'Del',
        danger: true,
        disabled: readOnly,
        onSelect: () => deleteSelection(),
      },
    ]);
  }

  // Locked PowerPoint art / SmartArt
  if (isLocked(primary)) {
    return normalizeContextMenuEntries([
      { kind: 'label', label: 'Locked imported object' },
      { label: 'Copy', shortcut: fmtShortcut('C'), onSelect: () => void copySelection() },
      {
        label: 'Duplicate',
        shortcut: fmtShortcut('D'),
        disabled: readOnly,
        onSelect: () => duplicateSelection(),
      },
      { kind: 'separator' },
      arrangeSubmenu(readOnly),
      { label: 'Open inspector', onSelect: () => args.onOpenInspector('object') },
      { kind: 'separator' },
      {
        label: 'Delete',
        shortcut: 'Del',
        danger: true,
        disabled: readOnly,
        onSelect: () => deleteSelection(),
      },
    ]);
  }

  // Single object by type
  let entries: ContextMenuEntry[];
  if (primary.type === 'text') {
    entries = buildTextObjectMenu(primary, args);
  } else if (primary.type === 'image') {
    entries = buildImageOrVideoMenu(primary, args);
  } else if (primary.type === 'shape' && primary.table) {
    entries = buildTableMenu(primary, args);
  } else {
    entries = buildShapeObjectMenu(primary as ShapeObject, args);
  }

  // If this single selected object belongs to a PowerPoint group, offer group navigation right before Delete.
  const members = groupMembers(slide, primary.id);
  if (members.length > 1) {
    const groupEntries: ContextMenuEntry[] = [
      { kind: 'separator' },
      {
        label: `Select entire group (${members.length})`,
        onSelect: () => selectObjects(members, primary.id),
      },
      {
        label: 'Take out of group',
        disabled: readOnly,
        onSelect: () => ungroupSelection(),
      },
    ];
    const deleteIdx = entries.findIndex(
      (e) => e.kind !== 'separator' && e.kind !== 'label' && e.kind !== 'submenu' && e.danger,
    );
    if (deleteIdx > 0) {
      entries = normalizeContextMenuEntries([
        ...entries.slice(0, deleteIdx),
        ...groupEntries,
        { kind: 'separator' },
        ...entries.slice(deleteIdx),
      ]);
    }
  }

  return entries;
}

/** Build context menu for a table row or column grip rail in TableCanvasOverlay. */
export function buildTableRailContextMenu(args: {
  o: ShapeObject;
  axis: 'row' | 'col';
  index: number;
  readOnly: boolean;
}): ContextMenuEntry[] {
  const { o, axis, index, readOnly } = args;
  const t = o.table;
  if (!t) return [];
  const p = placeCells(t);
  const { R, C } = p;
  const anchorSlot = axis === 'row' ? p.slots[index * C] : p.slots[index];
  const anchorCell = anchorSlot !== undefined && anchorSlot >= 0 ? anchorSlot : 0;
  const range: TableRange =
    axis === 'row'
      ? normalizeRange(t, { r0: index, c0: 0, r1: index, c1: C - 1 })
      : normalizeRange(t, { r0: 0, c0: index, r1: R - 1, c1: index });

  if (axis === 'row') {
    return normalizeContextMenuEntries([
      { kind: 'label', label: `Row ${index + 1}` },
      {
        label: 'Insert row above',
        disabled: readOnly || !canRowCol(t, 'rowAbove', anchorCell) || R >= TABLE_LIMITS.rows,
        onSelect: () => {
          const next = rowCol(o.id, 'rowAbove', anchorCell);
          if (next !== undefined) selectCell(o.id, next);
        },
      },
      {
        label: 'Insert row below',
        disabled: readOnly || !canRowCol(t, 'rowBelow', anchorCell) || R >= TABLE_LIMITS.rows,
        onSelect: () => {
          const next = rowCol(o.id, 'rowBelow', anchorCell);
          if (next !== undefined) selectCell(o.id, next);
        },
      },
      { kind: 'separator' },
      {
        label: 'Move row up',
        disabled: readOnly || index <= 0 || !canMoveRow(t, index, index - 1),
        onSelect: () => void moveTableRow(o.id, index, index - 1),
      },
      {
        label: 'Move row down',
        disabled: readOnly || index >= R - 1 || !canMoveRow(t, index, index + 1),
        onSelect: () => void moveTableRow(o.id, index, index + 1),
      },
      {
        label: 'Distribute rows evenly',
        disabled: readOnly,
        onSelect: () => distributeTableRows(o.id),
      },
      { kind: 'separator' },
      {
        label: 'Copy row',
        onSelect: () => {
          selectCellRange(o.id, anchorCell, range);
          copyTableCellSelection();
        },
      },
      {
        label: 'Clear row contents',
        disabled: readOnly,
        onSelect: () => {
          const slideId = useEditor.getState().slideId;
          if (!slideId) return;
          change((q) =>
            updateObject(q, slideId, o.id, (x) =>
              x.type === 'shape' && x.table ? fitTable(x, clearTableCells(x, anchorCell, range)) : x,
            ),
          );
        },
      },
      { kind: 'separator' },
      {
        label: 'Delete row',
        danger: true,
        disabled: readOnly || !canRowCol(t, 'deleteRow', anchorCell),
        onSelect: () => {
          const next = rowCol(o.id, 'deleteRow', anchorCell);
          selectCell(o.id, next);
        },
      },
    ]);
  }

  return normalizeContextMenuEntries([
    { kind: 'label', label: `Column ${index + 1}` },
    {
      label: 'Insert column left',
      disabled: readOnly || !canRowCol(t, 'colLeft', anchorCell) || C >= TABLE_LIMITS.cols,
      onSelect: () => {
        const next = rowCol(o.id, 'colLeft', anchorCell);
        if (next !== undefined) selectCell(o.id, next);
      },
    },
    {
      label: 'Insert column right',
      disabled: readOnly || !canRowCol(t, 'colRight', anchorCell) || C >= TABLE_LIMITS.cols,
      onSelect: () => {
        const next = rowCol(o.id, 'colRight', anchorCell);
        if (next !== undefined) selectCell(o.id, next);
      },
    },
    { kind: 'separator' },
    {
      label: 'Move column left',
      disabled: readOnly || index <= 0 || !canMoveCol(t, index, index - 1),
      onSelect: () => void moveTableCol(o.id, index, index - 1),
    },
    {
      label: 'Move column right',
      disabled: readOnly || index >= C - 1 || !canMoveCol(t, index, index + 1),
      onSelect: () => void moveTableCol(o.id, index, index + 1),
    },
    {
      label: 'Distribute columns evenly',
      disabled: readOnly,
      onSelect: () => distributeTableCols(o.id),
    },
    { kind: 'separator' },
    {
      label: 'Copy column',
      onSelect: () => {
        selectCellRange(o.id, anchorCell, range);
        copyTableCellSelection();
      },
    },
    {
      label: 'Clear column contents',
      disabled: readOnly,
      onSelect: () => {
        const slideId = useEditor.getState().slideId;
        if (!slideId) return;
        change((q) =>
          updateObject(q, slideId, o.id, (x) =>
            x.type === 'shape' && x.table ? fitTable(x, clearTableCells(x, anchorCell, range)) : x,
          ),
        );
      },
    },
    { kind: 'separator' },
    {
      label: 'Delete column',
      danger: true,
      disabled: readOnly || !canRowCol(t, 'deleteCol', anchorCell),
      onSelect: () => {
        const next = rowCol(o.id, 'deleteCol', anchorCell);
        selectCell(o.id, next);
      },
    },
  ]);
}

/** Build context menu for a slide thumbnail card in SlidesPanel. */
export function buildSlideCardContextMenu(args: {
  slide: Slide;
  p: Presentation;
  readOnly: boolean;
  onCopy: () => void;
  onCut: () => void;
  onPaste: () => void;
  onDuplicate: () => void;
  onNewLike: () => void;
  onToggleHidden: (hidden: boolean) => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onSplit?: () => void;
  onMerge?: () => void;
  onResetToTheme?: () => void;
  onDelete: () => void;
}): ContextMenuEntry[] {
  const { slide, p, readOnly } = args;
  const hidden = !!slide.hidden;
  const hasOverrides = !!p.themeId && (slide.overrides?.length ?? 0) > 0;
  return normalizeContextMenuEntries([
    { label: 'Copy slide', shortcut: fmtShortcut('C'), onSelect: args.onCopy },
    { label: 'Cut slide', shortcut: fmtShortcut('X'), disabled: readOnly, onSelect: args.onCut },
    { label: 'Paste slide after', shortcut: fmtShortcut('V'), disabled: readOnly, onSelect: args.onPaste },
    { label: 'Duplicate slide', disabled: readOnly, onSelect: args.onDuplicate },
    { label: 'New slide like this', disabled: readOnly, onSelect: args.onNewLike },
    { kind: 'separator' },
    {
      label: hidden ? 'Show slide' : 'Hide slide',
      disabled: readOnly,
      onSelect: () => args.onToggleHidden(!hidden),
    },
    hasOverrides &&
      args.onResetToTheme && {
        label: 'Reset to theme',
        disabled: readOnly,
        onSelect: args.onResetToTheme,
      },
    { kind: 'separator' },
    args.onMoveUp && { label: 'Move slide up', disabled: readOnly, onSelect: args.onMoveUp },
    args.onMoveDown && { label: 'Move slide down', disabled: readOnly, onSelect: args.onMoveDown },
    (args.onSplit || args.onMerge) && { kind: 'separator' as const },
    args.onSplit && { label: 'Split lyrics', disabled: readOnly, onSelect: args.onSplit },
    args.onMerge && { label: 'Merge with next', disabled: readOnly, onSelect: args.onMerge },
    { kind: 'separator' },
    { label: 'Delete slide', danger: true, disabled: readOnly, onSelect: args.onDelete },
  ]);
}

/** Build context menu for a section header in SlidesPanel. */
export function buildSectionHeaderContextMenu(args: {
  section: Section;
  index: number;
  totalSections: number;
  readOnly: boolean;
  onAddSlide: () => void;
  onDuplicateSection: () => void;
  onRename: () => void;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDelete: () => void;
}): ContextMenuEntry[] {
  const { readOnly } = args;
  return normalizeContextMenuEntries([
    { label: 'Add slide to section', disabled: readOnly, onSelect: args.onAddSlide },
    { label: 'Duplicate section', disabled: readOnly, onSelect: args.onDuplicateSection },
    { label: 'Rename section', disabled: readOnly, onSelect: args.onRename },
    { kind: 'separator' },
    args.onMoveUp && { label: 'Move section up', disabled: readOnly, onSelect: args.onMoveUp },
    args.onMoveDown && { label: 'Move section down', disabled: readOnly, onSelect: args.onMoveDown },
    { kind: 'separator' },
    { label: 'Delete section…', danger: true, disabled: readOnly, onSelect: args.onDelete },
  ]);
}

/** Keep `selectObject` referenced for helper callers if needed. */
export { selectObject };
