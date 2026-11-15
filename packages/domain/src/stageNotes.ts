import type { Box, Look, PropBox, StageNotesScale, StagePreset, TextStyle } from './schemas.ts';

/**
 * Whether a look displays speaker/preacher notes (`Slide.notes`):
 * Stage looks (`kind === 'stage'`) default ON (`notes !== false`) so stored and freshly created stage
 * monitors show speaker notes without manual hunting; non-stage looks default OFF (`notes === true`).
 */
export function stageNotesEnabled(look: Pick<Look, 'kind' | 'layers'>): boolean {
  return look.kind === 'stage' ? look.layers.props.notes !== false : look.layers.props.notes === true;
}

const SCALE_PX: Record<'worship' | 'split' | 'prompter', Record<StageNotesScale, number>> = {
  worship: { sm: 34, md: 38, lg: 42, xl: 48 },
  split: { sm: 42, md: 50, lg: 58, xl: 68 },
  prompter: { sm: 48, md: 56, lg: 64, xl: 76 },
};

/** Font size in 1920x1080 logical px for a stage preset mode and scale tier (`'lg'` default). */
export function stageNotesPx(mode: 'worship' | 'split' | 'prompter', scale?: StageNotesScale): number {
  return SCALE_PX[mode][scale ?? 'lg'];
}

/** Resolve `'auto'` (or absent) stage preset based on whether the active deck is a song and has notes. */
export function resolveStagePreset(
  preset: StagePreset | undefined,
  isSong: boolean,
  hasNotes: boolean,
): 'worship' | 'split' | 'prompter' {
  if (preset === 'worship' || preset === 'split' || preset === 'prompter') return preset;
  return !isSong && hasNotes ? 'split' : 'worship';
}

export type StageRegionPair = { box: Box; style: TextStyle };

/**
 * Compute adaptive `{ current, next, notes }` regions for `1920x1080` stage screens and stage previews
 * when no manual `props.style.notes` box override is set.
 * - `'worship'`: Large lyrics + next slide + high-contrast amber Band / Chord Cue banner at bottom when notes exist.
 * - `'split'`: 35% Left column (Current + Next cards) + 63% Right column (`58px` default Preacher Notes).
 * - `'prompter'`: Compact top slide context strip + full-width (`64px` default) Preacher Teleprompter manuscript.
 */
