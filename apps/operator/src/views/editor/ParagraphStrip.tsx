import { autoNumberLabel, type TextObject, type TextPara } from '@ordo/domain';
import { setParagraphs } from './actions.ts';
import { BarButton, MixedNumber, Radios } from './formatControls.tsx';
import {
  type ParaPatch,
  parasTouched,
  type SelectionParas,
  selectionParas,
  type TextRange,
} from './ops/text.ts';

/*
 * The paragraph strip under the text field (design/27 §11 item 3; M4 item C), for the paragraphs the
 * selection `range` touches (`parasTouched`, whole PowerPoint paragraphs; a caret touches its own):
 * - align left, centre, right, justify;
 * - bullets on/off with the character (•, ●, ■, ▪, ➢, ✓, Unicode only), numbering `1.` / `(1)` / `1)` /
 *   `a.` / `i.` with 'Start at' (verses starting at 17); a list started on paragraphs without an indent
 *   gets a hanging indent wide enough for its bullet or its longest number (`hangFor`), so the text does
 *   not touch the bullet;
 * - level and indent − / +, each paragraph moved from its own value (a selection of several levels keeps
 *   their differences; `paraSteps`), space before and after, line spacing (× single, or exact);
 * - direction Auto / Left to right / Right to left (`rtl`), for a Hebrew or Arabic line;
 * - each applies `setParagraphs` (actions.ts), one undo step (a number field's typing and arrows, and
 *   repeated −/+, coalesce per field); values from `selectionParas` (ops/text.ts), mixed values shown as
 *   such (no radio checked, 'Mixed').
 * A value equal to the box's default removes the paragraph's own (align as the box's, space 0, level 0).
 *
 * Accessibility (design/15): a `role="group"` labelled 'Paragraph', radio groups with `aria-checked` for
 * the alignment and direction (one tab stop, arrow keys), every field with its visible label, keyboard
 * reachable, 44 px under a coarse pointer (the design system's `button.small` and fields).
 */

/** The bullet characters offered (design/27 §11 item 3: Unicode only, as the import maps symbol fonts). */
export const BULLET_CHARS = ['•', '●', '■', '▪', '➢', '✓'] as const;

/** The numbering schemes offered (OOXML `ST_TextAutonumberScheme`), with how they read. */
export const NUMBERINGS: readonly { auto: string; label: string }[] = [
  { auto: 'arabicPeriod', label: '1. 2. 3.' },
  { auto: 'arabicParenBoth', label: '(1) (2) (3)' },
  { auto: 'arabicParenR', label: '1) 2) 3)' },
  { auto: 'alphaLcPeriod', label: 'a. b. c.' },
  { auto: 'romanLcPeriod', label: 'i. ii. iii.' },
];

/** Indent − / + move a paragraph by this (half an inch at 144 logical px per inch). */
export const INDENT_STEP = 72;
/** The widest indent − / + gives. */
export const MAX_INDENT = 1920;
/** The deepest list level (TextPara.level 0-8, shown 1-9). */
export const MAX_LEVEL = 8;
/** The largest space before or after a paragraph the strip sets, px. */
export const MAX_SPACE = 2000;

/** What the List control shows: none, a bullet character, or a numbering scheme. */
export type ListChoice = 'none' | `char:${string}` | `auto:${string}`;

/** The List choice of a paragraph's bullet (a bullet with neither a character nor a scheme reads as '•'). */
export function listChoice(b: TextPara['bullet'] | undefined): ListChoice {
  if (!b) return 'none';
  if (b.auto) return `auto:${b.auto}`;
  return `char:${b.char ?? '•'}`;
}

/** The PowerPoint paragraphs (their first lines) among the lines a selection touches. */
export function touchedHeads(o: Pick<TextObject, 'text' | 'paras'>, range: TextRange): number[] {
  const { first, last } = parasTouched(o, range.start, range.end);
  const heads: number[] = [];
  for (let i = first; i <= last; i++) if (!(i > 0 && o.paras?.[i]?.soft === true)) heads.push(i);
  return heads;
}

