import { type Presentation, slideContent } from '@ordo/domain';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { findAndReplace } from './actions.ts';
import { selectObject, selectSlide, useEditor } from './editorStore.ts';
import { type FindOptions, findText, type TextMatch } from './ops/slides.ts';

/*
 * 'Find…' (design/27 §11 item 8; M4 item E): find text across the presentation's text boxes, see every
 * match by slide before replacing, then replace them all in one undo step, each keeping the formatting of
 * the text it replaces (`findReplace`). Opened from the editor toolbar and with Ctrl+F outside a text field.
 */

/** The matches the dialog lists at most (the count above the list stays exact up to `COUNT_LIMIT`). */
export const LIST_LIMIT = 200;
/** Matches counted at most: a pathological deck must not build millions of rows. */
export const COUNT_LIMIT = 10_000;
/** Characters of context shown on each side of a match. */
const CONTEXT = 24;

/** A match as the dialog lists it: its slide's number and the text around it. */
export type FindRow = TextMatch & {
  /** 1-based, in authoring order (as the slide list numbers them across sections). */
  slide: number;
  before: string;
  match: string;
  after: string;
  hidden: boolean;
  /**
   * The slide shows its PowerPoint picture on the screens ('Show the PowerPoint picture') and the match is in
   * an imported box the picture stands in for: a change to it does not show there.
   */
  unseen: boolean;
};

/** The slides of `matches` whose matched box the screens do not draw (they show the PowerPoint picture). */
export function unseenSlides(p: Presentation, matches: readonly TextMatch[]): number {
  const want = new Map<string, Set<string>>();
  for (const m of matches) {
    let ids = want.get(m.slideId);
    if (!ids) want.set(m.slideId, (ids = new Set()));
    ids.add(m.objectId);
  }
  let n = 0;
  for (const sec of p.sections)
    for (const s of sec.slides) {
      const ids = want.get(s.id);
      if (!ids) continue;
      const drawn = new Set(slideContent(s).objects.map((o) => o.id));
      if ([...ids].some((id) => !drawn.has(id))) n++;
    }
  return n;
}

/** The text around a match, cut to `CONTEXT` characters, line breaks shown as ' ⏎ '. */
function context(t: string, start: number, end: number): Pick<FindRow, 'before' | 'match' | 'after'> {
  const show = (s: string) => s.replace(/\n/g, ' ⏎ ');
  const a = Math.max(0, start - CONTEXT);
  const b = Math.min(t.length, end + CONTEXT);
  return {
    before: (a > 0 ? '…' : '') + show(t.slice(a, start)),
    match: show(t.slice(start, end)),
    after: show(t.slice(end, b)) + (b < t.length ? '…' : ''),
  };
}

/** The dialog's rows for `matches` of `p` (at most `LIST_LIMIT`). */
export function findRows(p: Presentation, matches: readonly TextMatch[]): FindRow[] {
  const numbers = new Map<
    string,
    { n: number; hidden: boolean; texts: Map<string, string>; drawn: Set<string> }
  >();
  let n = 0;
  for (const sec of p.sections)
    for (const s of sec.slides) {
      n++;
      const texts = new Map<string, string>();
      for (const o of s.objects) if (o.type === 'text') texts.set(o.id, o.text);
      const drawn = new Set(slideContent(s).objects.map((o) => o.id));
      numbers.set(s.id, { n, hidden: !!s.hidden, texts, drawn });
    }
  const rows: FindRow[] = [];
  for (const m of matches.slice(0, LIST_LIMIT)) {
    const info = numbers.get(m.slideId);
    const t = info?.texts.get(m.objectId);
    if (!info || t === undefined) continue;
    rows.push({
      ...m,
      slide: info.n,
      hidden: info.hidden,
      unseen: !info.drawn.has(m.objectId),
      ...context(t, m.start, m.end),
    });
  }
  return rows;
}

/** What Replace all says: how many it replaced, and on how many slides the screens will not show it. */
export function replacedMessage(n: number, slides: number, unseen: number): string {
  if (!n) return 'Nothing was replaced.';
  const s = (k: number) => `${k} slide${k === 1 ? '' : 's'}`;
  const which =
    unseen === slides
      ? slides === 1
        ? 'That slide shows its PowerPoint picture'
        : 'Those slides show their PowerPoint pictures'
      : `${unseen} of those slides ${unseen === 1 ? 'shows its PowerPoint picture' : 'show their PowerPoint pictures'}`;
  const hidden =
    unseen > 0
      ? ` ${which} on the screens, so the change does not show there ('Show the objects instead' on the PowerPoint card shows it).`
      : '';
  return `Replaced ${n} match${n === 1 ? '' : 'es'} on ${s(slides)}.${hidden} Undo puts them back.`;
}

/** '3 matches on 2 slides', 'No matches', or what to do first. */
export function matchSummary(find: string, matches: readonly TextMatch[]): string {
  if (!find) return 'Type the text to find.';
  if (!matches.length) return 'No matches.';
  const slides = new Set(matches.map((m) => m.slideId)).size;
  const more = matches.length >= COUNT_LIMIT ? '+' : '';
  const n = matches.length;
  return `${n}${more} match${n === 1 ? '' : 'es'} on ${slides} slide${slides === 1 ? '' : 's'}.`;
}

export type FindReplaceViewProps = {
  find: string;
  repl: string;
  opts: FindOptions;
  rows: FindRow[];
  /** Every match found (the list shows `rows`). */
  total: number;
  summary: string;
  /** After Replace all: what was replaced. */
  done?: string;
  readOnly: boolean;
  onFind: (v: string) => void;
  onRepl: (v: string) => void;
  onOpts: (o: FindOptions) => void;
  onReplace: () => void;
  onGo: (row: FindRow) => void;
  onClose: () => void;
};

