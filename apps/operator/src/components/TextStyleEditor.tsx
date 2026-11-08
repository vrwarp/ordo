import type { TextStyle } from '@ordo/domain';
import type { ReactNode } from 'react';
import { fontFamilies } from '../services/fonts.ts';
import { useLibrary } from '../state/library.ts';
import { Check, ColorField, Field, NumberField, Select } from './fields.tsx';
import { FontPicker } from './FontPicker.tsx';

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

/**
 * Editor for every TextStyle field. `marks` flags overridden properties with an amber marker.
 *
 * `box` adds the options of a text box on a slide (design/27 §11 item 4; M4 item C): 'Shrink text to fit'
 * (`autofit`) with 'Re-fit text' (`onRefit`: PowerPoint's stored fit scale cleared, so the text is fitted
 * again from full size), 'Wrap lines' (`wrap`), the four insets (in place of Padding), the text direction,
 * the line spacing model and the fallback font. Themes and looks leave it off: their styles are applied to
 * boxes of their own.
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
  return (
    <div className="col">
      <Field label={<>Font{mark('fontFamily')}</>}>
        <FontPicker value={s.fontFamily} onChange={(f) => set('fontFamily', f)} />
      </Field>
      <div className="grid3">
        <NumberField
          label={<>Size{mark('fontSizePx')}</>}
          value={s.fontSizePx}
          min={4}
          max={600}
          onChange={(v) => set('fontSizePx', v)}
          width={70}
        />
        <Select
          label={<>Weight{mark('fontWeight')}</>}
          value={String(s.fontWeight)}
          options={['100', '200', '300', '400', '500', '600', '700', '800', '900']}
          onChange={(v) => set('fontWeight', Number(v))}
        />
        <Select
          label={<>Style{mark('fontStyle')}</>}
          value={s.fontStyle}
          options={['normal', 'italic'] as const}
          onChange={(v) => set('fontStyle', v)}
        />
      </div>
      <ColorField label={<>Colour{mark('color')}</>} value={s.color} onChange={(c) => set('color', c)} />
      <Check
        label={<>Show in capitals{mark('transform')}</>}
        value={s.transform === 'uppercase'}
        onChange={(v) => set('transform', v ? 'uppercase' : 'none')}
      />
      <div className="grid2">
        <Select
          label={<>Align{mark('align')}</>}
          value={s.align}
          options={['left', 'center', 'right'] as const}
          onChange={(v) => set('align', v)}
        />
        <Select
          label={<>Vertical{mark('valign')}</>}
          value={s.valign}
          options={['top', 'middle', 'bottom'] as const}
          onChange={(v) => set('valign', v)}
        />
      </div>
      <div className="grid3">
        <NumberField
          label={<>Line height{mark('lineHeight')}</>}
          value={s.lineHeight}
          step={0.05}
          min={0.5}
          max={4}
          onChange={(v) => set('lineHeight', v)}
          width={70}
        />
        <NumberField
          label={<>Letter sp.{mark('letterSpacing')}</>}
          value={s.letterSpacing}
          step={0.5}
          onChange={(v) => set('letterSpacing', v)}
          width={70}
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
      </div>
      {props.box && (
        <div className="col" role="group" aria-label="Text box">
          <span className="small muted">Text box</span>
          <Check
            label={<>Shrink text to fit{mark('autofit')}</>}
            value={s.autofit === 'shrink'}
            onChange={(on) => setOpt('autofit', on ? 'shrink' : undefined)}
          />
          {s.autofit === 'shrink' && (
            <div className="row wrap">
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
          <div className="grid4">
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
          <div className="grid2">
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
      <Check
        label={<>Outline{mark('outline')}</>}
        value={!!s.outline}
        onChange={(on) => set('outline', on ? { width: 3, color: { r: 0, g: 0, b: 0, a: 1 } } : undefined)}
      />
      {s.outline && (
        <div className="row wrap">
          <NumberField
            value={s.outline.width}
            min={0}
            max={50}
            step={0.5}
            onChange={(width) => set('outline', { ...s.outline!, width })}
            suffix="px"
            width={60}
          />
          <ColorField
            value={s.outline.color}
            onChange={(color) => set('outline', { ...s.outline!, color })}
          />
        </div>
      )}
      <Check
        label={<>Shadow{mark('shadow')}</>}
        value={!!s.shadow}
        onChange={(on) =>
          set('shadow', on ? { dx: 0, dy: 4, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.6 } } : undefined)
        }
      />
      {s.shadow && (
        <div className="col">
          <div className="grid3">
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
          <ColorField value={s.shadow.color} onChange={(color) => set('shadow', { ...s.shadow!, color })} />
        </div>
      )}
      <Check
        label={<>Fill behind text{mark('fill')}</>}
        value={!!s.fill}
        onChange={(on) => set('fill', on ? { color: { r: 0, g: 0, b: 0, a: 0.55 }, radius: 12 } : undefined)}
      />
      {s.fill && (
        <div className="row wrap">
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