/** Offset of the first character of line `i` of `text` (`text.split('\n')[i]`). */
export function lineStart(text: string, i: number): number {
  let at = 0;
  for (let n = 0; n < i; n++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  return at;
}

/**
 * The hanging indent a list gets on paragraphs that have none (logical px): a bullet's at least 54 px
 * (PowerPoint's 0.375 inch) or three quarters of the text size; a number's as wide as its longest label
 * (the `count`-th from its start) and a space, at least 72 px (PowerPoint's half inch).
 */
export function hangFor(o: TextObject, bullet: NonNullable<TextPara['bullet']>, count: number): number {
  const size = o.style.fontSizePx;
  if (!bullet.auto) return Math.max(54, Math.round(size * 0.75));
  const label = autoNumberLabel(bullet.auto, (bullet.startAt ?? 1) + Math.max(1, count) - 1);
  return Math.max(72, Math.round(size * 0.6 * (label.length + 1)));
}

/** Whether the paragraphs of `sel` have no indent of their own (none set, none mixed). */
function unindented(sel: SelectionParas): boolean {
  return (
    !sel.mixed.includes('indentPx') &&
    !sel.mixed.includes('firstLinePx') &&
    !sel.para.indentPx &&
    !sel.para.firstLinePx
  );
}

/** The bullet's own look (colour, size) kept when its kind changes; its font is the symbol's, dropped. */
function bulletLook(b: TextPara['bullet'] | undefined): NonNullable<TextPara['bullet']> {
  const out: NonNullable<TextPara['bullet']> = {};
  if (b?.color) out.color = b.color;
  if (b?.sizePct !== undefined) out.sizePct = b.sizePct;
  return out;
}

/**
 * The patch of a List choice for the paragraphs of `range`: no bullet, a character bullet, or numbering
 * (keeping 'Start at' when it was numbered already). A list started where the paragraphs have no indent
 * gets a hanging one (`hangFor`).
 */
export function listPatch(
  o: TextObject,
  range: TextRange,
  sel: SelectionParas,
  choice: ListChoice,
): ParaPatch {
  if (choice === 'none') return { bullet: undefined };
  const cur = sel.mixed.includes('bullet') ? undefined : sel.para.bullet;
  const bullet = bulletLook(cur);
  if (choice.startsWith('auto:')) {
    bullet.auto = choice.slice(5);
    if (cur?.auto && cur.startAt !== undefined) bullet.startAt = cur.startAt;
  } else bullet.char = choice.slice(5);
  const patch: ParaPatch = { bullet };
  if (!cur && unindented(sel)) {
    const hang = hangFor(o, bullet, touchedHeads(o, range).length);
    patch.indentPx = hang;
    patch.firstLinePx = -hang;
  }
  return patch;
}

/** 'Start at' for numbered paragraphs (1 is the default, so it is not stored). */
export function startAtPatch(sel: SelectionParas, startAt: number): ParaPatch {
  const { startAt: _, ...rest } = sel.para.bullet ?? {};
  const n = Math.max(1, Math.min(32_767, Math.round(startAt)));
  return { bullet: n === 1 ? rest : { ...rest, startAt: n } };
}

/** One `setParagraphs` call: a caret at the start of a paragraph and its patch. */
export type ParaCall = { at: number; patch: ParaPatch };

/**
 * Level or indent − / + over the paragraphs `range` touches: each paragraph moves from its own value by
 * `delta`, within 0..MAX_LEVEL or 0..MAX_INDENT, so a selection of several levels keeps their differences.
 * One call per paragraph whose value changes (the caller applies them under one coalescing key).
 */
export function paraSteps(
  o: TextObject,
  range: TextRange,
  f: 'level' | 'indentPx',
  delta: number,
): ParaCall[] {
  const max = f === 'level' ? MAX_LEVEL : MAX_INDENT;
  const calls: ParaCall[] = [];
  for (const i of touchedHeads(o, range)) {
    const cur = o.paras?.[i]?.[f] ?? 0;
    const next = Math.max(0, Math.min(max, cur + delta));
    if (next === cur) continue;
    const v = next === 0 ? undefined : next;
    calls.push({ at: lineStart(o.text, i), patch: f === 'level' ? { level: v } : { indentPx: v } });
  }
  return calls;
}

/** How the paragraphs are spaced: as the box's line height, a multiple of single, exactly, or mixed. */
export type LineMode = 'box' | 'multiple' | 'exact' | 'mixed';

export function lineMode(sel: SelectionParas): LineMode {
  if (sel.mixed.includes('lineSpacing') || sel.mixed.includes('lineSpacingPx')) return 'mixed';
  if (sel.para.lineSpacingPx !== undefined) return 'exact';
  if (sel.para.lineSpacing !== undefined) return 'multiple';
  return 'box';
}

/** The patch of a line spacing mode: single (× 1) or the box's size × 1.2 exactly to start from. */
export function lineModePatch(o: TextObject, mode: Exclude<LineMode, 'mixed'>): ParaPatch {
  if (mode === 'box') return { lineSpacing: undefined, lineSpacingPx: undefined };
  if (mode === 'multiple') return { lineSpacing: 1, lineSpacingPx: undefined };
  return { lineSpacing: undefined, lineSpacingPx: Math.round(o.style.fontSizePx * 1.2) };
}

/** The box's own alignment (the paragraphs' default). */
const boxAlign = (o: TextObject): NonNullable<TextPara['align']> =>
  o.style.justify ? 'justify' : o.style.align;

type Align = 'left' | 'center' | 'right' | 'justify';
const ALIGNS: readonly { value: Align; label: string }[] = [
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Centre' },
  { value: 'right', label: 'Right' },
  { value: 'justify', label: 'Justify' },
];
type Dir = 'auto' | 'ltr' | 'rtl';
const DIRS: readonly { value: Dir; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'ltr', label: 'Left to right' },
  { value: 'rtl', label: 'Right to left' },
];

