import type { Rgba, SlideObject, TextObject, TextStyle } from '@ordo/domain';
import { useState } from 'react';
import { AlignIcon } from '../../components/AlignIcons.tsx';
import { ColorPill, PaintPill, type PaintValue } from '../../components/ColorPicker.tsx';
import { FontPicker } from '../../components/FontPicker.tsx';
import { Menu } from '../../components/Menu.tsx';
import {
  alignSelection,
  deleteSelection,
  duplicateSelection,
  formatSelection,
  pictureToBackground,
  reorderSelection,
  replacePictureWith,
  resizeSelection,
  ungroupSelection,
} from './actions.ts';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import { endCrop, startCrop, useCropMode } from './CropControl.tsx';
import { change, useEditor } from './editorStore.ts';
import { barState, HIGHLIGHTS, SIZE_STEP, togglePatch, valuePatch } from './FormatBar.tsx';
import { refocusText } from './formatControls.tsx';
import { geomInfo, shapeName, withDash, withFill, withGradient } from './ObjectShapeFields.tsx';
import { getSlide, markOverride, updateObject, updateSlide } from './ops.ts';
import { hasGroup, isLocked } from './ops/group.ts';
import { coversSlide } from './ops/slides.ts';
import { CLEAR_FORMATTING, type RunPatch, selectionStyle } from './ops/text.ts';
import type { AlignTo } from './placement.ts';
import { fitMessage } from './textFit.ts';

/** The multi-selection bar's Align menu: where, what it says, its accessible name. */
const ALIGN_ITEMS: readonly [AlignTo, string, string][] = [
  ['left', '⇤ Align left', 'Align left'],
  ['cx', '⇹ Center horizontally', 'Center horizontally'],
  ['right', '⇥ Align right', 'Align right'],
  ['top', '⤒ Align top', 'Align top'],
  ['cy', '⇳ Center vertically', 'Center vertically'],
  ['bottom', '⤓ Align bottom', 'Align bottom'],
];

export interface FloatingContextBarProps {
  readOnly: boolean;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}

/**
 * Proposal B ("Canvas-First") Floating Contextual Formatting & Action Bar:
 * Floats cleanly above the selected object on the stage so 90% of formatting happens in-context
 * without a permanent right sidebar, while `More…` opens the focused Slide-Over Tune Drawer.
 */
