import type { Rgba, SlideObject, TextObject, TextStyle } from '@ordo/domain';
import { useEffect, useRef } from 'react';
import { AlignIcon, VAlignIcon } from '../../components/AlignIcons.tsx';
import { ColorPill } from '../../components/ColorPicker.tsx';
import { FontPicker } from '../../components/FontPicker.tsx';
import { formatSelection, resizeSelection } from './actions.ts';
import { composing } from './editorKeys.ts';
import { barState, HIGHLIGHTS, shortcutOf, SIZE_STEP, togglePatch, valuePatch } from './FormatBar.tsx';
import { refocusText, Toggle, textField } from './formatControls.tsx';
import { CLEAR_FORMATTING, type RunPatch, selectionStyle, type TextRange } from './ops/text.ts';

export interface UnifiedTypographyProps {
  o: TextObject;
  range: TextRange;
  readOnly: boolean;
  marks?: Set<string>;
  onChangeStyle: (style: TextStyle, key: keyof TextStyle) => void;
}

/**
 * Single Scope-Aware Typography Card:
 * - Edits `Whole Box` (`o.style`) when `range.start === range.end`.
 * - Automatically switches to `Selection` scope (`formatSelection` / `resizeSelection`) when characters
 *   are highlighted inline on the canvas or inside `#ordo-text-editor` — eliminating the duplicate 55-control stack.
 */
