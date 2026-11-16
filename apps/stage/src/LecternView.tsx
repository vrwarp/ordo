import { formatStageNotesPlain, parseStageNoteLine } from '@ordo/domain';
import { Fragment, useEffect, useRef, useState } from 'react';
import { type ShownMessage, stageParagraphs } from './model.ts';
import type { LecternSlide, StageView } from './protocol.ts';

type LecternTheme = 'dark' | 'paper' | 'light';
type LecternFlow = 'slide' | 'manuscript';

const LS_FONT = 'ordo.lectern.fontPx';
const LS_THEME = 'ordo.lectern.theme';
const LS_FLOW = 'ordo.lectern.flow';

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* private mode */
  }
  return fallback;
}

function readFontPx(): number {
  try {
    const n = Number(localStorage.getItem(LS_FONT));
    if (Number.isFinite(n) && n >= 18 && n <= 56) return n;
  } catch {
    /* private mode */
  }
  return 30;
}

export function FormattedNotes(props: { text: string; className?: string }) {
  return (
    <div className={props.className ?? 'notes-text'}>
      {stageParagraphs(props.text).map((p, i) => {
        const parsed = parseStageNoteLine(p);
        if (parsed.plain) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional paragraphs
            <Fragment key={i}>
              {i > 0 ? '\n' : null}
              <div className="para" dir="auto">
                {p}
              </div>
            </Fragment>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional paragraphs
          <Fragment key={i}>
            {i > 0 ? '\n' : null}
            <div className={parsed.bullet ? 'para note-bullet' : 'para'} dir="auto">
              {parsed.bullet ? <span className="note-dot">{'• '}</span> : null}
              {parsed.tokens.map((tok, k) => {
                if (tok.kind === 'highlight') {
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional tokens
                    <strong key={k} className="note-hl">
                      {tok.text}
                    </strong>
                  );
                }
                if (tok.kind === 'cue') {
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional tokens
                    <span key={k} className="note-cue">
                      {tok.text}
                    </span>
                  );
                }
                // biome-ignore lint/suspicious/noArrayIndexKey: positional tokens
                return <Fragment key={k}>{tok.text}</Fragment>;
              })}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

export default function LecternView(props: {
  view: StageView;
  shownMessages: ShownMessage[];
  linkDown: boolean;
  onExitLectern: () => void;
}) {
  const { view: v, shownMessages, linkDown, onExitLectern } = props;
  const slides: LecternSlide[] = v.lecternSlides ?? [];
  const liveIndex = slides.findIndex((s) => s.slideId === v.activeSlideId);

  const [theme, setTheme] = useState<LecternTheme>(() =>
    readStored(LS_THEME, ['dark', 'paper', 'light'] as const, 'dark'),
  );
  const [flow, setFlow] = useState<LecternFlow>(() =>
    readStored(LS_FLOW, ['slide', 'manuscript'] as const, 'slide'),
  );
  const [fontPx, setFontPx] = useState<number>(readFontPx);
  const [followLive, setFollowLive] = useState(true);
  const [peekIndex, setPeekIndex] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const liveCardRef = useRef<HTMLElement>(null);

  // Keep peekIndex synced when following live
  useEffect(() => {
    if (followLive && liveIndex >= 0) {
      setPeekIndex(liveIndex);
    }
  }, [followLive, liveIndex]);

  // Scroll smoothly when the live slide changes while following live
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on activeSlideId or flow change
  useEffect(() => {
    if (!followLive) return;
    if (flow === 'manuscript' && liveCardRef.current) {
      liveCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (bodyRef.current) {
      bodyRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [v.activeSlideId, followLive, flow]);

  const changeFont = (delta: number) => {
    setFontPx((prev) => {
      const next = Math.max(18, Math.min(56, prev + delta));
      try {
        localStorage.setItem(LS_FONT, String(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  };

  const chooseTheme = (t: LecternTheme) => {
    setTheme(t);
    try {
      localStorage.setItem(LS_THEME, t);
    } catch {
      /* private mode */
    }
  };

  const chooseFlow = (f: LecternFlow) => {
    setFlow(f);
    try {
      localStorage.setItem(LS_FLOW, f);
    } catch {
      /* private mode */
    }
  };

  const shownIdx = followLive
    ? liveIndex >= 0
      ? liveIndex
      : 0
    : Math.min(peekIndex, Math.max(0, slides.length - 1));
  const activeSlide = slides[shownIdx];
  const nextSlide = slides[shownIdx + 1];

  const stepPeek = (delta: number) => {
    if (!slides.length) return;
    const base = followLive ? (liveIndex >= 0 ? liveIndex : 0) : shownIdx;
    const target = Math.max(0, Math.min(slides.length - 1, base + delta));
    setPeekIndex(target);
    setFollowLive(target === liveIndex);
    bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const activeWhispers = shownMessages.filter((m) => m.phase === 'in');

  return (
    <div className={`lectern lectern-${theme}`} data-lectern-view data-lectern-theme={theme}>
      {/* Sticky Pulpit Telemetry & Controls Header */}
      <header className="lectern-hdr">
        <div className="lectern-telemetry">
          {v.clock ? <span className="lectern-clock">{v.clock}</span> : null}
          {v.elapsed ? (
            <span className={`lectern-timer elapsed${v.elapsed.running ? '' : ' dim'}`}>
              <small>{v.elapsed.label}</small> {v.elapsed.value}
            </span>
          ) : null}
          {v.countdown ? (
            <span className={`lectern-timer countdown${v.countdown.overdue ? ' overdue' : ''}`}>
              <small>{v.countdown.label}</small> {v.countdown.value}
            </span>
          ) : null}
          {(v.bus === 'none' || linkDown) && (
            <span className="lectern-offline" title="Disconnected from hub">
              Offline
            </span>
          )}
        </div>

        <div className="lectern-controls">
          {!followLive && liveIndex >= 0 ? (
            <button
              type="button"
              className="lectern-btn lectern-return-live"
              onClick={() => setFollowLive(true)}
            >
              ● Return to Live (Slide {liveIndex + 1})
            </button>
          ) : (
            <button
              type="button"
              className={`lectern-btn${followLive ? ' on' : ''}`}
              aria-pressed={followLive}
              onClick={() => setFollowLive((x) => !x)}
              title="Automatically follow the live slide from the booth"
            >
              {followLive ? '● Following Live' : 'Follow Paused'}
            </button>
          )}

          <div className="lectern-seg" role="group" aria-label="Manuscript view mode">
            <button
              type="button"
              className={flow === 'slide' ? 'on' : ''}
              onClick={() => chooseFlow('slide')}
            >
              Current Slide
            </button>
            <button
              type="button"
              className={flow === 'manuscript' ? 'on' : ''}
              onClick={() => chooseFlow('manuscript')}
            >
              Full Manuscript
            </button>
          </div>

          <div className="lectern-seg" role="group" aria-label="Notes text size">
            <button type="button" aria-label="Decrease notes font size" onClick={() => changeFont(-4)}>
              A−
            </button>
            <span className="lectern-px">{fontPx}</span>
            <button type="button" aria-label="Increase notes font size" onClick={() => changeFont(4)}>
              A+
            </button>
          </div>

          <div className="lectern-seg" role="group" aria-label="Reading theme">
            <button
              type="button"
              className={theme === 'dark' ? 'on' : ''}
              onClick={() => chooseTheme('dark')}
            >
              Dark
            </button>
            <button
              type="button"
              className={theme === 'paper' ? 'on' : ''}
              onClick={() => chooseTheme('paper')}
            >
              Paper
            </button>
            <button
              type="button"
              className={theme === 'light' ? 'on' : ''}
              onClick={() => chooseTheme('light')}
            >
              Light
            </button>
          </div>

          <button
            type="button"
            className="lectern-btn"
            onClick={onExitLectern}
            title="Switch to passive 16:9 Stage TV view"
          >
            TV View
          </button>
        </div>
      </header>

      {/* Booth Stage Whisper Alert Banner */}
      {activeWhispers.length > 0 && (
        <div className="lectern-whispers" role="status" aria-live="assertive">
          {activeWhispers.map((m) => (
            <div key={m.id} className="lectern-whisper-pill">
              <span className="lectern-whisper-tag">BOOTH MESSAGE</span>
              <span>{m.text}</span>
            </div>
          ))}
        </div>
      )}

      {/* Slide Stepper / Peek Bar */}
      {slides.length > 0 && (
        <nav className="lectern-stepper" aria-label="Slide peek navigation">
          <button
            type="button"
            className="lectern-step-btn"
            disabled={shownIdx <= 0}
            onClick={() => stepPeek(-1)}
          >
            ◀ Peek Prev
          </button>
          <div className="lectern-step-meta">
            <strong>{v.presentationTitle ?? 'Active Presentation'}</strong>
            <span>
              Slide {shownIdx + 1} of {slides.length}
              {activeSlide?.section ? ` · ${activeSlide.section}` : ''}
              {!followLive && liveIndex >= 0 ? ` (Live is ${liveIndex + 1})` : ''}
            </span>
          </div>
          <button
            type="button"
            className="lectern-step-btn"
            disabled={shownIdx >= slides.length - 1}
            onClick={() => stepPeek(1)}
          >
            Peek Next ▶
          </button>
        </nav>
      )}

      {/* Main Scrollable Pulpit Manuscript Area */}
      <main ref={bodyRef} className="lectern-body" style={{ fontSize: `${fontPx}px` }}>
        {!slides.length && !v.current && !v.notes ? (
          <div className="lectern-empty">
            Waiting for a live slide… When the booth goes live, your speaker notes and slide cues appear here
            automatically.
          </div>
        ) : flow === 'manuscript' && slides.length > 0 ? (
          <div className="lectern-manuscript" data-lectern-manuscript>
            {slides.map((sl, idx) => {
              const isLive = idx === liveIndex;
              return (
                <article
                  key={sl.slideId}
                  ref={isLive ? liveCardRef : undefined}
                  className={`lectern-card${isLive ? ' is-live' : ''}`}
                  onClick={() => {
                    setPeekIndex(idx);
                    if (idx !== liveIndex) setFollowLive(false);
                  }}
                >
                  <div className="lectern-card-head">
                    <span className="lectern-badge">
                      {isLive ? '● ON SCREEN NOW · ' : ''}Slide {sl.number}
                      {sl.section ? ` · ${sl.section}` : ''}
                    </span>
                    {sl.text ? (
                      <span className="lectern-slide-excerpt">{sl.text.replace(/\n+/g, ' · ')}</span>
                    ) : null}
                  </div>
                  {sl.notes ? (
                    <FormattedNotes text={sl.notes} className="lectern-notes" />
                  ) : (
                    <p className="lectern-no-notes">No speaker notes on this slide.</p>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="lectern-single">
            {/* Compact On-Screen Slide Reference Card */}
            {(activeSlide?.text || v.current?.text) && (
              <section className="lectern-onscreen-ref">
                <div className="lectern-ref-label">
                  {followLive
                    ? 'ON AUDIENCE SCREEN NOW'
                    : `PEEKING SLIDE ${shownIdx + 1} (AUDIENCE UNCHANGED)`}
                </div>
                <div className="lectern-ref-text" dir="auto">
                  {activeSlide?.text ?? v.current?.text}
                </div>
              </section>
            )}

            {/* Primary Speaker Notes Prompter */}
            <section className="lectern-primary-notes" data-lectern-notes>
              {(activeSlide ? activeSlide.notes : v.notes) ? (
                <FormattedNotes
                  text={(activeSlide ? activeSlide.notes : v.notes) ?? ''}
                  className="lectern-notes"
                />
              ) : (
                <p className="lectern-no-notes">No speaker notes written for this slide.</p>
              )}
            </section>

            {/* Next Slide Look-Ahead */}
            {(nextSlide || v.next) && (
              <section className="lectern-upnext">
                <div className="lectern-ref-label">
                  UP NEXT{' '}
                  {nextSlide ? `· SLIDE ${nextSlide.number}` : v.next?.label ? `· ${v.next.label}` : ''}
                </div>
                {(nextSlide?.text || v.next?.text) && (
                  <div className="lectern-upnext-slide" dir="auto">
                    {nextSlide?.text ?? v.next?.text}
                  </div>
                )}
                {(nextSlide?.notes || v.nextNotes) && (
                  <div className="lectern-upnext-notes" dir="auto">
                    {formatStageNotesPlain(nextSlide?.notes ?? v.nextNotes ?? '').slice(0, 280)}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
