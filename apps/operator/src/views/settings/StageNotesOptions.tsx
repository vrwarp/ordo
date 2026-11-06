import {
  type Box,
  LOOK_STAGE,
  type Look,
  type PropBox,
  type PropsRule,
  type Rgba,
  type TextStyle,
} from '@ordo/domain';
import { BoxEditor, Check } from '../../components/fields.tsx';
import { TextStyleEditor } from '../../components/TextStyleEditor.tsx';

/*
 * The stage look's notes region in the look editor (design/27 §11 item 13; design/16): 'Notes' shows the
 * live slide's notes (`Slide.notes`) on the stage screen for the preacher, in `props.style['notes']`, or,
 * while the look gives none, in the stage's default box under the next-slide band. The defaults below are
 * the stage's (`apps/stage/src/model.ts` `defaultNotes`, `notesRegion`); `apps/operator/test/stageNotes.test.ts`
 * checks that they agree.
 */

const STAGE_H = 1080;
const NOTES_GAP = 12;
const NOTES_MARGIN = 16;

/** The notes' text when the look styles none (the stage's `defaultNotesStyle`). */
export function notesDefaultStyle(fontFamily: string): TextStyle {
  const light: Rgba = { r: 235, g: 235, b: 235, a: 1 };
  return {
    fontFamily,
    fontWeight: 400,
    fontStyle: 'normal',
    fontSizePx: 32,
    color: light,
    align: 'left',
    valign: 'top',
    lineHeight: 1.2,
    letterSpacing: 0,
    padding: 8,
    transform: 'none',
    fill: { color: { r: 255, g: 255, b: 255, a: 0.1 }, radius: 10 },
  };
}

/** The bands the stage draws lyrics in for a look: its own (lyric-only), else the stage look's. */
export function lyricBands(look: Look): { current?: Box; next?: Box; fontFamily: string } {
  const own = look.layers.slide;
  const rule = own.mode === 'lyricOnly' ? own : own.mode === 'authored' ? LOOK_STAGE.layers.slide : undefined;
  if (rule?.mode !== 'lyricOnly') return { fontFamily: 'Inter' };
  return { current: rule.band, next: rule.nextSlide?.band, fontFamily: rule.style.fontFamily };
}

/** Where the stage puts the notes while the look gives no box: under the lower lyric band, two lines high at least. */
export function notesDefault(look: Look): PropBox {
  const { current, next, fontFamily } = lyricBands(look);
  const style = notesDefaultStyle(fontFamily);
  const above =
    current && next ? (next.y + next.h >= current.y + current.h ? next : current) : (next ?? current);
  const top = above ? above.y + above.h + NOTES_GAP : 140;
  const bottom = STAGE_H - NOTES_MARGIN;
  const twoLines = Math.ceil(2 * style.fontSizePx * style.lineHeight + 2 * style.padding);
  const y = Math.max(0, Math.min(top, bottom - twoLines));
  return { ...style, box: { x: above?.x ?? 60, y, w: above?.w ?? 1800, h: bottom - y, rotation: 0 } };
}

/** The notes box and text a look's stage uses: its own `style['notes']`, else the default. */
export function notesOf(look: Look): PropBox {
  return look.layers.props.style.notes ?? notesDefault(look);
}

/** Whether the notes box would cover the current lyrics (the stage then shows only the part beside them). */
export function notesOverLyrics(look: Look): boolean {
  const cur = lyricBands(look).current;
  const b = notesOf(look).box;
  return !!cur && b.x < cur.x + cur.w && cur.x < b.x + b.w && b.y < cur.y + cur.h && cur.y < b.y + b.h;
}

/**
 * The 'Stage screen' card of the look editor: the 'Notes' toggle and, while it is on, the notes box and
 * text style (editing either stores them in `style['notes']`; 'Use the default box and text' removes them,
 * so the box follows the lyric bands again). Props only: the page applies `onChange` to its draft.
 */
export function StageNotesOptions(props: { look: Look; onChange: (props: PropsRule) => void }) {
  const pr = props.look.layers.props;
  const on = pr.notes === true;
  const styled = pr.style.notes;
  const n = notesOf(props.look);
  const setNotes = (notes: PropBox | undefined) => {
    const { notes: _old, ...rest } = pr.style;
    props.onChange({ ...pr, style: notes ? { ...rest, notes } : rest });
  };
  return (
    <div className="card col" data-stage-notes>
      <h4>Stage screen</h4>
      <Check
        label="Notes: show the live slide’s notes, for the preacher"
        value={on}
        onChange={(notes) => props.onChange({ ...pr, notes })}
      />
      {on && (
        <>
          <span className="muted small">
            Long notes are cut to their box. They never cover the current lyrics.
          </span>
          <fieldset className="col" style={{ gap: 6, border: 0, margin: 0, padding: 0 }}>
            <legend className="small" style={{ padding: 0, marginBottom: 4, color: 'var(--fg2)' }}>
              {styled ? 'Notes box' : 'Notes box (default: under the next slide)'}
            </legend>
            <BoxEditor value={n.box} rotation={false} onChange={(box) => setNotes({ ...n, box })} />
          </fieldset>
          {notesOverLyrics(props.look) && (
            <div className="banner" role="status">
              The notes box overlaps the current lyrics: the stage shows only the part of it beside them.
            </div>
          )}
          <h4>Notes text</h4>
          <TextStyleEditor value={n} onChange={(style) => setNotes({ ...style, box: n.box })} />
          {styled && (
            <button type="button" className="small" onClick={() => setNotes(undefined)}>
              Use the default box and text
            </button>
          )}
        </>
      )}
    </div>
  );
}
