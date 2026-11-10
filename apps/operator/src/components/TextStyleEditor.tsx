import type { TextStyle } from '@ordo/domain';
import type { ReactNode } from 'react';
import { AlignIcon, VAlignIcon, hexToRgb, rgbToHex } from './AlignIcons.tsx';
import { Check, ColorField, Field, NumberField, Select } from './fields.tsx';
import { FontPicker } from './FontPicker.tsx';
import { fontFamilies } from '../services/fonts.ts';
import { useLibrary } from '../state/library.ts';

/** The four sides of a text box's insets. */
export type InsetSide = 'l' | 't' | 'r' | 'b';

/** `s` with `k` set to `v`, or without `k` when `v` is undefined (the field's default). */
export function withField<K extends keyof TextStyle>(
  s: TextStyle,
  k: K,
  v: TextStyle[K] | undefined,
): TextStyle {
  if (v !== undefined) return { ...s, [k]: v };
  if (!(k in s)) return s;
  const { [k]: _, ...rest } = s;
  return rest as TextStyle;
}

/** The space between the box and its text on each side: `insets`, else `padding` on every side. */
export function insetsOf(s: TextStyle): { l: number; t: number; r: number; b: number } {
  const p = s.padding;
  return s.insets ?? { l: p, t: p, r: p, b: p };
}

/**
 * `s` with one inset set: the four become `insets` (which replace `padding` where they exist), and `padding`
 * becomes the smallest of them, the closest legacy value (design/27 §3.2), so an older build still draws the
 * text inside the box.
 */
export function withInset(s: TextStyle, side: InsetSide, v: number): TextStyle {
  const insets = { ...insetsOf(s), [side]: Math.max(0, v) };
  return { ...s, insets, padding: Math.min(insets.l, insets.t, insets.r, insets.b) };
}

/**
 * `s` with its fallback font (the first of `fallbackFonts`: the face tried for characters the box's font
 * lacks, a bilingual congregation's second script) set to `family`, or removed for ''. The other fallbacks
 * stay after it.
 */
export function withFallback(s: TextStyle, family: string): TextStyle {
  const rest = (s.fallbackFonts ?? []).slice(1).filter((f) => f !== family);
  const list = family ? [family, ...rest].slice(0, 8) : rest;
  return withField(s, 'fallbackFonts', list.length ? list : undefined);
}

const QUICK_COLORS = [
  { label: 'Crisp White', hex: '#ffffff', color: { r: 255, g: 255, b: 255, a: 1 } },
  { label: 'Warm Cream', hex: '#f6f5ee', color: { r: 246, g: 245, b: 238, a: 1 } },
  { label: 'Soft Gold', hex: '#fef08a', color: { r: 254, g: 240, b: 138, a: 1 } },
  { label: 'Sky Cyan', hex: '#7dd3fc', color: { r: 125, g: 211, b: 252, a: 1 } },
  { label: 'Deep Black', hex: '#111827', color: { r: 17, g: 24, b: 39, a: 1 } },
];

const FONT_SIZES = [
  { label: '24', size: 24 },
  { label: '36', size: 36 },
  { label: '48', size: 48 },
  { label: '64', size: 64 },
  { label: '80', size: 80 },
];

/**
 * Modern visual typography & projection inspector for slide text objects and themes.
 * Uses segmented controls, steppers, projection readability cards, and progressive disclosure.
 */
