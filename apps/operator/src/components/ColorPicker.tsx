import { type Gradient, hexToRgba, type Rgba, rgbaCss, rgbaHex } from '@ordo/domain';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  type ColorSwatch,
  getRecentColors,
  hsvToRgba,
  parseHexInput,
  recordRecentColor,
  rgbaCssString,
  rgbaToHsv,
} from './colorMath.ts';
import { useDeckSwatches } from './deckSwatches.ts';

const POPOVER_WIDTH = 296;
const POPOVER_EST_HEIGHT = 360;
const VIEWPORT_PAD = 10;
const MIN_GRAD_STOPS = 2;
const MAX_GRAD_STOPS = 16;
const ANGLE_CHIPS = [0, 90, 135] as const;

export type PaintMode = 'none' | 'solid' | 'linear' | 'radial';

export type PaintValue =
  | { kind: 'none' }
  | { kind: 'solid'; color: Rgba }
  | { kind: 'gradient'; gradient: Gradient };

function shadeColor(c: Rgba, f: number): Rgba {
  return { r: Math.round(c.r * f), g: Math.round(c.g * f), b: Math.round(c.b * f), a: c.a };
}

function mixColors(a: Rgba, b: Rgba, t: number): Rgba {
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t);
  return {
    r: ch(a.r, b.r),
    g: ch(a.g, b.g),
    b: ch(a.b, b.b),
    a: Math.round((a.a + (b.a - a.a) * t) * 1000) / 1000,
  };
}

function sortGradientStops(stops: Gradient['stops']): Gradient['stops'] {
  return [...stops].sort((a, b) => a.at - b.at);
}

function sampleGradientAt(stops: Gradient['stops'], at: number): Rgba {
  const sorted = sortGradientStops(stops);
  if (sorted.length === 0) return { r: 59, g: 130, b: 246, a: 1 };
  if (at <= sorted[0]!.at) return sorted[0]!.color;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (at <= b.at) {
      const t = b.at > a.at ? (at - a.at) / (b.at - a.at) : 0;
      return mixColors(a.color, b.color, t);
    }
  }
  return sorted[sorted.length - 1]!.color;
}

export function gradientCssPreview(g: Gradient): string {
  const stops = sortGradientStops(g.stops)
    .map((s) => `${rgbaCss(s.color)} ${Math.round(s.at * 1000) / 10}%`)
    .join(', ');
  if (g.kind === 'radial') return `radial-gradient(circle, ${stops})`;
  const deg = g.angle ?? 90;
  // OOXML 0° runs left->right (CSS 90deg), 90° runs top->bottom (CSS 180deg)
  return `linear-gradient(${(deg + 90) % 360}deg, ${stops})`;
}

export interface PaintPopoverProps {
  anchor: HTMLElement | null;
  value: PaintValue;
  modes?: readonly PaintMode[];
  alpha?: boolean;
  swatches?: readonly ColorSwatch[];
  preserveFocus?: boolean;
  defaultSolid?: Rgba;
  inline?: boolean;
  onChange: (next: PaintValue) => void;
  onClose: () => void;
}

/**
 * Unified Paint + Gradient Popover (Proposal A full realization):
 * - Top segmented mode bar (`Solid | Linear | Radial`, plus optional `None`)
 * - 2D HSV Saturation/Brightness canvas + Hue + Checkerboard Alpha sliders (bound to solid color OR active gradient stop!)
 * - Live `Deck & Theme Swatches` (`1-tap` squircles) + `Recent`
 * - Interactive `Gradient Ramp` + Angle presets (`0°`, `90°`, `135°`, `180°` + custom `°`) + single active-stop bar (`Stop N [#hex] [pos%] [+ / ×]`)
 */