/** The strip's alignment for `sel` (undefined: mixed). */
export function alignOf(o: TextObject, sel: SelectionParas): TextPara['align'] {
  return sel.mixed.includes('align') ? undefined : (sel.para.align ?? boxAlign(o));
}
/** The strip's direction for `sel` (undefined: mixed). */
export function dirOf(sel: SelectionParas): Dir | undefined {
  if (sel.mixed.includes('rtl')) return undefined;
  return sel.para.rtl === true ? 'rtl' : sel.para.rtl === false ? 'ltr' : 'auto';
}
export const alignPatch = (o: TextObject, a: Align): ParaPatch => ({
  align: a === boxAlign(o) ? undefined : a,
});
export const dirPatch = (d: Dir): ParaPatch => ({ rtl: d === 'auto' ? undefined : d === 'rtl' });

/** The paragraph strip, bound to the editor: the paragraphs' styles and the actions. */
export function ParagraphStrip({
  o,
  range,
  readOnly,
}: {
  o: TextObject;
  range: TextRange;
  readOnly: boolean;
}) {
  const sel = selectionParas(o, range.start, range.end);
  return (
    <ParagraphStripView
      o={o}
      range={range}
      readOnly={readOnly || !!o.locked}
      sel={sel}
      onParas={(patch, key) => setParagraphs(o.id, range.start, range.end, patch, key)}
      onStep={(f, delta) => {
        for (const c of paraSteps(o, range, f, delta)) setParagraphs(o.id, c.at, c.at, c.patch, f);
      }}
    />
  );
}

