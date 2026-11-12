import {
  hexToRgba,
  type Presentation,
  type Rgba,
  rgbaCss,
  rgbaHex,
  type TextObject,
  type TextStyle,
  type Theme,
} from '@ordo/domain';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ColorPopover } from '../../components/ColorPicker.tsx';
import { FontPicker } from '../../components/FontPicker.tsx';
import { useCoarsePointer } from '../../components/pointer.ts';
import { useLibrary } from '../../state/library.ts';
import { formatSelection, resizeSelection } from './actions.ts';
import { useEditor } from './editorStore.ts';
import { BarButton, MixedNumber, refocusText, Toggle, textField } from './formatControls.tsx';
import {
  CLEAR_FORMATTING,
  type RunPatch,
  type RunStyle,
  type SelectionStyle,
  selectionStyle,
  type TextRange,
} from './ops/text.ts';

/*
 * The format bar over the text field (design/27 §11 item 2; M4 item C): formatting for the selection
 * `range` of the textarea (`TextRange`, the field's selectionStart/selectionEnd, tracked by the Object
 * panel):
 * - font (the FontPicker), Size − / + (`resizeSelection`: `sizeScale`, relative to the box's size), Bold,
 *   Italic, Underline, Strikethrough, colour (swatches of the deck's colours first: `deckColors`) and
 *   highlight, Superscript and Subscript (verse numbers: `baseline` 0.3 / -0.25), Caps (none, all, small)
 *   and Clear formatting (`CLEAR_FORMATTING`);
 * - each applies `formatSelection` (actions.ts) to the range, one undo step; with an empty range (a caret)
 *   the controls are disabled, and a note says to select text;
 * - the pressed states and values come from `selectionStyle` (ops/text.ts): a mixed field shows as such
 *   (`aria-pressed="mixed"`, 'Mixed');
 * - advanced controls (letter spacing, outline, shadow, language) behind 'More' (design/27 §17 "Editor
 *   complexity").
 * A value equal to the box's own removes the override (the characters take the box style again), so the
 * runs stay as sparse as the import wrote them.
 *
 * Accessibility (design/15): a `role="toolbar"` labelled 'Text format', toggle buttons with `aria-pressed`
 * and a text label or `aria-label` each (no meaning by icon or colour alone), reachable by Tab, operated by
 * Enter and Space, Ctrl+B / Ctrl+I / Ctrl+U while the text field has focus; after a button the text field
 * gets its focus and selection back (a pointer never takes it away). 44 px controls under a coarse pointer
 * (the design system's `button.small`); nothing on hover only.
 */

/** A colour swatch: the colour and the name a screen reader reads. */
export type Swatch = { color: Rgba; name: string };

/** Size − / + multiply the selection's sizes by this (and its inverse, which comes back exactly). */
export const SIZE_STEP = 1.1;
/** Superscript and subscript (verse numbers): PowerPoint's default baselines (design/27 §3.1). */
export const SUPERSCRIPT = 0.3;
export const SUBSCRIPT = -0.25;

/** Colours offered after the deck's own: the Office theme's, which most church decks start from. */
export const STANDARD_COLORS: readonly Swatch[] = [
  { color: hexToRgba('#ffffff'), name: 'White' },
  { color: hexToRgba('#000000'), name: 'Black' },
  { color: hexToRgba('#7f7f7f'), name: 'Grey' },
  { color: hexToRgba('#c00000'), name: 'Dark red' },
  { color: hexToRgba('#ed7d31'), name: 'Orange' },
  { color: hexToRgba('#ffc000'), name: 'Gold' },
  { color: hexToRgba('#70ad47'), name: 'Green' },
  { color: hexToRgba('#4472c4'), name: 'Blue' },
  { color: hexToRgba('#1f3864'), name: 'Navy' },
  { color: hexToRgba('#7030a0'), name: 'Purple' },
];

