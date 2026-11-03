import { type Box, hexToRgba, type Rgba, rgbaHex, type Transition } from '@ordo/domain';
import { type ReactNode, useEffect, useState } from 'react';

export function Field(props: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <label className="field" style={props.style}>
      <span>{props.label}</span>
      {props.children}
      {props.hint && <span className="muted small">{props.hint}</span>}
    </label>
  );
}

/** Number input that commits on blur/Enter and accepts typing freely. */
export function NumberField(props: {
  label?: ReactNode;
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  width?: number;
  disabled?: boolean;
  suffix?: string;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(round(props.value))), [props.value]);
  const commit = () => {
    let v = Number(text);
    if (!Number.isFinite(v)) {
      setText(String(props.value));
      return;
    }
    if (props.min !== undefined) v = Math.max(props.min, v);
    if (props.max !== undefined) v = Math.min(props.max, v);
    if (v !== props.value) props.onChange(v);
    else setText(String(round(props.value)));
  };
  const input = (
    <span className="row" style={{ gap: 4 }}>
      <input
        type="number"
        value={text}
        step={props.step ?? 1}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        style={{ width: props.width ?? 80 }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      {props.suffix && <span className="muted small">{props.suffix}</span>}
    </span>
  );
  return props.label ? <Field label={props.label}>{input}</Field> : input;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function TextField(props: {
  label?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  disabled?: boolean;
  commitOnBlur?: boolean;
  style?: React.CSSProperties;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const onChange = (v: string) => {
    setText(v);
    if (!props.commitOnBlur) props.onChange(v);
  };
  const onBlur = () => {
    if (props.commitOnBlur && text !== props.value) props.onChange(text);
  };
  const el = props.multiline ? (
    <textarea
      value={text}
      rows={props.rows ?? 4}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      style={props.style}
    />
  ) : (
    <input
      value={text}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && props.commitOnBlur) onBlur();
      }}
      style={props.style}
    />
  );
  return props.label ? <Field label={props.label}>{el}</Field> : el;
}

export function ColorField(props: {
  label?: ReactNode;
  value: Rgba;
  onChange: (c: Rgba) => void;
  alpha?: boolean;
}) {
  const { value } = props;
  const el = (
    <span className="row" style={{ gap: 4 }}>
      <input
        type="color"
        value={rgbaHex(value)}
        onChange={(e) => props.onChange(hexToRgba(e.target.value, value.a))}
      />
      {props.alpha !== false && (
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={value.a}
          title={`Opacity ${Math.round(value.a * 100)}%`}
          style={{ width: 70 }}
          onChange={(e) => props.onChange({ ...value, a: Number(e.target.value) })}
        />
      )}
      <span className="muted small mono">{rgbaHex(value)}</span>
    </span>
  );
  return props.label ? <Field label={props.label}>{el}</Field> : el;
}

export function Select<T extends string>(props: {
  label?: ReactNode;
  value: T;
  options: { value: T; label: string }[] | readonly T[];
  onChange: (v: T) => void;
  disabled?: boolean;
  style?: React.CSSProperties;
}) {
  const opts = (props.options as unknown[]).map((o) =>
    typeof o === 'string' ? { value: o as T, label: o } : (o as { value: T; label: string }),
  );
  const el = (
    <select
      value={props.value}
      disabled={props.disabled}
      style={props.style}
      onChange={(e) => props.onChange(e.target.value as T)}
    >
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  return props.label ? <Field label={props.label}>{el}</Field> : el;
}

export function Check(props: {
  label: ReactNode;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

export function BoxEditor(props: { value: Box; onChange: (b: Box) => void; rotation?: boolean }) {
  const b = props.value;
  const set = (patch: Partial<Box>) => props.onChange({ ...b, ...patch });
  return (
    <div className="grid4">
      <NumberField label="X" value={b.x} onChange={(x) => set({ x })} width={70} />
      <NumberField label="Y" value={b.y} onChange={(y) => set({ y })} width={70} />
      <NumberField label="W" value={b.w} min={1} onChange={(w) => set({ w })} width={70} />
      <NumberField label="H" value={b.h} min={1} onChange={(h) => set({ h })} width={70} />
      {props.rotation !== false && (
        <NumberField
          label="Rotation"
          value={b.rotation ?? 0}
          onChange={(rotation) => set({ rotation })}
          width={70}
          suffix="°"
        />
      )}
    </div>
  );
}

export function TransitionEditor(props: {
  value: Transition | undefined;
  onChange: (t: Transition | undefined) => void;
  allowInherit?: boolean;
}) {
  const t = props.value;
  const mode = t ? t.kind : 'inherit';
  return (
    <div className="row wrap">
      <Select
        value={mode}
        options={[
          ...(props.allowInherit ? [{ value: 'inherit', label: 'Look default' }] : []),
          { value: 'cut', label: 'Cut' },
          { value: 'crossfade', label: 'Crossfade' },
        ]}
        onChange={(v) =>
          props.onChange(
            v === 'inherit'
              ? undefined
              : v === 'cut'
                ? { kind: 'cut' }
                : { kind: 'crossfade', ms: t?.kind === 'crossfade' ? t.ms : 300 },
          )
        }
      />
      {t?.kind === 'crossfade' && (
        <NumberField
          value={t.ms}
          min={0}
          max={10000}
          step={50}
          onChange={(ms) => props.onChange({ kind: 'crossfade', ms })}
          suffix="ms"
        />
      )}
    </div>
  );
}