export function FloatingContextBar({ readOnly, drawerOpen, onToggleDrawer }: FloatingContextBarProps) {
  const draft = useEditor((s) => s.draft);
  const slideId = useEditor((s) => s.slideId);
  const objectId = useEditor((s) => s.objectId);
  const objectIds = useEditor((s) => s.objectIds);
  const range = useEditor((s) => s.textRange);
  const croppingId = useCropMode((s) => s.objectId);
  const [replacingMedia, setReplacingMedia] = useState(false);

  if (!draft || !slideId || !objectId) return null;
  const slide = getSlide(draft, slideId);
  const o = slide?.objects.find((x) => x.id === objectId);
  if (!o) return null;

  const locked = isLocked(o);
  const off = readOnly || locked;
  const selectedObjs = slide?.objects.filter((x) => objectIds.includes(x.id)) ?? [];
  const grouped = hasGroup(selectedObjs);
  const multi = objectIds.length > 1;

  const isSong = draft.kind === 'song';
  const isLyric =
    isSong &&
    (slide?.lyricObjectId === o.id ||
      (!slide?.lyricObjectId && slide?.objects.find((x) => x.type === 'text')?.id === o.id));
  const themed = isLyric && !!draft.themeId;

  const setObj = (fn: (x: SlideObject) => SlideObject, key?: string, overridePath?: string | string[]) => {
    const paths =
      overridePath === undefined ? [] : typeof overridePath === 'string' ? [overridePath] : overridePath;
    if (readOnly || (locked && !(paths.length === 1 && paths[0] === 'box'))) return;
    change((p) => {
      let q = updateObject(p, slideId, o.id, fn);
      if (themed && paths.length) q = updateSlide(q, slideId, (s) => paths.reduce(markOverride, s));
      return q;
    }, key);
  };

  const layerMenu = (
    <Menu
      label="Layer"
      disabled={readOnly}
      items={[
        { label: '⤒ Bring to front', name: 'Front', onSelect: () => reorderSelection('front') },
        { label: '↑ Bring forward', name: 'Forward', onSelect: () => reorderSelection('forward') },
        { label: '↓ Send backward', name: 'Backward', onSelect: () => reorderSelection('backward') },
        { label: '⤓ Send to back', name: 'Back', onSelect: () => reorderSelection('back') },
      ]}
    />
  );

  const tailActions = (
    <>
      <span className="ed-fbar-sep" />
      {grouped && !readOnly && (
        <button
          type="button"
          className="small ghost"
          onClick={() => ungroupSelection()}
          title="Ungroup selection"
        >
          Ungroup
        </button>
      )}
      {layerMenu}
      <button
        type="button"
        className="small ghost ed-fbar-icon"
        disabled={readOnly}
        aria-label="Duplicate object"
        title="Duplicate (Ctrl+D)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => duplicateSelection()}
      >
        ⧉
      </button>
      <button
        type="button"
        className="small ghost danger ed-fbar-icon"
        disabled={readOnly}
        aria-label="Delete object"
        title="Delete (Del)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => deleteSelection()}
      >
        🗑
      </button>
      <span className="ed-fbar-sep" />
      <button
        type="button"
        className={`small ed-fbar-more${drawerOpen ? ' on' : ''}`}
        aria-label="More object options"
        aria-expanded={drawerOpen}
        title="Open fine-tune inspector drawer"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleDrawer}
      >
        More…
      </button>
    </>
  );

  if (multi) {
    // Align to slide for the whole selection as one block (placement.ts), as the drawer's align bar does.
    return (
      <div className="ed-floating-inner">
        <span className="ed-scope-pill">{objectIds.length} selected</span>
        <Menu
          label="Align"
          disabled={readOnly}
          items={ALIGN_ITEMS.map(([to, label, name]) => ({
            label,
            name,
            onSelect: () => alignSelection(to),
          }))}
        />
        {tailActions}
      </div>
    );
  }

  if (o.type === 'text') {
    return <TextFloatingControls o={o} range={range} off={off} setObj={setObj} tailActions={tailActions} />;
  }

  if (o.type === 'shape') {
    const info = geomInfo(o);
    const paintVal: PaintValue = o.gradient
      ? { kind: 'gradient', gradient: o.gradient }
      : o.fill
        ? { kind: 'solid', color: o.fill }
        : { kind: 'none' };
    const curDash = o.dash ?? 'solid';
    const nextDash = curDash === 'solid' ? 'dash' : curDash === 'dash' ? 'sysDot' : 'solid';

    return (
      <div className="ed-floating-inner">
        {!info ? (
          <select
            aria-label="Shape geometry"
            value={o.shape}
            disabled={off}
            className="ed-fbar-select"
            onChange={(e) =>
              setObj((x) => (x.type === 'shape' ? { ...x, shape: e.target.value as typeof o.shape } : x))
            }
          >
            <option value="rect">Rect</option>
            <option value="ellipse">Ellipse</option>
            <option value="line">Line</option>
          </select>
        ) : (
          <span className="ed-scope-pill">{shapeName(o)}</span>
        )}

        {o.shape !== 'line' && (
          <PaintPill
            value={paintVal}
            modes={['none', 'solid', 'linear', 'radial']}
            disabled={off}
            compact
            ariaLabel="Shape fill"
            onChange={(next) => {
              if (next.kind === 'none') setObj((x) => (x.type === 'shape' ? withFill(x, false) : x));
              else if (next.kind === 'solid')
                setObj((x) => {
                  if (x.type !== 'shape') return x;
                  const { gradient: _g, ...rest } = x;
                  return { ...rest, fill: next.color };
                }, `shape:${o.id}:fill`);
              else
                setObj(
                  (x) => (x.type === 'shape' ? withGradient(x, next.gradient) : x),
                  `shape:${o.id}:grad`,
                );
            }}
          />
        )}

        <span className="ed-fbar-sep" />
        {o.stroke ? (
          <>
            <ColorPill
              value={o.stroke.color}
              disabled={off}
              compact
              ariaLabel="Stroke color"
              onChange={(color) =>
                setObj((x) => (x.type === 'shape' && x.stroke ? { ...x, stroke: { ...x.stroke, color } } : x))
              }
            />
            <button
              type="button"
              className="small ghost"
              disabled={off}
              title={`Dash: ${curDash} (click to cycle)`}
              aria-label="Cycle stroke dash"
              onClick={() => setObj((x) => (x.type === 'shape' ? withDash(x, nextDash) : x))}
            >
              {curDash === 'solid' ? '───' : curDash === 'dash' ? '- -' : '•••'}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="small ghost"
            disabled={off}
            onClick={() =>
              setObj((x) =>
                x.type === 'shape'
                  ? { ...x, stroke: { width: 4, color: { r: 255, g: 255, b: 255, a: 1 } } }
                  : x,
              )
            }
          >
            + Stroke
          </button>
        )}
        {tailActions}
      </div>
    );
  }

  // Image or Video object
  const isCropping = croppingId === o.id;
  const canBg = coversSlide(draft, o);

  return (
    <div className="ed-floating-inner">
      <button
        type="button"
        className={`small${isCropping ? ' on' : ''}`}
        disabled={off}
        aria-pressed={isCropping}
        onClick={() => (isCropping ? endCrop() : startCrop(o.id))}
      >
        {isCropping ? 'Done crop' : 'Crop'}
      </button>
      <button type="button" className="small ghost" disabled={off} onClick={() => setReplacingMedia(true)}>
        Replace
      </button>
      {canBg && (
        <button
          type="button"
          className="small ghost"
          disabled={off}
          onClick={() => pictureToBackground(o.id)}
          title="Move image to slide background"
        >
          Use as BG
        </button>
      )}
      {o.play && (
        <button
          type="button"
          className={`small ghost${o.play.loop ? ' on' : ''}`}
          disabled={off}
          title="Toggle video loop"
          onClick={() =>
            setObj((x) =>
              x.type === 'image' && x.play ? { ...x, play: { ...x.play, loop: !x.play.loop } } : x,
            )
          }
        >
          {o.play.loop ? '↻ Loop' : '1× Play'}
        </button>
      )}
      {tailActions}
      {replacingMedia && !off && (
        <MediaPickerDialog
          title={o.play ? 'Choose a poster image' : 'Choose an image'}
          kinds={['image']}
          needsSize={o.fit !== 'contain' && o.fit !== 'cover'}
          onClose={() => setReplacingMedia(false)}
          onPick={(m) => {
            replacePictureWith(o.id, m);
            setReplacingMedia(false);
          }}
        />
      )}
    </div>
  );
}