/** Highlight colours (a text marker's). */
export const HIGHLIGHTS: readonly Swatch[] = [
  { color: hexToRgba('#ffff00'), name: 'Yellow' },
  { color: hexToRgba('#00ff00'), name: 'Bright green' },
  { color: hexToRgba('#00ffff'), name: 'Turquoise' },
  { color: hexToRgba('#ff66cc'), name: 'Pink' },
  { color: hexToRgba('#d9d9d9'), name: 'Light grey' },
];

/** The deck's colours shown first, at most. */
export const DECK_SWATCHES = 8;

const sameColor = (a: Rgba | undefined, b: Rgba | undefined) =>
  !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
const colorKey = (c: Rgba) => `${c.r},${c.g},${c.b},${c.a}`;

/**
 * The colour swatches of the format bar: the deck's own colours first (design/27 §11 item 2), then the
 * standard ones it does not use. The deck's are what its text is drawn in: the applied theme's text colour,
 * then the colours of its text boxes and runs and of its shapes' fills (PowerPoint's theme colours, resolved
 * at import, are among them), most used first, at most `DECK_SWATCHES`.
 */
export function deckColors(p: Presentation | undefined, theme?: Theme): Swatch[] {
  const counts = new Map<string, { color: Rgba; n: number; first: number }>();
  let order = 0;
  const add = (c: Rgba | undefined, weight = 1) => {
    if (!c) return;
    const k = colorKey(c);
    const hit = counts.get(k);
    if (hit) hit.n += weight;
    else counts.set(k, { color: c, n: weight, first: order++ });
  };
  for (const sec of p?.sections ?? [])
    for (const s of sec.slides)
      for (const o of s.objects) {
        if (o.type === 'text') {
          add(o.style.color);
          for (const r of o.runs ?? []) add(r.color);
        } else if (o.type === 'shape') add(o.fill);
      }
  const used = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first).map((x) => x.color);
  const deck: Rgba[] = [];
  if (theme) deck.push(theme.text.color);
  for (const c of used) {
    if (deck.length >= DECK_SWATCHES) break;
    if (!deck.some((d) => sameColor(d, c))) deck.push(c);
  }
  const out: Swatch[] = deck.map((color, i) => ({
    color,
    name: `${i === 0 && theme ? 'Theme colour' : 'Deck colour'} ${rgbaHex(color)}`,
  }));
  for (const s of STANDARD_COLORS) if (!deck.some((d) => sameColor(d, s.color))) out.push(s);
  return out;
}

/** Caps as the box draws them ('all' for a box shown in capitals). */
const boxCaps = (s: TextStyle): 'none' | 'all' => (s.transform === 'uppercase' ? 'all' : 'none');
const isBold = (w: number) => w >= 600;

/** A field of the selection: its value, the box's when nothing says otherwise, or 'mixed'. */
function field<K extends keyof RunStyle>(
  sel: SelectionStyle,
  k: K,
  dflt: RunStyle[K],
): RunStyle[K] | 'mixed' {
  if (sel.mixed.includes(k)) return 'mixed';
  return sel.style[k] !== undefined ? sel.style[k] : dflt;
}
const tri = (v: unknown, on: (x: never) => boolean): boolean | 'mixed' =>
  v === 'mixed' ? 'mixed' : on(v as never);

/** What the format bar shows for a selection (pressed states, values, 'mixed'). */
export type BarState = {
  bold: boolean | 'mixed';
  italic: boolean | 'mixed';
  underline: boolean | 'mixed';
  strike: boolean | 'mixed';
  superscript: boolean | 'mixed';
  subscript: boolean | 'mixed';
  caps: 'none' | 'all' | 'small' | 'mixed';
  /** The selection's colour (undefined: mixed). */
  color: Rgba | undefined;
  /** Its highlight: none, a colour, or 'mixed'. */
  highlight: Rgba | 'none' | 'mixed';
  /** The font family (undefined: mixed). */
  font: string | undefined;
  /** The size in logical px, before autofit (undefined: mixed). */
  sizePx: number | undefined;
  letterSpacing: number | undefined;
  outline: boolean | 'mixed';
  shadow: boolean | 'mixed';
  /** The language tag ('' for none; undefined: mixed). */
  lang: string | undefined;
};

