import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';

/*
 * Small controls shared by the format bar and the paragraph strip (M4 item C), built from the design
 * system's classes (`button.small`, `.on`, `label.field`, `.row`), so they get its 44 px targets and 16 px
 * inputs under a coarse pointer (styles.css) and no new styles:
 * - `Toggle`: a toggle button with `aria-pressed` (true, false or 'mixed') and an accessible name;
 * - `Radios`: a radio group (`role="radiogroup"`, buttons with `role="radio"` and `aria-checked`), one tab
 *   stop, the arrow keys moving and choosing as in a native radio group;
 * - `MixedNumber`: a labelled number field that shows 'Mixed' when the selection's values differ.
 * Buttons keep the text field's focus under a mouse or a finger (their mousedown does not take it), so the
 * textarea's selection stays visible while a volunteer formats it.
 */

/** The text field the format bar and the paragraph strip work on (ObjectPanel's textarea). */
export const TEXT_FIELD_ID = 'ordo-text-editor';

/** The text field, when it is on the page. */
export function textField(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById(TEXT_FIELD_ID);
  return el instanceof HTMLTextAreaElement ? el : null;
}

/** Give the text field its focus and the selection `[start, end)` back (after a format button). */
export function refocusText(start: number, end: number): void {
  const el = textField();
  if (!el || el.disabled) return;
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  if (el.selectionStart !== start || el.selectionEnd !== end) el.setSelectionRange(start, end);
}

/** A mousedown that leaves the focus where it is (the text field keeps its selection on screen). */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

/** A toggle button: pressed, not pressed, or mixed (the selection has both). */
export function Toggle(props: {
  /** The accessible name (the visible content may be a letter: B, I, U). */
  label: string;
  pressed: boolean | 'mixed';
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`small${props.pressed === true ? ' on' : ''}`}
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onMouseDown={keepFocus}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}

/** A plain button of the bars: an accessible name and the text field's focus kept under a pointer. */
export function BarButton(props: {
  label?: string;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="small"
      aria-label={props.label}
      disabled={props.disabled}
      onMouseDown={keepFocus}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}

/**
 * A radio group of buttons. `value` undefined checks none (a mixed selection); the checked one (else the
 * first) is the group's tab stop, and the arrow keys move to the previous or next choice and choose it.
 */
export function Radios<T extends string>(props: {
  label: string;
  value: T | undefined;
  options: readonly { value: T; label: string }[];
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = props.options.findIndex((o) => o.value === props.value);
  const stop = Math.max(at, 0);
  const move = (e: KeyboardEvent, i: number) => {
    const n = props.options.length;
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let j: number | undefined;
    if (d) j = (i + d + n) % n;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = n - 1;
    if (j === undefined) return;
    // The arrows are the group's own: the editor's nudge must not also move the selected box.
    e.preventDefault();
    e.stopPropagation();
    refs.current[j]?.focus();
    props.onChange(props.options[j]!.value);
  };
  return (
    <div className="row wrap" role="radiogroup" aria-label={props.label} style={{ gap: 4 }}>
      {props.options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          className={`small${i === at ? ' on' : ''}`}
          aria-checked={i === at}
          tabIndex={i === stop ? 0 : -1}
          disabled={props.disabled}
          onMouseDown={keepFocus}
          onKeyDown={(e) => move(e, i)}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function fmt(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * A labelled number field for a selection: `value` undefined shows it empty with 'Mixed' as its
 * placeholder. `commit` 'change' applies every valid value as it is typed or stepped (the caller
 * coalesces them into one undo step by its key); 'blur' applies it on Enter or when the field is left.
 * Values outside `min`..`max` are not applied; leaving the field shows the value in effect again.
 */
export function MixedNumber(props: {
  label: ReactNode;
  value: number | undefined;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  width?: number;
  commit?: 'change' | 'blur';
}) {
  const shown = props.value === undefined ? '' : fmt(props.value);
  const [text, setText] = useState(shown);
  // A new value from outside replaces the text, unless the text already says it ("1." while typing 1.5).
  useEffect(() => {
    setText((t) => (props.value !== undefined && t.trim() !== '' && Number(t) === props.value ? t : shown));
  }, [shown, props.value]);
  const valid = (raw: string): number | undefined => {
    if (!raw.trim()) return undefined;
    const v = Number(raw);
    if (!Number.isFinite(v)) return undefined;
    if (props.min !== undefined && v < props.min) return undefined;
    if (props.max !== undefined && v > props.max) return undefined;
    return v;
  };
  const apply = (raw: string) => {
    const v = valid(raw);
    if (v !== undefined && v !== props.value) props.onChange(v);
  };
  return (
    <label className="field">
      <span>{props.label}</span>
      <span className="row" style={{ gap: 4 }}>
        <input
          type="number"
          value={text}
          placeholder={props.value === undefined ? 'Mixed' : undefined}
          step={props.step ?? 1}
          min={props.min}
          max={props.max}
          disabled={props.disabled}
          style={{ width: props.width ?? 72 }}
          onChange={(e) => {
            setText(e.target.value);
            if (props.commit !== 'blur') apply(e.target.value);
          }}
          onBlur={() => {
            if (props.commit === 'blur') apply(text);
            setText(shown);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && props.commit === 'blur') apply(text);
          }}
        />
        {props.suffix && <span className="muted small">{props.suffix}</span>}
      </span>
    </label>
  );
}