export function adaptStageRegions(opts: {
  preset: StagePreset | undefined;
  notesScale?: StageNotesScale;
  isSong: boolean;
  hasNotes: boolean;
  notesEnabled: boolean;
  hasCustomNotesStyle: boolean;
  current: StageRegionPair | null;
  next: StageRegionPair | null;
  notes: PropBox | null;
  messagesBox?: Box | null;
  hasActiveMessages?: boolean;
}): { current: StageRegionPair | null; next: StageRegionPair | null; notes: PropBox | null } {
  const {
    preset,
    notesScale,
    isSong,
    hasNotes,
    notesEnabled,
    hasCustomNotesStyle,
    current,
    next,
    notes,
    messagesBox,
    hasActiveMessages,
  } = opts;
  if (!notesEnabled || hasCustomNotesStyle) {
    return { current, next, notes };
  }
  const mode = resolveStagePreset(preset, isSong, hasNotes);
  const family = current?.style.fontFamily ?? notes?.fontFamily ?? 'Inter';
  const contentBottom = hasActiveMessages && messagesBox ? Math.max(540, messagesBox.y - 16) : 1060;

  if (mode === 'worship') {
    if (!hasNotes) return { current, next, notes };
    const px = stageNotesPx('worship', notesScale);
    const notesH = Math.min(200, Math.max(120, Math.ceil(px * 2.7 + 36)));
    const notesY = Math.max(660, contentBottom - notesH);
    const curY = current?.box.y ?? 140;
    const availAbove = Math.max(260, notesY - 16 - curY);
    const curH = next ? Math.round(availAbove * 0.64) : availAbove;
    const nextY = curY + curH + 16;
    const nextH = Math.max(100, notesY - 16 - nextY);
    return {
      current: current
        ? {
            style: current.style,
            box: { ...current.box, y: curY, h: curH },
          }
        : null,
      next: next
        ? {
            style: next.style,
            box: { ...next.box, y: nextY, h: nextH },
          }
        : null,
      notes: {
        fontFamily: family,
        fontWeight: 600,
        fontStyle: 'normal',
        fontSizePx: px,
        color: { r: 253, g: 230, b: 138, a: 1 },
        align: 'left',
        valign: 'middle',
        lineHeight: 1.22,
        letterSpacing: 0,
        padding: 18,
        transform: 'none',
        fill: { color: { r: 245, g: 158, b: 11, a: 0.16 }, radius: 14 },
        box: { x: current?.box.x ?? 60, y: notesY, w: current?.box.w ?? 1800, h: notesH, rotation: 0 },
      },
    };
  }

  if (mode === 'prompter') {
    const px = stageNotesPx('prompter', notesScale);
    const topY = 136;
    const curStripH = current ? 92 : 0;
    const notesY = current ? topY + curStripH + 16 : 140;
    const notesH = Math.max(220, contentBottom - notesY);
    return {
      current: current
        ? {
            style: {
              ...current.style,
              fontSizePx: Math.min(current.style.fontSizePx, 34),
              color: { r: 203, g: 213, b: 225, a: 0.9 },
              valign: 'middle',
              padding: 14,
              fill: { color: { r: 255, g: 255, b: 255, a: 0.05 }, radius: 12 },
            },
            box: { x: 60, y: topY, w: 1800, h: curStripH, rotation: 0 },
          }
        : null,
      next: null,
      notes: {
        fontFamily: family,
        fontWeight: 600,
        fontStyle: 'normal',
        fontSizePx: px,
        color: { r: 248, g: 250, b: 252, a: 1 },
        align: 'left',
        valign: 'top',
        lineHeight: 1.3,
        letterSpacing: 0,
        padding: 28,
        transform: 'none',
        fill: { color: { r: 255, g: 255, b: 255, a: 0.07 }, radius: 18 },
        box: { x: 60, y: notesY, w: 1800, h: notesH, rotation: 0 },
      },
    };
  }

  // mode === 'split' (Preacher Confidence Split: Left 620px Current + Next cards, Right 1156px Large Notes)
  const px = stageNotesPx('split', notesScale);
  const topY = 144;
  const totalH = Math.max(300, contentBottom - topY);
  const leftX = 60;
  const leftW = current ? 620 : 0;
  const rightX = current ? 704 : 60;
  const rightW = current ? 1156 : 1800;
  const curH = current ? (next ? Math.round((totalH - 20) * 0.56) : totalH) : 0;
  const nextY = topY + curH + 20;
  const nextH = next ? Math.max(120, contentBottom - nextY) : 0;

  return {
    current: current
      ? {
          style: {
            ...current.style,
            fontSizePx: Math.min(current.style.fontSizePx, 44),
            valign: 'top',
            padding: 20,
            fill: { color: { r: 255, g: 255, b: 255, a: 0.05 }, radius: 16 },
          },
          box: { x: leftX, y: topY, w: leftW, h: curH, rotation: 0 },
        }
      : null,
    next:
      current && next
        ? {
            style: {
              ...next.style,
              fontSizePx: Math.min(next.style.fontSizePx, 32),
              valign: 'top',
              padding: 18,
              fill: { color: { r: 255, g: 255, b: 255, a: 0.03 }, radius: 16 },
            },
            box: { x: leftX, y: nextY, w: leftW, h: nextH, rotation: 0 },
          }
        : null,
    notes: {
      fontFamily: family,
      fontWeight: 600,
      fontStyle: 'normal',
      fontSizePx: px,
      color: { r: 248, g: 250, b: 252, a: 1 },
      align: 'left',
      valign: 'top',
      lineHeight: 1.3,
      letterSpacing: 0,
      padding: 28,
      transform: 'none',
      fill: { color: { r: 255, g: 255, b: 255, a: 0.07 }, radius: 18 },
      box: { x: rightX, y: topY, w: rightW, h: totalH, rotation: 0 },
    },
  };
}

export type StageNoteToken =
  | { kind: 'text'; text: string }
  | { kind: 'highlight'; text: string }
  | { kind: 'cue'; text: string };

export type ParsedStageNoteLine = {
  /** True when the line has no bullets, `**highlights**`, or `[CUE]` tags (render as plain text node). */
  plain: boolean;
  bullet: boolean;
  tokens: StageNoteToken[];
};

const BULLET_RE = /^(?:[-*•])\s+(.*)$/u;
const INLINE_RE = /\*\*([^*\n]+)\*\*|\[([A-Za-z][^\]\n]{1,120})\]/g;

/**
 * Parse a single paragraph of speaker notes into lightweight stage emphasis tokens:
 * - Leading `- `, `* `, or `• ` -> hanging bullet
 * - `**phrase**` -> warm stage highlight
 * - `[PAUSE]` / `[CUE: Video]` -> backstage/preacher cue pill
 * Lines without any markers return `plain: true` so bidi/RTL text renders as a single untouched Text node.
 */
export function parseStageNoteLine(line: string): ParsedStageNoteLine {
  let body = line;
  let bullet = false;
  const bm = BULLET_RE.exec(line);
  if (bm) {
    bullet = true;
    body = bm[1] ?? '';
  }
  INLINE_RE.lastIndex = 0;
  if (!INLINE_RE.test(body)) {
    return {
      plain: !bullet,
      bullet,
      tokens: body ? [{ kind: 'text', text: body }] : [],
    };
  }
  INLINE_RE.lastIndex = 0;
  const tokens: StageNoteToken[] = [];
  let last = 0;
  for (;;) {
    const m = INLINE_RE.exec(body);
    if (!m) break;
    if (m.index > last) tokens.push({ kind: 'text', text: body.slice(last, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: 'highlight', text: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: 'cue', text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < body.length) tokens.push({ kind: 'text', text: body.slice(last) });
  return { plain: false, bullet, tokens };
}

/** Plain-text projection of stage notes for 2D canvas preview thumbnails (`**bold**` -> `bold`, `- x` -> `• x`). */
export function formatStageNotesPlain(notes: string): string {
  return notes
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(BULLET_RE, '• $1').replace(/\*\*([^*\n]+)\*\*/g, '$1'))
    .join('\n')
    .trim();
}