/**
 * The format bar's state for `sel` (`selectionStyle` of the range) over box `o`: each field as the
 * selection resolves it, the box's value where it says nothing.
 */
export function barState(o: TextObject, sel: SelectionStyle): BarState {
  const s = o.style;
  const weight = field(sel, 'fontWeight', s.fontWeight);
  const baseline = field(sel, 'baseline', 0);
  const color = field(sel, 'color', s.color);
  const highlight = field(sel, 'highlight', undefined);
  const scale = field(sel, 'sizeScale', 1);
  const outline = field(sel, 'outline', s.outline ?? null);
  const shadow = field(sel, 'shadow', s.shadow ?? null);
  const font = field(sel, 'fontFamily', s.fontFamily);
  const spacing = field(sel, 'letterSpacing', s.letterSpacing);
  const lang = field(sel, 'lang', s.lang ?? '');
  return {
    bold: tri(weight, (w: number) => isBold(w)),
    italic: tri(field(sel, 'fontStyle', s.fontStyle), (v: string) => v === 'italic'),
    underline: tri(field(sel, 'underline', s.underline ?? false), (v: boolean) => v === true),
    strike: tri(field(sel, 'strike', false), (v: boolean) => v === true),
    superscript: tri(baseline, (b: number) => b > 0),
    subscript: tri(baseline, (b: number) => b < 0),
    caps: (field(sel, 'caps', boxCaps(s)) ?? 'none') as BarState['caps'],
    color: color === 'mixed' ? undefined : color,
    highlight: highlight === 'mixed' ? 'mixed' : (highlight ?? 'none'),
    font: font === 'mixed' ? undefined : font,
    sizePx: scale === 'mixed' ? undefined : s.fontSizePx * (scale ?? 1),
    letterSpacing: spacing === 'mixed' ? undefined : spacing,
    outline: tri(outline, (v: unknown) => !!v),
    shadow: tri(shadow, (v: unknown) => !!v),
    lang: lang === 'mixed' ? undefined : (lang ?? ''),
  };
}

/** The toggles of the bar, as Ctrl+B / Ctrl+I / Ctrl+U name three of them. */
export type FormatToggle = 'bold' | 'italic' | 'underline' | 'strike' | 'superscript' | 'subscript';

/**
 * The patch a toggle applies: on when it is off or mixed, else off. Bold is weight 700 over a normal box
 * and the box's own weight (no override) over a bold one; off is the reverse (400 over a bold box). Italic
 * and underline alike; strike, superscript (+0.3) and subscript (−0.25) set or remove their override.
 */
export function togglePatch(t: FormatToggle, o: TextObject, state: BarState): RunPatch {
  const on = state[t] !== true;
  const s = o.style;
  switch (t) {
    case 'bold': {
      const box = isBold(s.fontWeight);
      return { fontWeight: on ? (box ? undefined : 700) : box ? 400 : undefined };
    }
    case 'italic': {
      const box = s.fontStyle === 'italic';
      return { fontStyle: on ? (box ? undefined : 'italic') : box ? 'normal' : undefined };
    }
    case 'underline': {
      const box = s.underline === true;
      return { underline: on ? (box ? undefined : true) : box ? false : undefined };
    }
    case 'strike':
      return { strike: on ? true : undefined };
    case 'superscript':
      return { baseline: on ? SUPERSCRIPT : undefined };
    case 'subscript':
      return { baseline: on ? SUBSCRIPT : undefined };
  }
}