/**
 * The dialog itself, props only. Find and Replace with are labelled fields (16 px under a finger, as every
 * input is); Match case and Whole words are check boxes inside their labels; the count is a polite live
 * region, so a screen reader hears it as the volunteer types; each listed match is a button that opens it.
 * Replace all is disabled with no match or while the presentation is locked.
 */
export function FindReplaceView(props: FindReplaceViewProps) {
  const id = useId();
  const { opts } = props;
  return (
    <Dialog
      title="Find and replace"
      onClose={props.onClose}
      width={640}
      footer={
        <>
          <button type="button" onClick={props.onClose}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            disabled={props.readOnly || !props.total}
            onClick={props.onReplace}
          >
            Replace all
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 10 }} data-find-dialog>
        <label className="field">
          <span>Find</span>
          <input
            value={props.find}
            autoFocus
            spellCheck={false}
            onChange={(e) => props.onFind(e.target.value)}
            data-find-input
          />
        </label>
        <label className="field">
          <span>Replace with</span>
          <input
            value={props.repl}
            spellCheck={false}
            disabled={props.readOnly}
            onChange={(e) => props.onRepl(e.target.value)}
            data-replace-input
          />
        </label>
        <div className="row wrap" style={{ gap: 12 }}>
          <label className="check">
            <input
              type="checkbox"
              checked={!!opts.case}
              onChange={(e) => props.onOpts({ ...opts, case: e.target.checked })}
            />
            Match case
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!!opts.wholeWord}
              onChange={(e) => props.onOpts({ ...opts, wholeWord: e.target.checked })}
            />
            Whole words
          </label>
        </div>
        <span id={`${id}-count`} role="status" aria-live="polite" className="small" data-find-count>
          {props.summary}
        </span>
        {props.done && (
          <div className="banner small" role="status" data-find-done>
            {props.done}
          </div>
        )}
        {props.rows.length > 0 && (
          <ul
            className="col"
            aria-labelledby={`${id}-count`}
            style={{ gap: 2, listStyle: 'none', margin: 0, padding: 0, maxHeight: 320, overflow: 'auto' }}
          >
            {props.rows.map((r) => (
              <li key={`${r.objectId}:${r.start}`} className="row" style={{ gap: 8 }} data-find-row>
                <button
                  type="button"
                  className="small ghost"
                  aria-label={`Open slide ${r.slide}: ${r.before}${r.match}${r.after}`}
                  onClick={() => props.onGo(r)}
                >
                  Slide {r.slide}
                </button>
                <span className="grow small ellipsis">
                  {r.before}
                  <mark>{r.match}</mark>
                  {r.after}
                </span>
                {r.hidden && <span className="tag">Hidden</span>}
                {r.unseen && (
                  <span
                    className="tag amber"
                    title="This slide shows its PowerPoint picture on the screens: the change does not show there."
                  >
                    Shown as the PowerPoint picture
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {props.total > props.rows.length && (
          <span className="muted small">
            The first {props.rows.length} are listed; Replace all replaces every match.
          </span>
        )}
      </div>
    </Dialog>
  );
}

/**
 * The dialog bound to the editor: it searches the open draft as the volunteer types, Replace all applies
 * `findAndReplace` (one undo step, saved with the presentation), and a listed match opens its slide with
 * the match selected in the text field. On close focus goes back where it was (the 'Find…' button).
 */
export function FindReplaceDialog({ readOnly, onClose }: { readOnly: boolean; onClose: () => void }) {
  const draft = useEditor((s) => s.draft);
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [opts, setOpts] = useState<FindOptions>({});
  const [done, setDone] = useState<string>();
  const back = useRef<Element | null>(null);
  const restore = useRef(true);
  useEffect(() => {
    back.current = document.activeElement;
    return () => {
      const el = back.current as HTMLElement | null;
      if (restore.current && el?.isConnected) el.focus();
    };
  }, []);
  const matches = useMemo(() => (draft ? findText(draft, find, opts, COUNT_LIMIT) : []), [draft, find, opts]);
  const rows = useMemo(() => (draft ? findRows(draft, matches) : []), [draft, matches]);
  if (!draft) return null;
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setDone(undefined);
    };
  return (
    <FindReplaceView
      find={find}
      repl={repl}
      opts={opts}
      rows={rows}
      total={matches.length}
      summary={matchSummary(find, matches)}
      done={done}
      readOnly={readOnly}
      onFind={edit(setFind)}
      onRepl={edit(setRepl)}
      onOpts={edit(setOpts)}
      onReplace={() => {
        if (readOnly) return;
        const slides = new Set(matches.map((m) => m.slideId)).size;
        const unseen = unseenSlides(draft, matches);
        const n = findAndReplace(find, repl, opts);
        setDone(replacedMessage(n, slides, unseen));
      }}
      onGo={(r) => {
        restore.current = false;
        onClose();
        selectSlide(r.slideId);
        selectObject(r.objectId);
        // The Object panel opens with the object; select the match in its text field.
        setTimeout(() => {
          const el = document.getElementById('ordo-text-editor') as HTMLTextAreaElement | null;
          if (!el) return;
          el.focus();
          el.setSelectionRange(r.start, r.end);
          el.dispatchEvent(new Event('select', { bubbles: true }));
        }, 0);
      }}
      onClose={onClose}
    />
  );
}
