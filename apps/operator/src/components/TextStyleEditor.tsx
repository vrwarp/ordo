import type { TextStyle } from '@ordo/domain';
import { Check, ColorField, Field, NumberField, Select } from './fields.tsx';
import { FontPicker } from './FontPicker.tsx';

/** Editor for every TextStyle field. `marks` flags overridden properties with an amber marker. */
export function TextStyleEditor(props: {
  value: TextStyle;
  onChange: (s: TextStyle, key: keyof TextStyle) => void;
  marks?: Set<string>;
}) {
  const s = props.value;
  const set = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => props.onChange({ ...s, [k]: v }, k);
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
        <NumberField
          label={<>Padding{mark('padding')}</>}
          value={s.padding}
          min={0}
          onChange={(v) => set('padding', v)}
          width={70}
        />
      </div>
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