/** The patches of the other controls: a value equal to the box's removes the override. */
export const valuePatch = {
  font: (o: TextObject, family: string): RunPatch => ({
    fontFamily: family === o.style.fontFamily ? undefined : family,
  }),
  color: (o: TextObject, c: Rgba | undefined): RunPatch => ({
    color: !c || sameColor(c, o.style.color) ? undefined : c,
  }),
  highlight: (c: Rgba | undefined): RunPatch => ({ highlight: c }),
  caps: (o: TextObject, caps: 'none' | 'all' | 'small'): RunPatch => ({
    caps: caps === boxCaps(o.style) ? undefined : caps,
  }),
  letterSpacing: (o: TextObject, px: number): RunPatch => ({
    letterSpacing: px === o.style.letterSpacing ? undefined : px,
  }),
  /** An outline on (the box's, else 3 px black) or off (`null` over an outlined box). */
  outline: (o: TextObject, on: boolean): RunPatch => ({
    outline: on
      ? o.style.outline
        ? undefined
        : { width: 3, color: { r: 0, g: 0, b: 0, a: 1 } }
      : o.style.outline
        ? null
        : undefined,
  }),
  /** A shadow on (the box's, else the editor's default) or off (`null` over a box with one). */
  shadow: (o: TextObject, on: boolean): RunPatch => ({
    shadow: on
      ? o.style.shadow
        ? undefined
        : { dx: 0, dy: 4, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.6 } }
      : o.style.shadow
        ? null
        : undefined,
  }),
  lang: (o: TextObject, tag: string): RunPatch => ({
    lang: !tag || tag === (o.style.lang ?? '') ? undefined : tag,
  }),
};

/** A BCP 47 language tag as the schema bounds it (letters, digits and hyphens, at most 35). */
export function validLang(tag: string): boolean {
  return tag.length <= 35 && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(tag);
}

/** The shortcut of a key press in the text field: Ctrl (⌘) + B, I or U. */
export function shortcutOf(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): FormatToggle | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return undefined;
  return ({ b: 'bold', i: 'italic', u: 'underline' } as const)[e.key.toLowerCase() as 'b' | 'i' | 'u'];
}

