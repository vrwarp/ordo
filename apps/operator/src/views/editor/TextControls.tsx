import type { Rgba, SlideObject, TextObject, TextStyle } from '@ordo/domain';
import { AlignIcon } from '../../components/AlignIcons.tsx';
import { ColorPill } from '../../components/ColorPicker.tsx';
import { FontPicker } from '../../components/FontPicker.tsx';
import { Menu } from '../../components/Menu.tsx';
import { formatSelection, resizeSelection, type TextTargetArg } from './actions.ts';
import { barState, HIGHLIGHTS, SIZE_STEP, togglePatch, valuePatch } from './FormatBar.tsx';
import { refocusText } from './formatControls.tsx';
import { CLEAR_FORMATTING, type RunPatch, selectionStyle } from './ops/text.ts';
import { fitMessage } from './textFit.ts';

/*
 * The floating bar's text controls (FloatingContextBar.tsx's text bar, and the table bar on a table's cell,
 * design/15 "Table editing"): font, size, bold, italic, underline and superscript over a selection, colour,
 * highlight, alignment, uppercase and the contrast menu, on a text box or on a table cell's text view. A cell
 * (`cell`) has no uppercase, contrast or shrink-to-fit: a cell style holds none of them (domain `cellStyleOf`).
 */

/**
 * Changes the box style (no characters selected) as one undo step: `fn` of the current style; `key` names the
 * field (repeated changes of it coalesce), `overridePath` the theme overrides it marks on a themed lyric box.
 */
export type SetTextStyle = (
  fn: (s: TextStyle) => TextStyle,
  key: string,
  overridePath?: string | string[],
) => void;

/** `setStyle` for a text object through the bar's `setObj` (the undo key `style:<id>:<field>`, as before). */
export function textObjectStyle(
  id: string,
  setObj: (fn: (x: SlideObject) => SlideObject, key?: string, overridePath?: string | string[]) => void,
): SetTextStyle {
  return (fn, key, overridePath) =>
    setObj((x) => (x.type === 'text' ? { ...x, style: fn(x.style) } : x), `style:${id}:${key}`, overridePath);
}

export function TextFloatingControls({
  o,
  range,
  off,
  setStyle,
  target = o.id,
  cell = false,
  lead,
  bare = false,
  tailActions,
}: {
  /** The text box, or a table cell's text view. */
  o: TextObject;
  range: { start: number; end: number };
  off: boolean;
  setStyle: SetTextStyle;
  /** What a selection's format goes to: the text box (its id), or a table's cell. */
  target?: TextTargetArg;
  /** A table cell: no uppercase, contrast or shrink-to-fit (a cell style holds none of them). */
  cell?: boolean;
  /** Shown first in the bar (the table bar's scope pill). */
  lead?: React.ReactNode;
  /** In a panel (the Table section), not over the slide: a plain row, 44 px controls under a finger. */
  bare?: boolean;
  tailActions?: React.ReactNode;
}) {
  const s = o.style;
  const clampedStart = Math.max(0, Math.min(o.text.length, range.start));
  const clampedEnd = Math.max(clampedStart, Math.min(o.text.length, range.end));
  const hasSelection = clampedStart < clampedEnd;
  const sel = selectionStyle(o, clampedStart, clampedEnd);
  const st = barState(o, sel);

  const setBox = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => {
    if (off) return;
    setStyle((x) => ({ ...x, [k]: v }), String(k), `style.${String(k)}`);
  };

  const applyRun = (patch: RunPatch, refocus = true) => {
    if (off || !hasSelection) return;
    formatSelection(target, clampedStart, clampedEnd, patch);
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
    setStyle(() => choice.style, 'contrast', choice.overrides);
  };

  // A cell's row grows with its text: it never overflows its box.
  const overflowMsg = cell ? undefined : fitMessage(o);

  const setAutofitShrink = (on: boolean) => {
    if (off) return;
    const { autofit: _, ...rest } = s;
    const nextStyle: TextStyle = on ? { ...s, autofit: 'shrink' } : rest;
    setStyle(() => nextStyle, 'autofit', 'style.autofit');
  };

  return (
    <div className={bare ? 'ed-cell-format' : 'ed-floating-stack'}>
      <div className={bare ? 'row wrap' : 'ed-floating-inner'} style={bare ? { gap: 6 } : undefined}>
        {lead}
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
            label="Font"
            mixed={hasSelection && st.font === undefined}
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
                resizeSelection(target, clampedStart, clampedEnd, 1 / SIZE_STEP);
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
                resizeSelection(target, clampedStart, clampedEnd, SIZE_STEP);
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
        ) : cell ? null : (
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

        {!cell && (
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
        )}

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
 * next theme keeps them (marking only `style.outline` let a theme change drop a 'Soft shadow').
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
