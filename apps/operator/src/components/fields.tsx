import type { Box, Transition } from '@ordo/domain';
import {
  type CSSProperties,
  type KeyboardEvent as KeyEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icons.tsx';
import { useCoarsePointer } from './pointer.ts';
import { usePopupOf } from './popupOf.ts';

export function Field(props: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <label className="field" style={props.style}>
      <span>{props.label}</span>
      {props.children}
      {props.hint && <span className="muted small">{props.hint}</span>}
    </label>
  );
}

/**
 * Compact 2-column desktop inspector row: muted label on the left, compact control on the right
 * (design/30 §3.5). Optional `hint` renders as a tooltip on the label and subtle info icon.
 */
export function PropertyRow({
  label,
  hint,
  align = 'center',
  children,
  className,
  style,
}: {
  label: ReactNode;
  hint?: string;
  align?: 'center' | 'start';
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`prop-row${align === 'start' ? ' prop-row-start' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      <span className="prop-label" title={hint}>
        <span className="ellipsis">{label}</span>
        {hint && <Icon name="info" size={12} className="prop-hint-ico" />}
      </span>
      <div className="prop-control">{children}</div>
    </div>
  );
}

/** Monospace keyboard shortcut badge (`Esc`, `F1`, `F2`, `Ctrl+Shift+L`). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={className ? `kbd ${className}` : 'kbd'}>{children}</kbd>;
}

/** Compact flush segmented control for desktop mode/tab switches. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  size = 'sm',
  ariaLabel,
  className,
}: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string; badge?: boolean; disabled?: boolean }[];
  onChange: (v: T) => void;
  size?: 'xs' | 'sm';
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <div
      className={`segmented segmented-${size}${className ? ` ${className}` : ''}`}
      role="tablist"
      aria-label={ariaLabel}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={opt.disabled}
            title={opt.title}
            className={`seg-btn${active ? ' active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
            {opt.badge && <span className="seg-dot" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
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
  stepper?: boolean;
}) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(round(props.value))), [props.value]);
  const clampVal = (v: number) => {
    let out = v;
    if (props.min !== undefined) out = Math.max(props.min, out);
    if (props.max !== undefined) out = Math.min(props.max, out);
    return round(out);
  };
  const commit = () => {
    let v = Number(text);
    if (!Number.isFinite(v)) {
      setText(String(props.value));
      return;
    }
    v = clampVal(v);
    if (v !== props.value) props.onChange(v);
    else setText(String(round(props.value)));
  };
  const stepBy = (dir: -1 | 1) => {
    if (props.disabled) return;
    const next = clampVal(props.value + dir * (props.step ?? 1));
    if (next !== props.value) props.onChange(next);
  };
  const input = (
    <span
      className={props.stepper ? 'num-field row has-stepper' : 'row'}
      style={{ gap: props.stepper ? 3 : 4 }}
    >
      {props.stepper && (
        <button
          type="button"
          className="num-step-btn"
          disabled={props.disabled || (props.min !== undefined && props.value <= props.min)}
          onClick={() => stepBy(-1)}
          aria-label="Decrease"
        >
          <Icon name="minus" size={11} />
        </button>
      )}
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
      {props.stepper && (
        <button
          type="button"
          className="num-step-btn"
          disabled={props.disabled || (props.max !== undefined && props.value >= props.max)}
          onClick={() => stepBy(1)}
          aria-label="Increase"
        >
          <Icon name="plus" size={11} />
        </button>
      )}
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
  style?: CSSProperties;
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

const VIEWPORT_PAD = 8;

function DesktopSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  style,
  ariaLabel,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  style?: CSSProperties;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth: number }>({
    left: -9999,
    top: -9999,
    minWidth: 140,
  });

  const activeIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const current = options[activeIdx] ?? options[0];

  usePopupOf(listRef, triggerRef, open, () => setOpen(false));

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !listRef.current) return;
    const place = () => {
      if (!triggerRef.current || !listRef.current) return;
      const tr = triggerRef.current.getBoundingClientRect();
      const mr = listRef.current.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.max(tr.width, mr.width);
      const left = Math.max(VIEWPORT_PAD, Math.min(tr.left, vw - width - VIEWPORT_PAD));
      let top = tr.bottom + 3;
      if (top + mr.height > vh - VIEWPORT_PAD && tr.top - 3 - mr.height >= VIEWPORT_PAD) {
        top = tr.top - 3 - mr.height;
      } else {
        top = Math.max(VIEWPORT_PAD, Math.min(top, vh - mr.height - VIEWPORT_PAD));
      }
      setPos({ left: Math.round(left), top: Math.round(top), minWidth: Math.round(tr.width) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: Event) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const openMenu = () => {
    if (disabled) return;
    setFocusIdx(activeIdx);
    setOpen(true);
  };

  const pick = (v: T) => {
    setOpen(false);
    if (v !== value) onChange(v);
    triggerRef.current?.focus();
  };

  const onTriggerKey = (e: KeyEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => (i + 1) % Math.max(1, options.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => (i - 1 + Math.max(1, options.length)) % Math.max(1, options.length));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusIdx(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setFocusIdx(Math.max(0, options.length - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const target = options[focusIdx];
      if (target) pick(target.value);
    }
  };

  const popover = open ? (
    <div
      ref={listRef}
      className="select-popover"
      role="listbox"
      aria-label={ariaLabel}
      style={{ position: 'fixed', left: pos.left, top: pos.top, minWidth: pos.minWidth }}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        const focused = i === focusIdx;
        return (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={selected}
            className={`select-option${selected ? ' selected' : ''}${focused ? ' focused' : ''}`}
            onMouseEnter={() => setFocusIdx(i)}
            onClick={() => pick(o.value)}
          >
            <span className="select-opt-check">{selected ? <Icon name="check" size={12} /> : null}</span>
            <span className="ellipsis">{o.label}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        className={`select-trigger${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        style={style}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onTriggerKey}
      >
        <span className="ellipsis grow" style={{ textAlign: 'left' }}>
          {current?.label ?? ''}
        </span>
        <Icon name="chevronDown" size={12} className="select-caret" />
      </button>
      {popover && (typeof document !== 'undefined' ? createPortal(popover, document.body) : popover)}
    </>
  );
}

export function Select<T extends string>(props: {
  label?: ReactNode;
  value: T;
  options: { value: T; label: string }[] | readonly { value: T; label: string }[] | readonly T[];
  onChange: (v: T) => void;
  disabled?: boolean;
  style?: CSSProperties;
  ariaLabel?: string;
  className?: string;
  /** Force native `<select>` (e.g. when tests or coarse pointers expect native pickers). */
  native?: boolean;
}) {
  const coarse = useCoarsePointer();
  const opts = useMemo(
    () =>
      (props.options as unknown[]).map((o) =>
        typeof o === 'string' ? { value: o as T, label: o } : (o as { value: T; label: string }),
      ),
    [props.options],
  );
  const el =
    typeof document === 'undefined' || coarse || props.native ? (
      <select
        value={props.value}
        disabled={props.disabled}
        style={props.style}
        aria-label={props.ariaLabel}
        className={props.className}
        onChange={(e) => props.onChange(e.target.value as T)}
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ) : (
      <DesktopSelect
        value={props.value}
        options={opts}
        onChange={props.onChange}
        disabled={props.disabled}
        style={props.style}
        ariaLabel={props.ariaLabel ?? (typeof props.label === 'string' ? props.label : undefined)}
        className={props.className}
      />
    );
  return props.label ? <Field label={props.label}>{el}</Field> : el;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIso(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatShortDate(iso: string): string {
  const d = parseIso(iso);
  if (!d) return 'No date';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function nextSundayDate(): string {
  const d = new Date();
  const add = (7 - d.getDay()) % 7;
  d.setDate(d.getDate() + add);
  return isoDate(d);
}

/**
 * Custom dark date picker on desktop (`pointer: fine`) replacing raw browser `mm/dd/yyyy` inputs
 * (design/30 §3.5). Falls back to native `<input type="date">` on touch devices.
 */
export function DateField({
  value,
  onChange,
  disabled,
  ariaLabel = 'Service date',
  title,
}: {
  value: string;
  onChange: (iso: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
}) {
  const coarse = useCoarsePointer();
  const [open, setOpen] = useState(false);
  const initialMonth = parseIso(value) ?? new Date();
  const [viewYear, setViewYear] = useState(initialMonth.getFullYear());
  const [viewMonth, setViewMonth] = useState(initialMonth.getMonth());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  usePopupOf(popRef, triggerRef, open, () => setOpen(false));

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !popRef.current) return;
    const place = () => {
      if (!triggerRef.current || !popRef.current) return;
      const tr = triggerRef.current.getBoundingClientRect();
      const pr = popRef.current.getBoundingClientRect();
      const left = Math.max(VIEWPORT_PAD, Math.min(tr.left, window.innerWidth - pr.width - VIEWPORT_PAD));
      let top = tr.bottom + 4;
      if (top + pr.height > window.innerHeight - VIEWPORT_PAD && tr.top - 4 - pr.height >= VIEWPORT_PAD) {
        top = tr.top - 4 - pr.height;
      }
      setPos({ left: Math.round(left), top: Math.round(top) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: Event) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (!triggerRef.current?.contains(target) && !popRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onOutside, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (coarse) {
    return (
      <input
        type="date"
        aria-label={ariaLabel}
        title={title}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const firstDay = new Date(viewYear, viewMonth, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const todayIso = isoDate(new Date());
  const monthLabel = firstDay.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const stepMonth = (delta: number) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const popover = open ? (
    <div
      ref={popRef}
      className="date-popover"
      role="dialog"
      aria-label={ariaLabel}
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
    >
      <div className="date-pop-head row">
        <button
          type="button"
          className="ghost icon-btn"
          onClick={() => stepMonth(-1)}
          aria-label="Previous month"
        >
          <Icon name="chevronLeft" size={13} />
        </button>
        <span className="grow" style={{ textAlign: 'center', fontWeight: 600, fontSize: 12 }}>
          {monthLabel}
        </span>
        <button type="button" className="ghost icon-btn" onClick={() => stepMonth(1)} aria-label="Next month">
          <Icon name="chevronRight" size={13} />
        </button>
      </div>
      <div className="date-grid date-weekdays">
        {['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="date-grid">
        {(['s0', 's1', 's2', 's3', 's4', 's5'] as const).slice(0, startOffset).map((slot) => (
          <span key={slot} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const cellIso = isoDate(new Date(viewYear, viewMonth, day));
          const isSel = cellIso === value;
          const isToday = cellIso === todayIso;
          return (
            <button
              key={cellIso}
              type="button"
              className={`date-cell${isSel ? ' selected' : ''}${isToday ? ' today' : ''}`}
              onClick={() => pick(cellIso)}
            >
              {day}
            </button>
          );
        })}
      </div>
      <div className="date-pop-foot row">
        <button type="button" className="ghost small" onClick={() => pick(nextSundayDate())}>
          Next Sunday
        </button>
        <span className="spacer" />
        {value && (
          <button type="button" className="ghost small" onClick={() => pick('')}>
            Clear
          </button>
        )}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`date-trigger${open ? ' open' : ''}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title ?? (value || 'Set service date')}
        onClick={() => {
          if (disabled) return;
          const base = parseIso(value) ?? new Date();
          setViewYear(base.getFullYear());
          setViewMonth(base.getMonth());
          setOpen((o) => !o);
        }}
      >
        <Icon name="calendar" size={13} />
        <span>{formatShortDate(value)}</span>
      </button>
      {popover && (typeof document !== 'undefined' ? createPortal(popover, document.body) : popover)}
    </>
  );
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
    <div className="ed-box-grid">
      <NumberField label="X" value={b.x} onChange={(x) => set({ x })} />
      <NumberField label="Y" value={b.y} onChange={(y) => set({ y })} />
      <NumberField label="W" value={b.w} min={1} onChange={(w) => set({ w })} />
      <NumberField label="H" value={b.h} min={1} onChange={(h) => set({ h })} />
      {props.rotation !== false && (
        <NumberField
          label="Rotation"
          value={b.rotation ?? 0}
          onChange={(rotation) => set({ rotation })}
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
  disabled?: boolean;
}) {
  const t = props.value;
  const mode = t ? t.kind : 'inherit';
  return (
    <div className="row wrap" style={{ gap: 6 }}>
      <Select
        value={mode}
        disabled={props.disabled}
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
          disabled={props.disabled}
          onChange={(ms) => props.onChange({ kind: 'crossfade', ms })}
          suffix="ms"
          width={64}
        />
      )}
    </div>
  );
}