/** The format bar, bound to the editor: the selection's style, the deck's colours, the actions. */
export function FormatBar({ o, range, readOnly }: { o: TextObject; range: TextRange; readOnly: boolean }) {
  const draft = useEditor((s) => s.draft);
  const themes = useLibrary((s) => s.data.themes);
  const theme = draft?.themeId ? themes.find((t) => t.id === draft.themeId) : undefined;
  const swatches = useMemo(() => deckColors(draft, theme), [draft, theme]);
  const sel = selectionStyle(o, range.start, range.end);
  const off = readOnly || !!o.locked;
  // Ctrl+B / Ctrl+I / Ctrl+U in the text field format its selection (they never reach the browser).
  const latest = useRef({ o, off });
  latest.current = { o, off };
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attached per object (the field is the panel's)
  useEffect(() => {
    const el = textField();
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
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
  return (
    <FormatBarView
      o={o}
      range={range}
      readOnly={off}
      sel={sel}
      swatches={swatches}
      onFormat={(patch, refocus) => {
        formatSelection(o.id, range.start, range.end, patch);
        if (refocus) refocusText(range.start, range.end);
      }}
      onResize={(factor) => {
        resizeSelection(o.id, range.start, range.end, factor);
        refocusText(range.start, range.end);
      }}
    />
  );
}

/** The format bar's markup for a selection (props only: rendered to markup by the tests). */
export function FormatBarView(props: {
  o: TextObject;
  range: TextRange;
  readOnly: boolean;
  sel: SelectionStyle;
  swatches: readonly Swatch[];
  /** Apply `patch` to the selection; `refocus`: a button did it, so the text field gets its focus back. */
  onFormat: (patch: RunPatch, refocus: boolean) => void;
  onResize: (factor: number) => void;
  /** 'More' open at first (tests). */
  moreOpen?: boolean;
}) {
  const { o } = props;
  const [more, setMore] = useState(!!props.moreOpen);
  const moreId = useId();
  const caret = props.range.start === props.range.end;
  const off = props.readOnly || caret;
  const st = barState(o, props.sel);
  const press = (patch: RunPatch) => props.onFormat(patch, true);
  const toggle = (t: FormatToggle) => press(togglePatch(t, o, st));
  return (
    <div className="col" role="toolbar" aria-label="Text format" style={{ gap: 6 }}>
      <fieldset
        disabled={off}
        className="col"
        style={{ gap: 6, border: 0, margin: 0, padding: 0, minWidth: 0 }}
      >
        <div className="row wrap" style={{ gap: 4 }}>
          <label className="row small" style={{ gap: 4 }}>
            <span>Font{st.font === undefined ? ' (mixed)' : ''}</span>
            <FontPicker
              value={st.font ?? o.style.fontFamily}
              onChange={(f) => props.onFormat(valuePatch.font(o, f), false)}
            />
          </label>
          <BarButton label="Size − (smaller text)" onPress={() => props.onResize(1 / SIZE_STEP)}>
            Size −
          </BarButton>
          <span className="small" aria-live="polite">
            {st.sizePx === undefined ? 'Mixed' : `${Math.round(st.sizePx)} px`}
          </span>
          <BarButton label="Size + (larger text)" onPress={() => props.onResize(SIZE_STEP)}>
            Size +
          </BarButton>
        </div>
        <div className="row wrap" style={{ gap: 4 }}>
          <Toggle label="Bold" pressed={st.bold} onPress={() => toggle('bold')}>
            <b>B</b>
          </Toggle>
          <Toggle label="Italic" pressed={st.italic} onPress={() => toggle('italic')}>
            <i>I</i>
          </Toggle>
          <Toggle label="Underline" pressed={st.underline} onPress={() => toggle('underline')}>
            <u>U</u>
          </Toggle>
          <Toggle label="Strikethrough" pressed={st.strike} onPress={() => toggle('strike')}>
            <s>S</s>
          </Toggle>
          <Toggle label="Superscript" pressed={st.superscript} onPress={() => toggle('superscript')}>
            x²
          </Toggle>
          <Toggle label="Subscript" pressed={st.subscript} onPress={() => toggle('subscript')}>
            x₂
          </Toggle>
          <label className="row small" style={{ gap: 4 }}>
            <span>Caps</span>
            <select
              value={st.caps}
              onChange={(e) => props.onFormat(valuePatch.caps(o, e.target.value as 'none'), false)}
            >
              {st.caps === 'mixed' && (
                <option value="mixed" disabled>
                  Mixed
                </option>
              )}
              <option value="none">None</option>
              <option value="all">ALL CAPS</option>
              <option value="small">Small caps</option>
            </select>
          </label>
          <BarButton onPress={() => press(CLEAR_FORMATTING)}>Clear formatting</BarButton>
        </div>
        <Swatches
          label="Text colour"
          swatches={props.swatches}
          value={st.color}
          onPick={(c) => press(valuePatch.color(o, c))}
          automatic={{ name: 'Auto (the box colour)', on: !!st.color && sameColor(st.color, o.style.color) }}
          custom={{
            name: 'Other text colour',
            value: st.color ?? o.style.color,
            onPick: (c) => props.onFormat(valuePatch.color(o, c), false),
          }}
        />
        <Swatches
          label="Highlight"
          swatches={HIGHLIGHTS}
          value={typeof st.highlight === 'object' ? st.highlight : undefined}
          onPick={(c) => press(valuePatch.highlight(c))}
          automatic={{ name: 'None (no highlight)', on: st.highlight === 'none' }}
        />
        <div className="row">
          <button
            type="button"
            className={`small${more ? ' on' : ''}`}
            aria-expanded={more}
            aria-controls={moreId}
            onClick={() => setMore(!more)}
          >
            More
          </button>
        </div>
        {more && (
          <div id={moreId} className="col" role="group" aria-label="More text formatting" style={{ gap: 6 }}>
            <div className="row wrap" style={{ gap: 4, alignItems: 'flex-end' }}>
              <MixedNumber
                label="Letter spacing"
                value={st.letterSpacing}
                step={0.5}
                min={-1000}
                max={1000}
                suffix="px"
                commit="blur"
                onChange={(v) => props.onFormat(valuePatch.letterSpacing(o, v), false)}
              />
              <Toggle
                label="Outline"
                pressed={st.outline}
                onPress={() => press(valuePatch.outline(o, st.outline !== true))}
              >
                Outline
              </Toggle>
              <Toggle
                label="Shadow"
                pressed={st.shadow}
                onPress={() => press(valuePatch.shadow(o, st.shadow !== true))}
              >
                Shadow
              </Toggle>
            </div>
            <LangField value={st.lang} onChange={(tag) => props.onFormat(valuePatch.lang(o, tag), false)} />
          </div>
        )}
      </fieldset>
      {caret && !props.readOnly && <span className="muted small">Select text to format it.</span>}
    </div>
  );
}

/**
 * A row of colour swatches labelled `label`: the 'automatic' choice first (the box's colour, or none), each
 * swatch a button named by its colour (`aria-pressed` on the selection's), and an 'other colour' picker
 * applied when its dialog closes (one undo step, not one per drag in the picker).
 */
function Swatches(props: {
  label: string;
  swatches: readonly Swatch[];
  value: Rgba | undefined;
  onPick: (c: Rgba | undefined) => void;
  automatic: { name: string; on: boolean };
  custom?: { name: string; value: Rgba; onPick: (c: Rgba) => void };
}) {
  // A swatch is a 44 px target under a finger (design/15), 28 px under a mouse.
  const side = useCoarsePointer() ? 44 : 28;
  const customBtnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="row wrap" role="group" aria-label={props.label} style={{ gap: 4 }}>
      <span className="small" style={{ minWidth: 70 }}>
        {props.label}
      </span>
      <Toggle
        label={props.automatic.name}
        pressed={props.automatic.on}
        onPress={() => props.onPick(undefined)}
      >
        {props.automatic.name.split(' ')[0]}
      </Toggle>
      {props.swatches.map((s) => (
        <button
          key={colorKey(s.color)}
          type="button"
          className={`small${sameColor(props.value, s.color) ? ' on' : ''}`}
          aria-label={s.name}
          aria-pressed={sameColor(props.value, s.color)}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onPick(s.color)}
          style={{ minWidth: side, padding: 0 }}
        >
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 18,
              height: 18,
              borderRadius: 4,
              background: rgbaCss(s.color),
              border: '1px solid var(--line)',
            }}
          />
        </button>
      ))}
      {props.custom && (
        <>
          <button
            ref={customBtnRef}
            type="button"
            className={`small${open ? ' on' : ''}`}
            aria-label={props.custom.name}
            aria-expanded={open}
            title={props.custom.name}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((o) => !o)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '0 8px',
              minHeight: side,
            }}
          >
            <span
              aria-hidden="true"
              className="color-checkerboard"
              style={{
                display: 'inline-block',
                width: 14,
                height: 14,
                borderRadius: 4,
                border: '1px solid var(--line)',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: rgbaCss(props.custom.value),
                }}
              />
            </span>
            <span>Custom</span>
          </button>
          {open && (
            <ColorPopover
              anchor={customBtnRef.current}
              value={props.custom.value}
              alpha={false}
              swatches={props.swatches}
              preserveFocus
              onChange={(c) => props.custom?.onPick(c)}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      )}
    </div>
  );
}

/** The language of the selection (BCP 47: he, ar, en-GB), applied on Enter or when the field is left. */
function LangField(props: { value: string | undefined; onChange: (tag: string) => void }) {
  const shown = props.value ?? '';
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const apply = () => {
    const t = text.trim();
    if (t === shown) return;
    if (!t || validLang(t)) props.onChange(t);
    else setText(shown);
  };
  return (
    <label className="field">
      <span>Language (for example he, ar, en-GB)</span>
      <input
        value={text}
        maxLength={35}
        placeholder={props.value === undefined ? 'Mixed' : 'As the box'}
        style={{ width: 140 }}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') apply();
        }}
      />
    </label>
  );
}