/** The paragraph strip's markup for a selection (props only: rendered to markup by the tests). */
export function ParagraphStripView(props: {
  o: TextObject;
  range: TextRange;
  readOnly: boolean;
  sel: SelectionParas;
  /** Apply `patch` to the paragraphs touched; `key` coalesces a field changed step by step. */
  onParas: (patch: ParaPatch, key?: string) => void;
  /** Level or indent − / +. */
  onStep: (f: 'level' | 'indentPx', delta: number) => void;
}) {
  const { o, sel } = props;
  const mixed = (k: keyof TextPara) => sel.mixed.includes(k);
  const list = mixed('bullet') ? 'mixed' : listChoice(sel.para.bullet);
  const known =
    list === 'none' ||
    list === 'mixed' ||
    BULLET_CHARS.some((c) => list === `char:${c}`) ||
    NUMBERINGS.some((n) => list === `auto:${n.auto}`);
  const numbered = list.startsWith('auto:');
  const mode = lineMode(sel);
  const level = mixed('level') ? undefined : (sel.para.level ?? 0);
  const indent = mixed('indentPx') ? undefined : (sel.para.indentPx ?? 0);
  const num = (k: 'spaceBeforePx' | 'spaceAfterPx' | 'lineSpacing' | 'lineSpacingPx', dflt?: number) =>
    mixed(k) ? undefined : (sel.para[k] ?? dflt);
  return (
    <div className="col" role="group" aria-label="Paragraph" style={{ gap: 6 }}>
      <fieldset
        disabled={props.readOnly}
        className="col"
        style={{ gap: 6, border: 0, margin: 0, padding: 0, minWidth: 0 }}
      >
        <div className="row wrap" style={{ gap: 4 }}>
          <span className="small" style={{ minWidth: 70 }}>
            Align
          </span>
          <Radios
            label="Align"
            value={alignOf(o, sel) as Align | undefined}
            options={ALIGNS}
            disabled={props.readOnly}
            onChange={(a) => props.onParas(alignPatch(o, a), 'align')}
          />
        </div>
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <label className="field">
            <span>List</span>
            <select
              value={list}
              onChange={(e) => props.onParas(listPatch(o, props.range, sel, e.target.value as ListChoice))}
            >
              {list === 'mixed' && (
                <option value="mixed" disabled>
                  Mixed
                </option>
              )}
              <option value="none">No bullets</option>
              {BULLET_CHARS.map((c) => (
                <option key={c} value={`char:${c}`}>
                  Bullet {c}
                </option>
              ))}
              {NUMBERINGS.map((n) => (
                <option key={n.auto} value={`auto:${n.auto}`}>
                  Numbers {n.label}
                </option>
              ))}
              {!known && (
                <option value={list}>
                  {numbered ? 'Numbers (from PowerPoint)' : `Bullet ${list.slice(5)}`}
                </option>
              )}
            </select>
          </label>
          {numbered && (
            <MixedNumber
              label="Start at"
              value={sel.para.bullet?.startAt ?? 1}
              min={1}
              max={32_767}
              onChange={(v) => props.onParas(startAtPatch(sel, v), 'startAt')}
            />
          )}
        </div>
        <div className="row wrap" style={{ gap: 4 }}>
          <BarButton onPress={() => props.onStep('level', -1)} disabled={level === 0}>
            Level −
          </BarButton>
          <span className="small" aria-live="polite">
            {level === undefined ? 'Levels mixed' : `Level ${level + 1}`}
          </span>
          <BarButton onPress={() => props.onStep('level', 1)} disabled={level === MAX_LEVEL}>
            Level +
          </BarButton>
          <BarButton onPress={() => props.onStep('indentPx', -INDENT_STEP)} disabled={indent === 0}>
            Indent −
          </BarButton>
          <span className="small" aria-live="polite">
            {indent === undefined ? 'Indents mixed' : `Indent ${Math.round(indent)} px`}
          </span>
          <BarButton onPress={() => props.onStep('indentPx', INDENT_STEP)}>Indent +</BarButton>
        </div>
        <div className="grid3">
          <MixedNumber
            label="Space before"
            value={num('spaceBeforePx', 0)}
            min={0}
            max={MAX_SPACE}
            suffix="px"
            width={64}
            onChange={(v) => props.onParas({ spaceBeforePx: v === 0 ? undefined : v }, 'spaceBeforePx')}
          />
          <MixedNumber
            label="Space after"
            value={num('spaceAfterPx', 0)}
            min={0}
            max={MAX_SPACE}
            suffix="px"
            width={64}
            onChange={(v) => props.onParas({ spaceAfterPx: v === 0 ? undefined : v }, 'spaceAfterPx')}
          />
          <label className="field">
            <span>Line spacing</span>
            <select
              value={mode}
              onChange={(e) => props.onParas(lineModePatch(o, e.target.value as Exclude<LineMode, 'mixed'>))}
            >
              {mode === 'mixed' && (
                <option value="mixed" disabled>
                  Mixed
                </option>
              )}
              <option value="box">As the box</option>
              <option value="multiple">Multiple</option>
              <option value="exact">Exactly</option>
            </select>
          </label>
        </div>
        {mode === 'multiple' && (
          <MixedNumber
            label="Line spacing (× single)"
            value={num('lineSpacing')}
            min={0}
            max={13.2}
            step={0.1}
            onChange={(v) => props.onParas({ lineSpacing: v }, 'lineSpacing')}
          />
        )}
        {mode === 'exact' && (
          <MixedNumber
            label="Line spacing (exactly)"
            value={num('lineSpacingPx')}
            min={0}
            max={MAX_SPACE}
            suffix="px"
            onChange={(v) => props.onParas({ lineSpacingPx: v }, 'lineSpacingPx')}
          />
        )}
        <div className="row wrap" style={{ gap: 4 }}>
          <span className="small" style={{ minWidth: 70 }}>
            Direction
          </span>
          <Radios
            label="Direction"
            value={dirOf(sel)}
            options={DIRS}
            disabled={props.readOnly}
            onChange={(d) => props.onParas(dirPatch(d), 'rtl')}
          />
        </div>
      </fieldset>
    </div>
  );
}
