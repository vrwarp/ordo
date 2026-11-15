import type { Rgba } from '@ordo/domain';
import type { ReactNode } from 'react';
import { ColorPill } from './ColorPicker.tsx';
import type { ColorSwatch } from './colorMath.ts';
import { Field } from './fields.tsx';

/**
 * A colour pill with an optional label. Its own module (not components/fields.tsx): ColorPicker brings the
 * paint stops, colour maths and deck swatches, which the number and text fields of every dialog do not need
 * (design/28 §3.1 "Code split").
 */
export function ColorField(props: {
  label?: ReactNode;
  value: Rgba;
  onChange: (c: Rgba) => void;
  alpha?: boolean;
  disabled?: boolean;
  swatches?: readonly ColorSwatch[];
}) {
  const el = (
    <ColorPill
      value={props.value}
      onChange={props.onChange}
      alpha={props.alpha}
      disabled={props.disabled}
      swatches={props.swatches}
    />
  );
  return props.label ? <Field label={props.label}>{el}</Field> : el;
}