export function UnifiedTypography({ o, range, readOnly, marks, onChangeStyle }: UnifiedTypographyProps) {
  const s = o.style;
  const off = readOnly || !!o.locked;
  const hasSelection = range.start < range.end;
  const sel = selectionStyle(o, range.start, range.end);
  const st = barState(o, sel);

  // Preserve Ctrl+B / Ctrl+I / Ctrl+U keyboard shortcuts in `#ordo-text-editor`.
  const latest = useRef({ o, off });
  latest.current = { o, off };
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attached per object
  useEffect(() => {
    const el = textField();
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (composing(e)) return;
      const t = shortcutOf(e);
      if (!t) return;
      e.preventDefault();
      const cur = latest.current;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (cur.off || start === end) return;
      const state = barState(cur.o, selectionStyle(cur.o, start, end));
      formatSelection(cur.o.id, start, end, togglePatch(t, cur.o, state));
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [o.id]);

  const applyRun = (patch: RunPatch, refocus = true) => {
    if (off || !hasSelection) return;
    formatSelection(o.id, range.start, range.end, patch);
    if (refocus) refocusText(range.start, range.end);
  };

  const setBox = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => {
    if (off) return;
    onChangeStyle({ ...s, [k]: v }, k);
  };

  const mark = (k: keyof TextStyle) =>
    !hasSelection && marks?.has(`style.${k}`) ? (
      <span className="override-mark" title="Overrides the theme">
        {' '}
        ●
      </span>
    ) : null;

  const shownFont = hasSelection ? (st.font ?? s.fontFamily) : s.fontFamily;
  const shownSize = hasSelection
    ? st.sizePx !== undefined
      ? Math.round(st.sizePx)
      : undefined
    : s.fontSizePx;
  const shownColor: Rgba = hasSelection ? (st.color ?? s.color) : s.color;
  const boldState = hasSelection ? st.bold : s.fontWeight >= 600;
  const italicState = hasSelection ? st.italic : s.fontStyle === 'italic';
  const capsState = hasSelection ? st.caps === 'all' : s.transform === 'uppercase';

  return (
    <fieldset
      disabled={off}
      className="col ed-unified-typo"
      role="toolbar"
      aria-label="Typography"
      style={{ gap: 10, border: 0, margin: 0, padding: 0, minWidth: 0 }}
    >
      {/* Scope Header Pill */}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span
          className="small bold"
          style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
        >
          Typography
          {mark('fontFamily')}
        </span>
        {hasSelection ? (
          <div className="row" style={{ gap: 4, alignItems: 'center' }}>
            <span className="ed-scope-pill selection">Selection</span>
            <button
              type="button"
              className="small ghost"
              style={{ minHeight: 24, padding: '1px 7px', fontSize: 11 }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyRun(CLEAR_FORMATTING)}
              title="Reset highlighted text to box style"
            >
              Clear formatting
            </button>
          </div>
        ) : (
          <span className="ed-scope-pill">Whole Box</span>
        )}
      </div>

      {/* Row 1: Font Family + Size Stepper */}
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <FontPicker
            value={shownFont}
            label="Font"
            mixed={hasSelection && st.font === undefined}
            onChange={(f) => {
              if (hasSelection) applyRun(valuePatch.font(o, f), false);
              else setBox('fontFamily', f);
            }}
          />
        </div>
        <div className="stepper-box">
          <button
            type="button"
            aria-label={hasSelection ? 'Size − (smaller text)' : 'Decrease font size'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (hasSelection) {
                resizeSelection(o.id, range.start, range.end, 1 / SIZE_STEP);
                refocusText(range.start, range.end);
              } else {
                setBox('fontSizePx', Math.max(8, s.fontSizePx - 4));
              }
            }}
          >
            −
          </button>
          {hasSelection ? (
            <span
              className="mono small"
              aria-live="polite"
              style={{ minWidth: 42, textAlign: 'center', fontWeight: 600 }}
            >
              {shownSize === undefined ? 'Mix' : shownSize}
            </span>
          ) : (
            <input
              type="number"
              aria-label="Font size in pixels"
              value={s.fontSizePx}
              min={8}
              max={300}
              onChange={(e) => setBox('fontSizePx', Math.max(8, Math.min(300, Number(e.target.value) || 40)))}
            />
          )}
          <button
            type="button"
            aria-label={hasSelection ? 'Size + (larger text)' : 'Increase font size'}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (hasSelection) {
                resizeSelection(o.id, range.start, range.end, SIZE_STEP);
                refocusText(range.start, range.end);
              } else {
                setBox('fontSizePx', Math.min(300, s.fontSizePx + 4));
              }
            }}
          >
            +
          </button>
        </div>
      </div>

      {/* Row 2: Style Toggles (B, I, Caps + Run-specific U, S, x², x₂ when selecting characters) */}
      <div className="row wrap" style={{ gap: 4 }}>
        <Toggle
          label="Bold"
          pressed={boldState}
          onPress={() => {
            if (hasSelection) applyRun(togglePatch('bold', o, st));
            else setBox('fontWeight', s.fontWeight >= 600 ? 400 : 700);
          }}
        >
          <b>B</b>
        </Toggle>
        <Toggle
          label="Italic"
          pressed={italicState}
          onPress={() => {
            if (hasSelection) applyRun(togglePatch('italic', o, st));
            else setBox('fontStyle', s.fontStyle === 'italic' ? 'normal' : 'italic');
          }}
        >
          <i>I</i>
        </Toggle>
        <Toggle
          label="Underline"
          pressed={hasSelection ? st.underline : !!s.underline}
          onPress={() => {
            if (hasSelection) applyRun(togglePatch('underline', o, st));
            else setBox('underline', s.underline ? undefined : true);
          }}
        >
          <u>U</u>
        </Toggle>
        <Toggle
          label="Uppercase"
          pressed={capsState}
          onPress={() => {
            if (hasSelection) applyRun(valuePatch.caps(o, st.caps === 'all' ? 'none' : 'all'));
            else setBox('transform', s.transform === 'uppercase' ? 'none' : 'uppercase');
          }}
        >
          AA
        </Toggle>
        {hasSelection && (
          <>
            <Toggle
              label="Strikethrough"
              pressed={st.strike}
              onPress={() => applyRun(togglePatch('strike', o, st))}
            >
              <s>S</s>
            </Toggle>
            <Toggle
              label="Superscript"
              pressed={st.superscript}
              onPress={() => applyRun(togglePatch('superscript', o, st))}
            >
              x²
            </Toggle>
            <Toggle
              label="Subscript"
              pressed={st.subscript}
              onPress={() => applyRun(togglePatch('subscript', o, st))}
            >
              x₂
            </Toggle>
          </>
        )}
      </div>

      {/* Row 3: Color Pill (+ Highlight Pill when characters are selected) */}
      <div className="prop-line">
        <span className="prop-line-label">
          {hasSelection ? 'Run color' : 'Text color'}
          {mark('color')}
        </span>
        <ColorPill
          value={shownColor}
          alpha={!hasSelection}
          disabled={off}
          ariaLabel="Text color"
          onChange={(c) => {
            if (hasSelection) applyRun(valuePatch.color(o, c), false);
            else setBox('color', c);
          }}
        />
      </div>

      {hasSelection && (
        <div className="prop-line">
          <span className="prop-line-label">Highlight</span>
          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
            {typeof st.highlight === 'object' ? (
              <>
                <ColorPill
                  value={st.highlight}
                  alpha={false}
                  swatches={HIGHLIGHTS}
                  disabled={off}
                  ariaLabel="Highlight color"
                  onChange={(c) => applyRun(valuePatch.highlight(c), false)}
                />
                <button
                  type="button"
                  className="small prop-toggle-btn"
                  aria-label="Remove highlight"
                  title="Remove highlight"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyRun(valuePatch.highlight(undefined))}
                >
                  −
                </button>
              </>
            ) : (
              <button
                type="button"
                className="small prop-toggle-btn"
                aria-label="Add highlight"
                title="Highlight selected text"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => applyRun(valuePatch.highlight(HIGHLIGHTS[0]!.color))}
              >
                +
              </button>
            )}
          </div>
        </div>
      )}

      {/* Row 4: Box Horizontal & Vertical Alignment */}
      <div className="grid2" style={{ gap: 8 }}>
        <div className="segmented-bar" role="group" aria-label="Horizontal alignment">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button
              key={a}
              type="button"
              className={s.align === a ? 'active' : ''}
              onClick={() => setBox('align', a)}
              aria-label={`Align ${a}`}
            >
              <AlignIcon align={a} />
            </button>
          ))}
        </div>
        <div className="segmented-bar" role="group" aria-label="Vertical alignment">
          {(['top', 'middle', 'bottom'] as const).map((v) => (
            <button
              key={v}
              type="button"
              className={s.valign === v ? 'active' : ''}
              onClick={() => setBox('valign', v)}
              aria-label={`Vertical align ${v}`}
            >
              <VAlignIcon valign={v} />
            </button>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

export type SetSlideObject = (
  fn: (x: SlideObject) => SlideObject,
  key?: string,
  overridePath?: string,
) => void;