export function PaintPopover({
  anchor,
  value,
  modes = ['solid'],
  alpha = true,
  swatches: explicitSwatches,
  preserveFocus = false,
  defaultSolid = { r: 59, g: 130, b: 246, a: 1 },
  inline = false,
  onChange,
  onClose,
}: PaintPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const swatches = useDeckSwatches(explicitSwatches);
  const recent = getRecentColors();

  const currentMode: PaintMode =
    value.kind === 'none' ? 'none' : value.kind === 'solid' ? 'solid' : value.gradient.kind;

  const stops = value.kind === 'gradient' ? value.gradient.stops : undefined;
  const [activeStopIdx, setActiveStopIdx] = useState(0);
  const clampedStopIdx = stops ? Math.max(0, Math.min(stops.length - 1, activeStopIdx)) : 0;

  const activeColor: Rgba =
    value.kind === 'solid'
      ? value.color
      : value.kind === 'gradient'
        ? (value.gradient.stops[clampedStopIdx]?.color ?? defaultSolid)
        : defaultSolid;

  const [hsv, setHsv] = useState(() => rgbaToHsv(activeColor));
  const [hexText, setHexText] = useState(() => rgbaHex(activeColor));
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    const next = rgbaToHsv(activeColor);
    setHsv((prev) => ({
      h: next.s === 0 && next.v === 0 ? prev.h : next.s === 0 ? prev.h : next.h,
      s: next.s,
      v: next.v,
      a: next.a,
    }));
    setHexText(rgbaHex(activeColor));
  }, [activeColor]);

  // Reposition whenever mode changes (since gradient ramp adds height).
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentMode changes popover height
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
  }, [anchor, currentMode]);

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

  const emitColor = useCallback(
    (rgba: Rgba) => {
      if (value.kind === 'gradient') {
        const nextStops = value.gradient.stops.map((s, idx) =>
          idx === clampedStopIdx ? { ...s, color: rgba } : s,
        );
        onChange({ kind: 'gradient', gradient: { ...value.gradient, stops: nextStops } });
      } else {
        onChange({ kind: 'solid', color: rgba });
      }
    },
    [value, clampedStopIdx, onChange],
  );

  const emitHsv = useCallback(
    (next: { h: number; s: number; v: number; a: number }, record = false) => {
      setHsv(next);
      const rgba = hsvToRgba(next.h, next.s, next.v, alpha ? next.a : 1);
      setHexText(rgbaHex(rgba));
      if (record) recordRecentColor(rgba);
      emitColor(rgba);
    },
    [alpha, emitColor],
  );

  const switchMode = (target: PaintMode) => {
    if (target === currentMode) return;
    if (target === 'none') {
      onChange({ kind: 'none' });
      return;
    }
    if (target === 'solid') {
      const c =
        value.kind === 'gradient'
          ? (value.gradient.stops[clampedStopIdx]?.color ?? value.gradient.stops[0]?.color ?? defaultSolid)
          : value.kind === 'solid'
            ? value.color
            : defaultSolid;
      onChange({ kind: 'solid', color: c });
      return;
    }
    // Switching to 'linear' or 'radial'
    if (value.kind === 'gradient') {
      const g: Gradient =
        target === 'linear'
          ? {
              kind: 'linear',
              angle: value.gradient.kind === 'linear' ? (value.gradient.angle ?? 90) : 90,
              stops: value.gradient.stops,
            }
          : { kind: 'radial', stops: value.gradient.stops };
      onChange({ kind: 'gradient', gradient: g });
    } else {
      const base = value.kind === 'solid' ? value.color : defaultSolid;
      const newStops = [
        { at: 0, color: base },
        { at: 1, color: shadeColor(base, 0.55) },
      ];
      setActiveStopIdx(0);
      onChange({
        kind: 'gradient',
        gradient:
          target === 'linear'
            ? { kind: 'linear', angle: 90, stops: newStops }
            : { kind: 'radial', stops: newStops },
      });
    }
  };

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
      emitColor(c);
    } catch {
      // User cancelled EyeDropper.
    }
  };

  const commitHex = () => {
    const parsed = parseHexInput(hexText);
    if (!parsed) {
      setHexText(rgbaHex(activeColor));
      return;
    }
    const next: Rgba = { ...parsed, a: alpha ? hsv.a : 1 };
    recordRecentColor(next);
    emitColor(next);
  };

  const setGradient = (g: Gradient) => {
    onChange({ kind: 'gradient', gradient: { ...g, stops: sortGradientStops(g.stops) } });
  };

  const updateStopAt = (idx: number, rawAt: number) => {
    if (value.kind !== 'gradient') return;
    const at = Math.max(0, Math.min(1, Math.round(rawAt * 1000) / 1000));
    const targetObj = { ...value.gradient.stops[idx]!, at };
    const nextStops = value.gradient.stops.map((s, j) => (j === idx ? targetObj : s));
    const sorted = sortGradientStops(nextStops);
    const newIdx = sorted.indexOf(targetObj);
    if (newIdx >= 0) setActiveStopIdx(newIdx);
    onChange({ kind: 'gradient', gradient: { ...value.gradient, stops: sorted } });
  };

  const addStopAt = (rawAt?: number) => {
    if (value.kind !== 'gradient') return;
    const cur = sortGradientStops(value.gradient.stops);
    if (cur.length >= MAX_GRAD_STOPS) return;
    let at = rawAt;
    if (at === undefined) {
      let widest = -1;
      let best = 0;
      for (let i = 0; i + 1 < cur.length; i++) {
        const gap = cur[i + 1]!.at - cur[i]!.at;
        if (gap > widest) {
          widest = gap;
          best = i;
        }
      }
      at = ((cur[best]?.at ?? 0) + (cur[best + 1]?.at ?? 1)) / 2;
    }
    const clamped = Math.max(0, Math.min(1, Math.round(at * 1000) / 1000));
    const newStop = { at: clamped, color: sampleGradientAt(cur, clamped) };
    const sorted = sortGradientStops([...cur, newStop]);
    const newIdx = sorted.indexOf(newStop);
    if (newIdx >= 0) setActiveStopIdx(newIdx);
    onChange({ kind: 'gradient', gradient: { ...value.gradient, stops: sorted } });
  };

  const removeActiveStop = () => {
    if (value.kind !== 'gradient' || value.gradient.stops.length <= MIN_GRAD_STOPS) return;
    const nextStops = value.gradient.stops.filter((_, j) => j !== clampedStopIdx);
    setActiveStopIdx(Math.max(0, Math.min(nextStops.length - 1, clampedStopIdx)));
    onChange({ kind: 'gradient', gradient: { ...value.gradient, stops: nextStops } });
  };

  const modeLabel = (m: PaintMode) =>
    m === 'none' ? 'None' : m === 'solid' ? 'Solid' : m === 'linear' ? 'Linear' : 'Radial';

  const content = (
    <div
      ref={popoverRef}
      className="color-popover"
      role="dialog"
      aria-label={modes.length > 1 ? 'Paint picker' : 'Color picker'}
      style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
      onMouseDown={preserveFocus ? (e) => e.preventDefault() : undefined}
    >
      {/* Segmented Paint Mode Tabs (Solid | Linear | Radial) */}
      {modes.length > 1 && (
        <div className="paint-mode-tabs" role="tablist" aria-label="Paint mode">
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={currentMode === m}
              className={`paint-mode-tab${currentMode === m ? ' active' : ''}`}
              onClick={() => switchMode(m)}
            >
              {modeLabel(m)}
            </button>
          ))}
        </div>
      )}

      {currentMode === 'none' ? (
        <div className="muted small" style={{ padding: '12px 4px', textAlign: 'center' }}>
          No fill applied. Choose Solid, Linear, or Radial above.
        </div>
      ) : (
        <>
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

          {/* Solid Hex + Alpha + Eyedropper (in gradient mode the active-stop bar below holds hex + pos%) */}
          {value.kind !== 'gradient' && (
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
                    emitColor({ ...parsed, a: alpha ? hsv.a : 1 });
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
                <button
                  type="button"
                  className="small"
                  onClick={pickFromScreen}
                  title="Pick color from screen"
                >
                  Pick
                </button>
              )}
            </div>
          )}

          {/* Deck & Theme Swatches */}
          {swatches.length > 0 && (
            <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="muted small">Deck &amp; Theme Swatches</span>
                <span className="muted" style={{ fontSize: 10 }}>
                  1-tap
                </span>
              </div>
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
                      emitColor(next);
                    }}
                  >
                    <span className="color-swatch-fill" style={{ background: rgbaCssString(s.color) }} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Interactive Gradient Ramp + Single Selected-Stop Bar */}
          {value.kind === 'gradient' && (
            <div
              className="col paint-grad-section"
              style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 10 }}
              data-gradient={value.gradient.kind}
            >
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                <span className="small" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Gradient Ramp
                </span>
                {value.gradient.kind === 'linear' && (
                  <div className="row" style={{ gap: 3, alignItems: 'center' }}>
                    {ANGLE_CHIPS.map((deg) => (
                      <button
                        key={deg}
                        type="button"
                        className={`paint-angle-chip${(value.gradient.angle ?? 90) === deg ? ' on' : ''}`}
                        onClick={() => setGradient({ ...value.gradient, angle: deg })}
                      >
                        {deg}°
                      </button>
                    ))}
                    <label className="paint-angle-input" title="Gradient angle in degrees">
                      <input
                        type="number"
                        aria-label="Angle"
                        min={-360}
                        max={360}
                        step={15}
                        value={Math.round(value.gradient.angle ?? 90)}
                        className="mono"
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) {
                            setGradient({
                              ...value.gradient,
                              angle: Math.max(-36000, Math.min(36000, v)),
                            });
                          }
                        }}
                      />
                      <span className="muted">°</span>
                    </label>
                  </div>
                )}
              </div>

              <div className="grad-ramp-wrap">
                <div
                  className="grad-ramp-bar color-checkerboard"
                  title="Click gradient track to add a stop"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    if (r.width <= 0) return;
                    addStopAt((e.clientX - r.left) / r.width);
                  }}
                >
                  <div
                    className="grad-ramp-fill"
                    style={{
                      background: `linear-gradient(90deg, ${value.gradient.stops
                        .map((s) => `${rgbaCss(s.color)} ${Math.round(s.at * 1000) / 10}%`)
                        .join(', ')})`,
                    }}
                  />
                </div>
                <div className="grad-ramp-pins">
                  {value.gradient.stops.map((s, i) => (
                    <button
                      // biome-ignore lint/suspicious/noArrayIndexKey: stops are ordered by position
                      key={i}
                      type="button"
                      className={`grad-ramp-pin${i === clampedStopIdx ? ' active' : ''}`}
                      aria-label={`Select gradient stop ${i + 1}`}
                      aria-pressed={i === clampedStopIdx}
                      style={{ left: `${s.at * 100}%`, background: rgbaCss(s.color) }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveStopIdx(i);
                      }}
                      onPointerDown={(e) => {
                        setActiveStopIdx(i);
                        e.currentTarget.dataset.dragging = '1';
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        if (e.currentTarget.dataset.dragging !== '1') return;
                        const r = e.currentTarget.parentElement?.getBoundingClientRect();
                        if (!r || r.width <= 0) return;
                        updateStopAt(i, (e.clientX - r.left) / r.width);
                      }}
                      onPointerUp={(e) => {
                        delete e.currentTarget.dataset.dragging;
                      }}
                      onPointerCancel={(e) => {
                        delete e.currentTarget.dataset.dragging;
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* Single Active-Stop Control Row: Stop N [■ #hex] [pos%] [+] [×] */}
              <div
                className="row paint-stop-bar"
                style={{ gap: 4, alignItems: 'center', flexWrap: 'nowrap' }}
              >
                <span className="muted small" style={{ whiteSpace: 'nowrap', minWidth: 38 }}>
                  Stop {clampedStopIdx + 1}
                </span>
                <span className="paint-stop-hex-wrap">
                  <span className="paint-stop-swatch" style={{ background: rgbaCssString(activeColor) }} />
                  <input
                    type="text"
                    value={hexText}
                    maxLength={7}
                    aria-label="Active stop hex color"
                    className="paint-stop-hex mono"
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const v = e.target.value;
                      setHexText(v);
                      const parsed = parseHexInput(v);
                      if (parsed && v.replace(/^#/, '').length === 6) {
                        emitColor({ ...parsed, a: alpha ? hsv.a : 1 });
                      }
                    }}
                    onBlur={commitHex}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitHex();
                    }}
                  />
                </span>
                <label
                  className="color-pct-box"
                  style={{ width: 54, flexShrink: 0 }}
                  title="Stop position percentage"
                >
                  <input
                    type="number"
                    min={0}
                    max={100}
                    aria-label="Active stop position"
                    value={Math.round((value.gradient.stops[clampedStopIdx]?.at ?? 0) * 100)}
                    className="mono"
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                      updateStopAt(clampedStopIdx, pct / 100);
                    }}
                  />
                  <span className="muted">%</span>
                </label>
                <button
                  type="button"
                  className="small paint-icon-btn"
                  aria-label="Add stop"
                  title="Add gradient stop"
                  disabled={value.gradient.stops.length >= MAX_GRAD_STOPS}
                  onClick={() => addStopAt()}
                >
                  +
                </button>
                <button
                  type="button"
                  className="small paint-icon-btn"
                  aria-label="Remove stop"
                  title="Remove selected stop"
                  disabled={value.gradient.stops.length <= MIN_GRAD_STOPS}
                  onClick={removeActiveStop}
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* Recent Colors (compact footer when solid) */}
          {value.kind !== 'gradient' && recent.length > 0 && (
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
                    onClick={() => emitColor(alpha ? c : { ...c, a: 1 })}
                  >
                    <span className="color-swatch-fill" style={{ background: rgbaCssString(c) }} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  if (inline) return content;
  if (typeof document === 'undefined') return null;
  return createPortal(content, document.body);
}

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
 * Anchored Solid Color Popover (backed by `PaintPopover` with live `Deck & Theme Swatches`).
 */
export function ColorPopover({
  anchor,
  value,
  alpha = true,
  swatches,
  preserveFocus = false,
  onChange,
  onClose,
}: ColorPopoverProps) {
  return (
    <PaintPopover
      anchor={anchor}
      value={{ kind: 'solid', color: value }}
      modes={['solid']}
      alpha={alpha}
      swatches={swatches}
      preserveFocus={preserveFocus}
      onChange={(next) => {
        if (next.kind === 'solid') onChange(next.color);
      }}
      onClose={onClose}
    />
  );
}

export interface PaintPillProps {
  value: PaintValue;
  onChange: (next: PaintValue) => void;
  modes?: readonly PaintMode[];
  alpha?: boolean;
  disabled?: boolean;
  swatches?: readonly ColorSwatch[];
  ariaLabel?: string;
  compact?: boolean;
  swatchOnly?: boolean;
}

/**
 * Unified inline Paint Pill supporting Solid (`[Swatch] [#hex] [opacity%]`), Gradient (`[GradSwatch] [Linear · 90°]`), and `None`.
 */
export function PaintPill({
  value,
  onChange,
  modes = ['solid', 'linear', 'radial'],
  alpha = true,
  disabled,
  swatches,
  ariaLabel,
  compact = false,
  swatchOnly = false,
}: PaintPillProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const solidColor = value.kind === 'solid' ? value.color : undefined;
  const [hexText, setHexText] = useState(() => (solidColor ? rgbaHex(solidColor) : '#3b82f6'));

  useEffect(() => {
    if (solidColor) setHexText(rgbaHex(solidColor));
  }, [solidColor]);

  const commitHex = () => {
    if (!solidColor) return;
    const parsed = parseHexInput(hexText);
    if (!parsed) {
      setHexText(rgbaHex(solidColor));
      return;
    }
    const next = { ...parsed, a: alpha ? solidColor.a : 1 };
    recordRecentColor(next);
    onChange({ kind: 'solid', color: next });
  };

  const swatchBg =
    value.kind === 'solid'
      ? rgbaCssString(value.color)
      : value.kind === 'gradient'
        ? gradientCssPreview(value.gradient)
        : 'linear-gradient(135deg, transparent 45%, #ef4444 45%, #ef4444 55%, transparent 55%)';

  const summaryText =
    value.kind === 'none'
      ? 'None'
      : value.kind === 'gradient'
        ? value.gradient.kind === 'linear'
          ? `Linear · ${Math.round(value.gradient.angle ?? 90)}°`
          : `Radial · ${value.gradient.stops.length}`
        : rgbaHex(value.color);

  return (
    <span
      className={`color-pill${compact ? ' compact' : ''}${swatchOnly ? ' swatch-only' : ''}${disabled ? ' disabled' : ''}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="color-pill-chip color-checkerboard"
        disabled={disabled}
        aria-label={ariaLabel ?? 'Open paint picker'}
        aria-expanded={open}
        title={`${ariaLabel ?? 'Open paint picker'} (${summaryText})`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="color-pill-fill" style={{ background: swatchBg }} />
      </button>
      {swatchOnly ? null : value.kind === 'solid' && !compact ? (
        <>
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
                onChange({ kind: 'solid', color: { ...parsed, a: alpha ? value.color.a : 1 } });
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
                value={Math.round(value.color.a * 100)}
                disabled={disabled}
                aria-label="Opacity percentage"
                className="mono"
                onChange={(e) => {
                  const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                  onChange({ kind: 'solid', color: { ...value.color, a: pct / 100 } });
                }}
              />
              <span className="muted small">%</span>
            </span>
          )}
        </>
      ) : (
        <button
          type="button"
          className="paint-pill-summary"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
        >
          {summaryText}
        </button>
      )}
      {open && !disabled && (
        <PaintPopover
          anchor={triggerRef.current}
          value={value}
          modes={modes}
          alpha={alpha}
          swatches={swatches}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

export interface ColorPillProps {
  value: Rgba;
  onChange: (c: Rgba) => void;
  alpha?: boolean;
  disabled?: boolean;
  swatches?: readonly ColorSwatch[];
  ariaLabel?: string;
  compact?: boolean;
  swatchOnly?: boolean;
}

/**
 * Unified inline solid ColorPill: `[Swatch] [#hex] [opacity%]` (or compact `[Swatch] [#hex]` in floating bars).
 */
export function ColorPill({
  value,
  onChange,
  alpha = true,
  disabled,
  swatches,
  ariaLabel,
  compact,
  swatchOnly,
}: ColorPillProps) {
  return (
    <PaintPill
      value={{ kind: 'solid', color: value }}
      modes={['solid']}
      alpha={alpha}
      disabled={disabled}
      swatches={swatches}
      ariaLabel={ariaLabel ?? 'Open color picker'}
      compact={compact}
      swatchOnly={swatchOnly}
      onChange={(next) => {
        if (next.kind === 'solid') onChange(next.color);
      }}
    />
  );
}