function TextFloatingControls({
  o,
  range,
  off,
  setObj,
  tailActions,
}: {
  o: TextObject;
  range: { start: number; end: number };
  off: boolean;
  setObj: (fn: (x: SlideObject) => SlideObject, key?: string, overridePath?: string | string[]) => void;
  tailActions: React.ReactNode;
}) {
  const s = o.style;
  const clampedStart = Math.max(0, Math.min(o.text.length, range.start));
  const clampedEnd = Math.max(clampedStart, Math.min(o.text.length, range.end));
  const hasSelection = clampedStart < clampedEnd;
  const sel = selectionStyle(o, clampedStart, clampedEnd);
  const st = barState(o, sel);

  const setBox = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => {
    if (off) return;
    setObj(
      (x) => (x.type === 'text' ? { ...x, style: { ...x.style, [k]: v } } : x),
      `style:${o.id}:${String(k)}`,
      `style.${String(k)}`,
    );
  };

  const applyRun = (patch: RunPatch, refocus = true) => {
    if (off || !hasSelection) return;
    formatSelection(o.id, clampedStart, clampedEnd, patch);
    if (refocus) refocusText(clampedStart, clampedEnd);
  };

  const shownFont = hasSelection ? (st.font ?? s.fontFamily) : s.fontFamily;
  const shownSize = hasSelection
    ? st.sizePx !== undefined
      ? Math.round(st.sizePx)
      : undefined
    : s.fontSizePx;
  const shownColor: Rgba = hasSelection ? (st.color ?? s.color) : s.color;
  const boldOn = hasSelection ? st.bold === true : s.fontWeight >= 600;
  const italicOn = hasSelection ? st.italic === true : s.fontStyle === 'italic';
  const capsOn = hasSelection ? st.caps === 'all' : s.transform === 'uppercase';

  const contrastLabel =
    s.outline && s.shadow ? 'Heavy' : s.outline ? 'Outline' : s.shadow ? 'Shadow' : 'Clean';

  const setContrast = (mode: ContrastMode) => {
    if (off) return;
    const choice = contrastChoice(s, mode);
    setObj(
      (x) => (x.type === 'text' ? { ...x, style: choice.style } : x),
      `style:${o.id}:contrast`,
      choice.overrides,
    );
  };

  const overflowMsg = fitMessage(o);

  const setAutofitShrink = (on: boolean) => {
    if (off) return;
    const { autofit: _, ...rest } = s;
    const nextStyle: TextStyle = on ? { ...s, autofit: 'shrink' } : rest;
    setObj(
      (x) => (x.type === 'text' ? { ...x, style: nextStyle } : x),
      `style:${o.id}:autofit`,
      'style.autofit',
    );
  };

  return (
    <div className="ed-floating-stack">
      <div className="ed-floating-inner">
        {hasSelection && (
          <button
            type="button"
            className="ed-scope-pill selection"
            title="Reset selection formatting to box style"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => applyRun(CLEAR_FORMATTING)}
          >
            Selection ×
          </button>
        )}
        <div className="ed-fbar-font">
          <FontPicker
            value={shownFont}
            compact
            onChange={(f) => {
              if (hasSelection) applyRun(valuePatch.font(o, f), false);
              else setBox('fontFamily', f);
            }}
          />
        </div>

        <div className="stepper-box compact">
          <button
            type="button"
            aria-label={hasSelection ? 'Size − (smaller text)' : 'Decrease font size'}
            disabled={off}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (hasSelection) {
                resizeSelection(o.id, clampedStart, clampedEnd, 1 / SIZE_STEP);
                refocusText(clampedStart, clampedEnd);
              } else {
                setBox('fontSizePx', Math.max(8, s.fontSizePx - 4));
              }
            }}
          >
            −
          </button>
          <span className="mono small" style={{ minWidth: 30, textAlign: 'center', fontWeight: 600 }}>
            {shownSize ?? 'Mix'}
          </span>
          <button
            type="button"
            aria-label={hasSelection ? 'Size + (larger text)' : 'Increase font size'}
            disabled={off}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (hasSelection) {
                resizeSelection(o.id, clampedStart, clampedEnd, SIZE_STEP);
                refocusText(clampedStart, clampedEnd);
              } else {
                setBox('fontSizePx', Math.min(300, s.fontSizePx + 4));
              }
            }}
          >
            +
          </button>
        </div>

        <span className="ed-fbar-sep" />

        <button
          type="button"
          className={`small ghost ed-fbar-icon${boldOn ? ' on' : ''}`}
          disabled={off}
          aria-label="Bold"
          aria-pressed={boldOn}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (hasSelection) applyRun(togglePatch('bold', o, st));
            else setBox('fontWeight', s.fontWeight >= 600 ? 400 : 700);
          }}
        >
          <b>B</b>
        </button>
        <button
          type="button"
          className={`small ghost ed-fbar-icon${italicOn ? ' on' : ''}`}
          disabled={off}
          aria-label="Italic"
          aria-pressed={italicOn}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (hasSelection) applyRun(togglePatch('italic', o, st));
            else setBox('fontStyle', s.fontStyle === 'italic' ? 'normal' : 'italic');
          }}
        >
          <i>I</i>
        </button>
        {hasSelection ? (
          <>
            <button
              type="button"
              className={`small ghost ed-fbar-icon${st.underline === true ? ' on' : ''}`}
              disabled={off}
              aria-label="Underline"
              aria-pressed={st.underline === true}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyRun(togglePatch('underline', o, st))}
            >
              <u>U</u>
            </button>
            <button
              type="button"
              className={`small ghost ed-fbar-icon${st.superscript === true ? ' on' : ''}`}
              disabled={off}
              aria-label="Superscript"
              aria-pressed={st.superscript === true}
              title="Verse number superscript"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyRun(togglePatch('superscript', o, st))}
            >
              x²
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`small ghost ed-fbar-icon${capsOn ? ' on' : ''}`}
            disabled={off}
            aria-label="Uppercase"
            aria-pressed={capsOn}
            title="All caps"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setBox('transform', s.transform === 'uppercase' ? 'none' : 'uppercase')}
          >
            AA
          </button>
        )}

        <ColorPill
          value={shownColor}
          alpha={!hasSelection}
          disabled={off}
          compact
          swatchOnly
          ariaLabel="Text color"
          onChange={(c) => {
            if (hasSelection) applyRun(valuePatch.color(o, c), false);
            else setBox('color', c);
          }}
        />

        {hasSelection && (
          <ColorPill
            value={typeof st.highlight === 'object' ? st.highlight : HIGHLIGHTS[0]!.color}
            alpha={false}
            swatches={HIGHLIGHTS}
            disabled={off}
            compact
            swatchOnly
            ariaLabel="Highlight color"
            onChange={(c) => applyRun(valuePatch.highlight(c), false)}
          />
        )}

        <span className="ed-fbar-sep" />

        <button
          type="button"
          className="small ghost ed-fbar-icon"
          disabled={off}
          title={`Align: ${s.align} (click to cycle)`}
          aria-label="Cycle text alignment"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            setBox('align', s.align === 'left' ? 'center' : s.align === 'center' ? 'right' : 'left')
          }
        >
          <AlignIcon align={s.align} />
        </button>

        <Menu
          label={contrastLabel}
          disabled={off}
          items={[
            { label: 'Clean text (no shadow)', name: 'Clean', onSelect: () => setContrast('clean') },
            { label: 'Soft shadow', name: 'Shadow', onSelect: () => setContrast('shadow') },
            { label: 'Sharp outline', name: 'Outline', onSelect: () => setContrast('outline') },
            { label: 'Outline + shadow', name: 'Heavy', onSelect: () => setContrast('heavy') },
          ]}
        />

        {tailActions}
      </div>
      {overflowMsg && (
        <div className="ed-floating-overflow" role="status">
          <span className="small">{overflowMsg}</span>
          {s.autofit !== 'shrink' && (
            <button
              type="button"
              className="small"
              disabled={off}
              style={{ whiteSpace: 'nowrap', fontWeight: 600 }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setAutofitShrink(true)}
            >
              Shrink to fit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export type ContrastMode = 'clean' | 'shadow' | 'outline' | 'heavy';

/**
 * The contrast menu's choice on box style `s`: the style it sets, and the theme overrides it marks on a
 * themed lyric box. Every choice sets both the outline and the shadow, so both are the volunteer's and the
 * next theme keeps them (b6: marking only `style.outline` let a theme change drop a 'Soft shadow').
 */
export function contrastChoice(s: TextStyle, mode: ContrastMode): { style: TextStyle; overrides: string[] } {
  const outline = { width: 4, color: { r: 0, g: 0, b: 0, a: 1 } };
  const shadow = { dx: 0, dy: 4, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.7 } };
  const style: TextStyle =
    mode === 'clean'
      ? { ...s, outline: undefined, shadow: undefined }
      : mode === 'shadow'
        ? { ...s, outline: undefined, shadow }
        : mode === 'outline'
          ? { ...s, outline, shadow: undefined }
          : { ...s, outline, shadow };
  return { style, overrides: ['style.outline', 'style.shadow'] };
}
