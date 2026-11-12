import { hexToRgba, type Rgba, rgbaHex } from '@ordo/domain';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type ColorSwatch,
  DEFAULT_SWATCHES,
  getRecentColors,
  hsvToRgba,
  parseHexInput,
  recordRecentColor,
  rgbaCssString,
  rgbaToHsv,
} from './colorMath.ts';

const POPOVER_WIDTH = 252;
const POPOVER_EST_HEIGHT = 330;
const VIEWPORT_PAD = 10;

export interface ColorPopoverProps {
  anchor: HTMLElement | null;
  value: Rgba;
  alpha?: boolean;
  swatches?: readonly ColorSwatch[];
  preserveFocus?: boolean;
  onChange: (c: Rgba) => void;
  onClose: () => void;
}

/**
 * Anchored HSV + Alpha + Swatch popover rendered into `document.body` so it never clips inside
 * scrollable inspector panels.
 */
export function ColorPopover({
  anchor,
  value,
  alpha = true,
  swatches = DEFAULT_SWATCHES,
  preserveFocus = false,
  onChange,
  onClose,
}: ColorPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const [hsv, setHsv] = useState(() => rgbaToHsv(value));
  const [hexText, setHexText] = useState(() => rgbaHex(value));
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const recent = getRecentColors();

  // Keep HSV in sync when external value changes (unless hue is achromatic and we already have one).
  useEffect(() => {
    const next = rgbaToHsv(value);
    setHsv((prev) => ({
      h: next.s === 0 && next.v === 0 ? prev.h : next.s === 0 ? prev.h : next.h,
      s: next.s,
      v: next.v,
      a: next.a,
    }));
    setHexText(rgbaHex(value));
  }, [value]);

  // Compute viewport-clamped fixed position below or above the trigger.
  useLayoutEffect(() => {
    if (!anchor || typeof window === 'undefined') return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const popH = popoverRef.current?.offsetHeight || POPOVER_EST_HEIGHT;
      const spaceBelow = window.innerHeight - r.bottom - VIEWPORT_PAD;
      const top =
        spaceBelow >= popH || spaceBelow >= r.top
          ? Math.min(r.bottom + 6, window.innerHeight - popH - VIEWPORT_PAD)
          : Math.max(VIEWPORT_PAD, r.top - popH - 6);
      const left = Math.max(VIEWPORT_PAD, Math.min(r.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_PAD));
      setPos({ top, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  // Light-dismiss on outside pointerdown or Escape.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchor, onClose]);

  const emitHsv = useCallback(
    (next: { h: number; s: number; v: number; a: number }, record = false) => {
      setHsv(next);
      const rgba = hsvToRgba(next.h, next.s, next.v, alpha ? next.a : 1);
      setHexText(rgbaHex(rgba));
      if (record) recordRecentColor(rgba);
      onChange(rgba);
    },
    [alpha, onChange],
  );

  const updateSvFromPointer = (clientX: number, clientY: number, record = false) => {
    const el = svRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100));
    const v = Math.max(0, Math.min(100, 100 - ((clientY - r.top) / r.height) * 100));
    emitHsv({ ...hsv, s, v }, record);
  };

  const draggingSv = useRef(false);
  const opaqueHex = rgbaHex(hsvToRgba(hsv.h, hsv.s, hsv.v, 1));
  const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window;

  const pickFromScreen = async () => {
    try {
      const Ctor = (
        window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }
      ).EyeDropper;
      const res = await new Ctor().open();
      const c = hexToRgba(res.sRGBHex, alpha ? hsv.a : 1);
      recordRecentColor(c);
      onChange(c);
    } catch {
      // User cancelled EyeDropper.
    }
  };

  const commitHex = () => {
    const parsed = parseHexInput(hexText);
    if (!parsed) {
      setHexText(rgbaHex(value));
      return;
    }
    const next: Rgba = { ...parsed, a: alpha ? hsv.a : 1 };
    recordRecentColor(next);
    onChange(next);
  };

  const content = (
    <div
      ref={popoverRef}
      className="color-popover"
      role="dialog"
      aria-label="Color picker"
      style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
      onMouseDown={preserveFocus ? (e) => e.preventDefault() : undefined}
    >
      {/* 2D Saturation / Brightness Box */}
      <div
        ref={svRef}
        className="color-sv"
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`${Math.round(hsv.s)}% saturation, ${Math.round(hsv.v)}% brightness`}
        style={{ backgroundColor: `hsl(${Math.round(hsv.h)}, 100%, 50%)` }}
        onPointerDown={(e) => {
          draggingSv.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          updateSvFromPointer(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (draggingSv.current) updateSvFromPointer(e.clientX, e.clientY);
        }}
        onPointerUp={(e) => {
          if (!draggingSv.current) return;
          draggingSv.current = false;
          updateSvFromPointer(e.clientX, e.clientY, true);
        }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 2;
          if (e.key === 'ArrowRight') emitHsv({ ...hsv, s: Math.min(100, hsv.s + step) }, true);
          else if (e.key === 'ArrowLeft') emitHsv({ ...hsv, s: Math.max(0, hsv.s - step) }, true);
          else if (e.key === 'ArrowUp') emitHsv({ ...hsv, v: Math.min(100, hsv.v + step) }, true);
          else if (e.key === 'ArrowDown') emitHsv({ ...hsv, v: Math.max(0, hsv.v - step) }, true);
          else return;
          e.preventDefault();
        }}
      >
        <div className="color-sv-thumb" style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }} />
      </div>

      {/* Hue + Alpha Sliders */}
      <div className="col" style={{ gap: 8 }}>
        <div className="color-slider-track color-hue-track">
          <input
            type="range"
            min={0}
            max={359}
            value={Math.round(hsv.h)}
            aria-label="Hue"
            className="color-range"
            onChange={(e) => emitHsv({ ...hsv, h: Number(e.target.value) })}
          />
        </div>
        {alpha && (
          <div className="color-slider-track color-checkerboard">
            <div
              className="color-alpha-grad"
              style={{ background: `linear-gradient(to right, transparent, ${opaqueHex})` }}
            />
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(hsv.a * 100)}
              aria-label="Opacity"
              className="color-range"
              onChange={(e) => emitHsv({ ...hsv, a: Number(e.target.value) / 100 })}
            />
          </div>
        )}
      </div>

      {/* Hex + Alpha + Eyedropper */}
      <div className="row" style={{ gap: 6 }}>
        <input
          type="text"
          value={hexText}
          maxLength={7}
          aria-label="Hex color value"
          className="color-hex-box mono"
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const v = e.target.value;
            setHexText(v);
            const parsed = parseHexInput(v);
            if (parsed && v.replace(/^#/, '').length === 6) {
              onChange({ ...parsed, a: alpha ? hsv.a : 1 });
            }
          }}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitHex();
          }}
        />
        {alpha && (
          <label className="color-pct-box" title="Opacity percentage">
            <input
              type="number"
              min={0}
              max={100}
              value={Math.round(hsv.a * 100)}
              aria-label="Opacity percentage"
              className="mono"
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                emitHsv({ ...hsv, a: pct / 100 });
              }}
            />
            <span className="muted">%</span>
          </label>
        )}
        {hasEyeDropper && (
          <button type="button" className="small" onClick={pickFromScreen} title="Pick color from screen">
            Pick
          </button>
        )}
      </div>

      {/* Swatches */}
      {swatches.length > 0 && (
        <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <span className="muted small">Swatches</span>
          <div className="color-swatch-grid">
            {swatches.map((s) => (
              <button
                key={`${s.name}-${rgbaHex(s.color)}`}
                type="button"
                className="color-swatch-btn color-checkerboard"
                title={s.name}
                aria-label={s.name}
                onClick={() => {
                  const next = alpha ? s.color : { ...s.color, a: 1 };
                  recordRecentColor(next);
                  onChange(next);
                }}
              >
                <span className="color-swatch-fill" style={{ background: rgbaCssString(s.color) }} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Recent Colors */}
      {recent.length > 0 && (
        <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <span className="muted small">Recent</span>
          <div className="color-swatch-grid">
            {recent.map((c, idx) => (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: recent colors list is small and ordered by recency
                key={idx}
                type="button"
                className="color-swatch-btn color-checkerboard"
                title={`${rgbaHex(c)} (${Math.round(c.a * 100)}%)`}
                aria-label={`Recent color ${rgbaHex(c)}`}
                onClick={() => onChange(alpha ? c : { ...c, a: 1 })}
              >
                <span className="color-swatch-fill" style={{ background: rgbaCssString(c) }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}

export interface ColorPillProps {
  value: Rgba;
  onChange: (c: Rgba) => void;
  alpha?: boolean;
  disabled?: boolean;
  swatches?: readonly ColorSwatch[];
  ariaLabel?: string;
}

/**
 * Unified Proposal-A inline trigger pill: `[Swatch] [#hex] [opacity%]`.
 * Clicking the swatch opens `ColorPopover`; Hex and Opacity% are directly editable inline.
 */
export function ColorPill({ value, onChange, alpha = true, disabled, swatches, ariaLabel }: ColorPillProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [hexText, setHexText] = useState(() => rgbaHex(value));

  useEffect(() => {
    setHexText(rgbaHex(value));
  }, [value]);

  const commitHex = () => {
    const parsed = parseHexInput(hexText);
    if (!parsed) {
      setHexText(rgbaHex(value));
      return;
    }
    const next = { ...parsed, a: alpha ? value.a : 1 };
    recordRecentColor(next);
    onChange(next);
  };

  return (
    <span className={`color-pill${disabled ? ' disabled' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="color-pill-chip color-checkerboard"
        disabled={disabled}
        aria-label={ariaLabel ?? 'Open color picker'}
        aria-expanded={open}
        title="Open color picker"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="color-pill-fill" style={{ background: rgbaCssString(value) }} />
      </button>
      <input
        type="text"
        value={hexText}
        maxLength={7}
        disabled={disabled}
        aria-label="Hex color"
        className="color-pill-hex mono"
        onChange={(e) => {
          const v = e.target.value;
          setHexText(v);
          const parsed = parseHexInput(v);
          if (parsed && v.replace(/^#/, '').length === 6) {
            onChange({ ...parsed, a: alpha ? value.a : 1 });
          }
        }}
        onBlur={commitHex}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitHex();
        }}
      />
      {alpha && (
        <span className="color-pill-alpha" title="Opacity percentage">
          <input
            type="number"
            min={0}
            max={100}
            value={Math.round(value.a * 100)}
            disabled={disabled}
            aria-label="Opacity percentage"
            className="mono"
            onChange={(e) => {
              const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
              onChange({ ...value, a: pct / 100 });
            }}
          />
          <span className="muted small">%</span>
        </span>
      )}
      {open && !disabled && (
        <ColorPopover
          anchor={triggerRef.current}
          value={value}
          alpha={alpha}
          swatches={swatches}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}
