import { type Presentation, slideContent } from '@ordo/domain';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { findAndReplace } from './actions.ts';
import { selectObject, selectSlide, setTextRange, useEditor } from './editorStore.ts';
import { type FindOptions, findText, type TextMatch } from './ops/slides.ts';

/*
 * Non-modal floating 'Find & replace' bar (Ctrl+F): floats cleanly in the top-right of the editor without
 * blocking the slide stage, stepping through matches (`↑` / `↓`) and highlighting matched words live on
 * `SlideCanvas`, then replacing all in one undo step (`findReplace`).
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
  /** Currently highlighted match index in `rows`. */
  activeIndex?: number;
  /** After Replace all: what was replaced. */
  done?: string;
  readOnly: boolean;
  onFind: (v: string) => void;
  onRepl: (v: string) => void;
  onOpts: (o: FindOptions) => void;
  onReplace: () => void;
  onGo: (row: FindRow, index?: number) => void;
  onStep?: (delta: -1 | 1) => void;
  onClose: () => void;
};

/**
 * Floating non-modal Find & Replace card (`role="dialog"`, no screen-blocking backdrop), allowing the
 * volunteer to see live match highlights directly on `SlideCanvas` as they type or step `↑ / ↓`.
 */
export function FindReplaceView(props: FindReplaceViewProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const { opts } = props;
  const activeIdx = props.activeIndex ?? 0;

  return (
    <div
      className="ed-find-floating"
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h3 id={titleId} style={{ margin: 0, fontSize: 13 }}>
          Find and replace
        </h3>
        <div className="row" style={{ gap: 4, alignItems: 'center' }}>
          <button
            type="button"
            className="small ghost"
            aria-label="Previous match"
            title="Previous match (Shift+Enter)"
            disabled={!props.rows.length}
            onClick={() => {
              if (props.onStep) props.onStep(-1);
              else if (props.rows.length) {
                const prev = (activeIdx - 1 + props.rows.length) % props.rows.length;
                props.onGo(props.rows[prev]!, prev);
              }
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className="small ghost"
            aria-label="Find Next"
            title="Next match (Enter)"
            disabled={!props.rows.length}
            onClick={() => {
              if (props.onStep) props.onStep(1);
              else if (props.rows[0]) props.onGo(props.rows[0], 0);
            }}
          >
            ↓
          </button>
          <button
            type="button"
            className="small ghost"
            aria-label="Close"
            title="Close (Esc)"
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
      </div>

      <div className="col" style={{ gap: 8 }} data-find-dialog>
        <label className="field">
          <span>Find</span>
          <input
            value={props.find}
            autoFocus
            spellCheck={false}
            placeholder="Search deck text…"
            onChange={(e) => props.onFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && props.rows.length) {
                e.preventDefault();
                const delta = e.shiftKey ? -1 : 1;
                if (props.onStep) props.onStep(delta);
                else props.onGo(props.rows[0]!, 0);
              }
            }}
            data-find-input
          />
        </label>
        <label className="field">
          <span>Replace with</span>
          <input
            value={props.repl}
            spellCheck={false}
            disabled={props.readOnly}
            placeholder="Replacement…"
            onChange={(e) => props.onRepl(e.target.value)}
            data-replace-input
          />
        </label>

        <div className="row wrap" style={{ gap: 10, justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="row wrap" style={{ gap: 10 }}>
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
          <button
            type="button"
            className="primary"
            disabled={props.readOnly || !props.total}
            onClick={props.onReplace}
          >
            Replace all
          </button>
        </div>

        <span id={`${id}-count`} role="status" aria-live="polite" className="small muted" data-find-count>
          {props.summary}
        </span>

        {props.done && (
          <div className="banner small" role="status" data-find-done>
            {props.done}
          </div>
        )}

        {props.rows.length > 0 && (
          <ul
            className="col ed-find-list"
            aria-labelledby={`${id}-count`}
            style={{ gap: 2, listStyle: 'none', margin: 0, padding: 0, maxHeight: 200, overflow: 'auto' }}
          >
            {props.rows.map((r, idx) => (
              <li
                key={`${r.objectId}:${r.start}`}
                className={`row ed-find-row${idx === activeIdx ? ' active' : ''}`}
                style={{ gap: 8 }}
                data-find-row
              >
                <button
                  type="button"
                  className="small ghost"
                  aria-label={`Open slide ${r.slide}: ${r.before}${r.match}${r.after}`}
                  onClick={() => props.onGo(r, idx)}
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
    </div>
  );
}

/**
 * Floating non-modal Find & Replace bound to the editor: highlights matches live on `SlideCanvas` as you
 * type or step through matches without blocking the stage.
 */
export function FindReplaceDialog({ readOnly, onClose }: { readOnly: boolean; onClose: () => void }) {
  const draft = useEditor((s) => s.draft);
  const [find, setFind] = useState('');
  const [repl, setRepl] = useState('');
  const [opts, setOpts] = useState<FindOptions>({});
  const [activeIdx, setActiveIdx] = useState(0);
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

  const highlightMatchOnStage = (r: FindRow, focusEditor = false) => {
    selectSlide(r.slideId);
    selectObject(r.objectId);
    setTextRange({ start: r.start, end: r.end, caret: r.end });
    if (focusEditor) {
      setTimeout(() => {
        const el = document.getElementById('ordo-text-editor') as HTMLTextAreaElement | null;
        if (!el) return;
        el.focus();
        el.setSelectionRange(r.start, r.end);
        el.dispatchEvent(new Event('select', { bubbles: true }));
      }, 0);
    }
  };

  // Auto-preview the first match live on the stage when typing!
  // biome-ignore lint/correctness/useExhaustiveDependencies: jump to first match when query changes
  useEffect(() => {
    setActiveIdx(0);
    if (rows[0]) {
      highlightMatchOnStage(rows[0], false);
    }
  }, [find, opts.case, opts.wholeWord]);

  if (!draft) return null;

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setDone(undefined);
    };

  const stepMatch = (delta: -1 | 1) => {
    if (!rows.length) return;
    const next = (activeIdx + delta + rows.length) % rows.length;
    setActiveIdx(next);
    highlightMatchOnStage(rows[next]!, false);
  };

  return (
    <FindReplaceView
      find={find}
      repl={repl}
      opts={opts}
      rows={rows}
      total={matches.length}
      summary={matchSummary(find, matches)}
      activeIndex={activeIdx}
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
      onStep={stepMatch}
      onGo={(r, idx) => {
        if (idx !== undefined) setActiveIdx(idx);
        highlightMatchOnStage(r, true);
      }}
      onClose={onClose}
    />
  );
}