export function TextStyleEditor(props: {
  value: TextStyle;
  onChange: (s: TextStyle, key: keyof TextStyle) => void;
  marks?: Set<string>;
  /** Show the text box options (the Object panel). */
  box?: boolean;
  /** 'Re-fit text'; the button is disabled without it (read-only) or without a stored fit scale. */
  onRefit?: () => void;
}) {
  const s = props.value;
  const set = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => props.onChange({ ...s, [k]: v }, k);
  const setOpt = <K extends keyof TextStyle>(k: K, v: TextStyle[K] | undefined) =>
    props.onChange(withField(s, k, v), k);
  const ins = insetsOf(s);
  const mark = (k: keyof TextStyle) =>
    props.marks?.has(`style.${k}`) ? (
      <span className="override-mark" title="Overrides the theme">
        {' '}
        ●
      </span>
    ) : null;

  const activeContrastMode =
    s.outline && s.shadow ? 'outline-shadow' : s.outline ? 'outline' : s.shadow ? 'shadow' : 'clean';

  return (
    <div className="col" style={{ gap: 16 }}>
      {/* 1. Font Family */}
      <div className="col" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            className="small bold"
            style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
          >
            Font Family{mark('fontFamily')}
          </span>
        </div>
        <FontPicker value={s.fontFamily} onChange={(f) => set('fontFamily', f)} />
      </div>

      {/* 2. Font Size (Stepper + Slider + Presets) */}
      <div className="col" style={{ gap: 8 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <span
            className="small bold"
            style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
          >
            Font Size{mark('fontSizePx')}
          </span>
          <div className="row" style={{ gap: 4 }}>
            {FONT_SIZES.map(({ label, size }) => (
              <button
                key={label}
                type="button"
                className={`small ${s.fontSizePx === size ? 'active' : ''}`}
                style={{
                  padding: '2px 8px',
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: s.fontSizePx === size ? 700 : 500,
                  background: s.fontSizePx === size ? 'var(--accent)' : 'var(--bg3)',
                  color: s.fontSizePx === size ? '#fff' : 'var(--fg)',
                  border: '1px solid var(--line)',
                  cursor: 'pointer',
                }}
                onClick={() => set('fontSizePx', size)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="row" style={{ gap: 10, alignItems: 'center' }}>
          <div className="stepper-box">
            <button
              type="button"
              aria-label="Decrease font size"
              onClick={() => set('fontSizePx', Math.max(8, s.fontSizePx - 4))}
            >
              −
            </button>
            <input
              type="number"
              aria-label="Font size in pixels"
              value={s.fontSizePx}
              min={8}
              max={300}
              onChange={(e) => set('fontSizePx', Math.max(8, Math.min(300, Number(e.target.value) || 40)))}
            />
            <button
              type="button"
              aria-label="Increase font size"
              onClick={() => set('fontSizePx', Math.min(300, s.fontSizePx + 4))}
            >
              +
            </button>
          </div>
          <input
            type="range"
            min={12}
            max={160}
            step={2}
            value={s.fontSizePx}
            onChange={(e) => set('fontSizePx', Number(e.target.value))}
            style={{ flex: 1 }}
          />
        </div>
      </div>

      {/* 3. Style & Casing (Segmented Pills) */}
      <div className="col" style={{ gap: 6 }}>
        <span
          className="small bold"
          style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
        >
          Style & Casing{mark('fontWeight')}
          {mark('fontStyle')}
          {mark('transform')}
        </span>
        <div className="segmented-bar">
          <button
            type="button"
            className={s.fontWeight >= 600 ? 'active' : ''}
            onClick={() => set('fontWeight', s.fontWeight >= 600 ? 400 : 700)}
            aria-label="Bold text"
          >
            <b>B Bold</b>
          </button>
          <button
            type="button"
            className={s.fontStyle === 'italic' ? 'active' : ''}
            onClick={() => set('fontStyle', s.fontStyle === 'italic' ? 'normal' : 'italic')}
            aria-label="Italic text"
          >
            <i>I Italic</i>
          </button>
          <button
            type="button"
            className={s.transform === 'uppercase' ? 'active' : ''}
            onClick={() => set('transform', s.transform === 'uppercase' ? 'none' : 'uppercase')}
            aria-label="All capitals"
          >
            AA Caps
          </button>
        </div>
      </div>

      {/* 4. Alignment (Horizontal & Vertical SVG Segmented Bars) */}
      <div className="grid2" style={{ gap: 8 }}>
        <div className="col" style={{ gap: 6 }}>
          <span
            className="small bold"
            style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
          >
            Align{mark('align')}
          </span>
          <div className="segmented-bar">
            {(['left', 'center', 'right'] as const).map((a) => (
              <button
                key={a}
                type="button"
                className={s.align === a ? 'active' : ''}
                onClick={() => set('align', a)}
                aria-label={`Align ${a}`}
              >
                <AlignIcon align={a} />
              </button>
            ))}
          </div>
        </div>
        <div className="col" style={{ gap: 6 }}>
          <span
            className="small bold"
            style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
          >
            Vertical{mark('valign')}
          </span>
          <div className="segmented-bar">
            {(['top', 'middle', 'bottom'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={s.valign === v ? 'active' : ''}
                onClick={() => set('valign', v)}
                aria-label={`Vertical align ${v}`}
              >
                <VAlignIcon valign={v} />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 5. Text Color & Palette */}
      <div className="col" style={{ gap: 6 }}>
        <span
          className="small bold"
          style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
        >
          Text Color{mark('color')}
        </span>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {QUICK_COLORS.map(({ label, hex, color }) => {
            const isSelected = s.color.r === color.r && s.color.g === color.g && s.color.b === color.b;
            return (
              <button
                key={label}
                type="button"
                title={label}
                onClick={() => set('color', color)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  background: hex,
                  border: isSelected ? '2px solid var(--accent)' : '1px solid var(--line)',
                  boxShadow: isSelected ? '0 0 0 2px var(--bg), 0 0 0 4px var(--accent)' : 'none',
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            );
          })}
          <div style={{ marginLeft: 4 }}>
            <input
              type="color"
              value={rgbToHex(s.color.r, s.color.g, s.color.b)}
              aria-label="Pick custom text color"
              onChange={(e) => {
                const c = hexToRgb(e.target.value);
                set('color', { ...c, a: s.color.a ?? 1 });
              }}
              style={{
                width: 30,
                height: 30,
                padding: 1,
                border: '1px solid var(--line)',
                borderRadius: 6,
                background: 'transparent',
                cursor: 'pointer',
              }}
            />
          </div>
        </div>
      </div>

      {/* 6. Projection Contrast & Legibility Cards */}
      <div className="col" style={{ gap: 8 }}>
        <div className="col" style={{ gap: 2 }}>
          <span
            className="small bold"
            style={{ letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--fg2)' }}
          >
            Projection Contrast & Readability{mark('outline')}
            {mark('shadow')}
          </span>
          <span className="muted" style={{ fontSize: 11 }}>
            Optimized for auditorium screens and motion video backgrounds.
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <button
            type="button"
            className={`contrast-card-btn ${activeContrastMode === 'clean' ? 'active' : ''}`}
            onClick={() => props.onChange({ ...s, outline: undefined, shadow: undefined }, 'outline')}
          >
            <span style={{ fontSize: 16, fontWeight: 700, color: '#fff' }}>Clean Text</span>
            <span className="muted small" style={{ fontSize: 11 }}>
              No stroke or shadow
            </span>
          </button>

          <button
            type="button"
            className={`contrast-card-btn ${activeContrastMode === 'shadow' ? 'active' : ''}`}
            onClick={() =>
              props.onChange(
                {
                  ...s,
                  outline: undefined,
                  shadow: { dx: 0, dy: 4, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.7 } },
                },
                'shadow',
              )
            }
          >
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: '#fff',
                textShadow: '0 4px 10px rgba(0,0,0,0.8)',
              }}
            >
              Soft Shadow
            </span>
            <span className="muted small" style={{ fontSize: 11 }}>
              Natural depth
            </span>
          </button>

          <button
            type="button"
            className={`contrast-card-btn ${activeContrastMode === 'outline' ? 'active' : ''}`}
            onClick={() =>
              props.onChange(
                {
                  ...s,
                  outline: { width: 4, color: { r: 0, g: 0, b: 0, a: 1 } },
                  shadow: undefined,
                },
                'outline',
              )
            }
          >
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: '#fff',
                WebkitTextStroke: '1px #000',
              }}
            >
              Outline (Church)
            </span>
            <span className="muted small" style={{ fontSize: 11 }}>
              Sharp on bright screens
            </span>
          </button>

          <button
            type="button"
            className={`contrast-card-btn ${activeContrastMode === 'outline-shadow' ? 'active' : ''}`}
            onClick={() =>
              props.onChange(
                {
                  ...s,
                  outline: { width: 4, color: { r: 0, g: 0, b: 0, a: 1 } },
                  shadow: { dx: 0, dy: 4, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.7 } },
                },
                'outline',
              )
            }
          >
            <span
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: '#fff',
                WebkitTextStroke: '1px #000',
                textShadow: '0 4px 10px rgba(0,0,0,0.9)',
              }}
            >
              Outline + Shadow
            </span>
            <span className="muted small" style={{ fontSize: 11 }}>
              Maximum contrast
            </span>
          </button>
        </div>

        {/* Outline Fine-Tuning when Outline is active */}
        {s.outline && (
          <div
            className="col"
            style={{
              gap: 8,
              background: 'var(--bg3)',
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid var(--line)',
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="small bold">Outline Thickness ({s.outline.width} px)</span>
              <div className="row" style={{ gap: 4 }}>
                {[2, 4, 6, 8].map((w) => (
                  <button
                    key={w}
                    type="button"
                    className={`small ${s.outline?.width === w ? 'active' : ''}`}
                    style={{
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontSize: 11,
                      background: s.outline?.width === w ? 'var(--accent)' : 'transparent',
                      color: s.outline?.width === w ? '#fff' : 'var(--fg)',
                      border: '1px solid var(--line)',
                      cursor: 'pointer',
                    }}
                    onClick={() => set('outline', { ...s.outline!, width: w })}
                  >
                    {w}px
                  </button>
                ))}
              </div>
            </div>
            <input
              type="range"
              min={1}
              max={16}
              step={0.5}
              value={s.outline.width}
              onChange={(e) => set('outline', { ...s.outline!, width: Number(e.target.value) })}
            />
          </div>
        )}
      </div>

      {/* 7. Progressive Disclosure: Advanced Typography, Insets & Text Box Properties */}
      <details
        className="advanced-details"
        style={{
          background: 'var(--bg3)',
          border: '1px solid var(--line)',
          borderRadius: 8,
          padding: '10px 12px',
        }}
      >
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--fg2)',
            outline: 'none',
          }}
        >
          Advanced Typography & Insets
        </summary>
        <div className="col" style={{ gap: 12, marginTop: 12 }}>
          {/* Spacing Controls */}
          <div className="grid2" style={{ gap: 8 }}>
            <label className="col" style={{ gap: 3 }}>
              <span className="small muted">
                Line height{mark('lineHeight')} ({s.lineHeight ?? 1.2})
              </span>
              <input
                type="range"
                min={0.8}
                max={2.5}
                step={0.05}
                value={s.lineHeight ?? 1.2}
                onChange={(e) => set('lineHeight', Number(e.target.value))}
              />
            </label>
            <label className="col" style={{ gap: 3 }}>
              <span className="small muted">
                Letter sp.{mark('letterSpacing')} ({s.letterSpacing ?? 0} px)
              </span>
              <input
                type="range"
                min={-2}
                max={12}
                step={0.5}
                value={s.letterSpacing ?? 0}
                onChange={(e) => set('letterSpacing', Number(e.target.value))}
              />
            </label>
          </div>

          <Select
            label={<>Exact Font Weight{mark('fontWeight')}</>}
            value={String(s.fontWeight)}
            options={['100', '200', '300', '400', '500', '600', '700', '800', '900']}
            onChange={(v) => set('fontWeight', Number(v))}
          />

          {!props.box && (
            <NumberField
              label={<>Padding{mark('padding')}</>}
              value={s.padding}
              min={0}
              onChange={(v) => set('padding', v)}
              width={70}
            />
          )}

          {/* Text Box Container Properties */}
          {props.box && (
            <div
              className="col"
              role="group"
              aria-label="Text box"
              style={{ gap: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}
            >
              <span
                className="small bold"
                style={{ textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg2)' }}
              >
                Text box
              </span>
              <Check
                label={<>Shrink text to fit{mark('autofit')}</>}
                value={s.autofit === 'shrink'}
                onChange={(on) => setOpt('autofit', on ? 'shrink' : undefined)}
              />
              {s.autofit === 'shrink' && (
                <div className="row wrap" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="small"
                    disabled={!props.onRefit || !s.fitScale}
                    onClick={props.onRefit}
                  >
                    Re-fit text
                  </button>
                  <span className="muted small">
                    {s.fitScale
                      ? `Shrunk to ${Math.round(s.fitScale.font * 100)} %, kept while the text fits. Re-fit sizes it again from full size.`
                      : 'Shrunk as far as the text needs.'}
                  </span>
                </div>
              )}
              <Check
                label={<>Wrap lines{mark('wrap')}</>}
                value={s.wrap !== false}
                onChange={(on) => setOpt('wrap', on ? undefined : false)}
              />
              <div className="grid4" style={{ gap: 6 }}>
                {(
                  [
                    ['l', 'Inset left'],
                    ['t', 'Inset top'],
                    ['r', 'Inset right'],
                    ['b', 'Inset bottom'],
                  ] as const
                ).map(([side, label]) => (
                  <NumberField
                    key={side}
                    label={
                      <>
                        {label}
                        {mark('insets')}
                      </>
                    }
                    value={ins[side]}
                    min={0}
                    onChange={(v) => props.onChange(withInset(s, side, v), 'insets')}
                    width={60}
                  />
                ))}
              </div>
              <div className="grid2" style={{ gap: 8 }}>
                <Select
                  label={<>Direction{mark('direction')}</>}
                  value={s.direction ?? 'auto'}
                  options={[
                    { value: 'auto', label: 'Auto' },
                    { value: 'ltr', label: 'Left to right' },
                    { value: 'rtl', label: 'Right to left' },
                  ]}
                  onChange={(v) => setOpt('direction', v === 'auto' ? undefined : v)}
                />
                <Select
                  label={<>Line spacing model{mark('lineModel')}</>}
                  value={s.lineModel ?? 'ordo'}
                  options={[
                    { value: 'ordo', label: 'ordo' },
                    { value: 'office', label: 'PowerPoint' },
                  ]}
                  onChange={(v) => setOpt('lineModel', v === 'ordo' ? undefined : v)}
                />
              </div>
              <FallbackFontField
                label={<>Fallback font{mark('fallbackFonts')}</>}
                value={s.fallbackFonts?.[0] ?? ''}
                onChange={(f) => props.onChange(withFallback(s, f), 'fallbackFonts')}
              />
            </div>
          )}

          {/* Shadow & Background Fine-Tuning */}
          {s.shadow && (
            <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
              <span className="small bold">Shadow Fine-Tuning</span>
              <div className="grid3" style={{ gap: 6 }}>
                <NumberField
                  label="dx"
                  value={s.shadow.dx}
                  onChange={(dx) => set('shadow', { ...s.shadow!, dx })}
                  width={60}
                />
                <NumberField
                  label="dy"
                  value={s.shadow.dy}
                  onChange={(dy) => set('shadow', { ...s.shadow!, dy })}
                  width={60}
                />
                <NumberField
                  label="Blur"
                  value={s.shadow.blur}
                  min={0}
                  onChange={(blur) => set('shadow', { ...s.shadow!, blur })}
                  width={60}
                />
              </div>
              <ColorField
                value={s.shadow.color}
                onChange={(color) => set('shadow', { ...s.shadow!, color })}
              />
            </div>
          )}

          <div className="col" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <Check
              label={<>Fill behind text{mark('fill')}</>}
              value={!!s.fill}
              onChange={(on) =>
                set('fill', on ? { color: { r: 0, g: 0, b: 0, a: 0.55 }, radius: 12 } : undefined)
              }
            />
            {s.fill && (
              <div className="row wrap" style={{ gap: 8 }}>
                <ColorField value={s.fill.color} onChange={(color) => set('fill', { ...s.fill!, color })} />
                <NumberField
                  label="Radius"
                  value={s.fill.radius}
                  min={0}
                  onChange={(radius) => set('fill', { ...s.fill!, radius })}
                  width={60}
                />
              </div>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

/**
 * The fallback font of a box: None, or a family of the library (or the one set), for the characters the
 * box's font does not have (a Hebrew, Arabic, Korean or Chinese line in a Latin box).
 */
function FallbackFontField(props: { label: ReactNode; value: string; onChange: (family: string) => void }) {
  const fonts = useLibrary((st) => st.data.fonts);
  const families = fontFamilies(fonts);
  if (props.value && !families.includes(props.value)) families.unshift(props.value);
  return (
    <Field label={props.label} hint="For characters the font does not have, such as a second language.">
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)} style={{ maxWidth: 220 }}>
        <option value="">None</option>
        {families.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </Field>
  );
}
