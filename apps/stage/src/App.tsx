import { hubNow } from '@ordo/client';
import { formatClock, type PropBox, rgbaCss, type TextStyle } from '@ordo/domain';
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { StageController } from './controller.ts';
import {
  activeMessages,
  boxCss,
  countdownDisplay,
  currentText,
  elapsedDisplay,
  mediaRemainingDisplay,
  MESSAGE_FADE_MS,
  nextExpiry,
  nextText,
  reconcileMessages,
  type ShownMessage,
  type StageText,
  textCss,
} from './model.ts';

/** Hub time, re-rendered on every quarter second (clock, timers, message expiry). */
function useHubNow(stepMs = 250): number {
  const [now, setNow] = useState(() => hubNow());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const n = hubNow();
      setNow(n);
      // Align to the next quarter second so the clock flips on the second.
      t = setTimeout(tick, stepMs - (n % stepMs) + 2);
    };
    tick();
    return () => clearTimeout(t);
  }, [stepMs]);
  return now;
}

/** Scale the 1920x1080 logical stage to fit the window, letterboxed. */
function useStageScale(): number {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const update = () => setScale(Math.min(window.innerWidth / 1920, window.innerHeight / 1080));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return scale;
}

/**
 * Shrink the text inside `ref` until it fits its box (down to 40 % of the style size). Re-runs when the
 * text, the base size or the loaded fonts change.
 */
function useFitText(ref: React.RefObject<HTMLDivElement | null>, baseSize: number, key: string) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` changes whenever the content or fonts change
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const inner = el.firstElementChild as HTMLElement | null;
    if (!inner) return;
    let lo = Math.max(8, Math.floor(baseSize * 0.4));
    let hi = baseSize;
    inner.style.fontSize = `${hi}px`;
    if (inner.scrollHeight <= el.clientHeight + 1 && inner.scrollWidth <= el.clientWidth + 1) return;
    // Binary search on whole pixels.
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      inner.style.fontSize = `${mid}px`;
      if (inner.scrollHeight <= el.clientHeight + 1 && inner.scrollWidth <= el.clientWidth + 1) lo = mid;
      else hi = mid - 1;
    }
    inner.style.fontSize = `${lo}px`;
  }, [ref, baseSize, key]);
}

function TextRegion(props: {
  box: { x: number; y: number; w: number; h: number; rotation: number };
  style: TextStyle;
  text: StageText | null;
  section?: TextStyle | null;
  fontsVersion: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const t = props.text;
  useFitText(ref, props.style.fontSizePx, `${t?.text}|${t?.label}|${t?.position}|${props.fontsVersion}`);
  const css = textCss(props.style);
  const { justifyContent, padding, background, borderRadius, ...font } = css;
  const outer: CSSProperties = {
    ...boxCss(props.box),
    justifyContent: justifyContent as string,
    padding: padding as string,
    background: background as string | undefined,
    borderRadius: borderRadius as string | undefined,
  };
  return (
    <div ref={ref} className={`region ${props.className ?? ''}`} style={outer}>
      <div className="region-inner" style={font as CSSProperties}>
        {t?.label && props.section ? (
          <div className="kicker" style={kickerCss(props.section)}>
            {t.label}
            {t.position ? <span className="pos">{t.position}</span> : null}
          </div>
        ) : null}
        {t?.text ? <div className="lyrics">{t.text}</div> : null}
      </div>
    </div>
  );
}

function kickerCss(style: TextStyle): CSSProperties {
  return {
    fontFamily: `"${style.fontFamily}", Inter, system-ui, sans-serif`,
    fontWeight: style.fontWeight,
    // Relative to the region's (fitted) font size so the kicker shrinks with the lyrics.
    fontSize: '0.5em',
    color: rgbaCss(style.color),
    letterSpacing: '0.04em',
  };
}

function PropText(props: { prop: PropBox; children: React.ReactNode; className?: string; dim?: boolean }) {
  const css = textCss(props.prop);
  return (
    <div
      className={`region prop ${props.className ?? ''}`}
      style={{ ...boxCss(props.prop.box), ...(css as CSSProperties), opacity: props.dim ? 0.6 : 1 }}
    >
      <div className="prop-inner">{props.children}</div>
    </div>
  );
}

function Messages(props: { prop: PropBox; shown: ShownMessage[] }) {
  const { justifyContent: _j, padding, background, borderRadius, ...font } = textCss(props.prop);
  const card: CSSProperties = {
    ...(font as CSSProperties),
    padding: padding as string,
    background: background as string | undefined,
    borderRadius: borderRadius as string | undefined,
  };
  // Newest first, stacked from the bottom of the box; overflow drops the oldest.
  return (
    <div className="region messages" style={boxCss(props.prop.box)}>
      {props.shown.map((m) => (
        <MessageCard key={m.id} m={m} style={card} />
      ))}
    </div>
  );
}

function MessageCard(props: { m: ShownMessage; style: CSSProperties }) {
  // Start transparent, then fade to the phase's opacity on the next frame (CSS transition, 1 s).
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(r);
  }, []);
  const opacity = props.m.phase === 'out' || !entered ? 0 : 1;
  return (
    <div className="message" style={{ ...props.style, opacity, transitionDuration: `${MESSAGE_FADE_MS}ms` }}>
      {props.m.text}
    </div>
  );
}

export function App(props: { controller: StageController }) {
  const c = props.controller;
  const snap = useSyncExternalStore(c.subscribe, c.getSnapshot);
  const now = useHubNow();
  const scale = useStageScale();
  const { state, layout, general, shown } = snap;

  const current = useMemo(() => currentText(state, shown, layout), [state, shown, layout]);
  const next = useMemo(() => nextText(state, shown, layout), [state, shown, layout]);
  const countdown = layout.countdown ? countdownDisplay(state, now, general.timeZone) : null;
  const elapsed = layout.elapsed ? elapsedDisplay(state, now) : null;
  const remaining = layout.mediaRemaining ? mediaRemainingDisplay(state, now) : null;

  // Messages: reconcile on every tick so TTL expiry and fade-outs progress.
  const [shownMsgs, setShownMsgs] = useState<ShownMessage[]>([]);
  const active = activeMessages(state.messages, now);
  const activeSig = active.map((m) => `${m.id}:${m.text}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSig captures the active list
  useEffect(() => {
    setShownMsgs((prev) => {
      const nextList = reconcileMessages(prev, active, hubNow());
      const same = nextList.length === prev.length && nextList.every((m, i) => m === prev[i]);
      return same ? prev : nextList;
    });
  }, [activeSig, now]);
  // Wake exactly at the next expiry instead of waiting for the tick.
  const expiry = nextExpiry(state.messages, now);
  const [, force] = useState(0);
  useEffect(() => {
    if (expiry === undefined) return;
    const t = setTimeout(() => force((x) => x + 1), Math.max(0, expiry - hubNow()) + 5);
    return () => clearTimeout(t);
  }, [expiry]);

  const stageStyle: CSSProperties = {
    transform: `translate(-50%, -50%) scale(${scale})`,
    background: rgbaCss(layout.clearColor),
  };

  return (
    <div className="viewport" style={{ background: rgbaCss(layout.clearColor) }}>
      <div className="stage" style={stageStyle}>
        {layout.current ? (
          <TextRegion
            className="current"
            box={layout.current.box}
            style={layout.current.style}
            text={current}
            section={layout.section}
            fontsVersion={snap.fontsVersion}
          />
        ) : null}
        {layout.next && next ? (
          <TextRegion
            className="next"
            box={layout.next.box}
            style={layout.next.style}
            text={next}
            section={layout.section}
            fontsVersion={snap.fontsVersion}
          />
        ) : null}
        {layout.clock ? (
          <PropText prop={layout.clock} className="clock">
            {formatClock(now, general.timeZone, general.clock24h)}
          </PropText>
        ) : null}
        {layout.countdown && countdown ? (
          <PropText prop={layout.countdown} className="countdown">
            <span className="timer-label">{countdown.label}</span> {countdown.value}
          </PropText>
        ) : null}
        {layout.elapsed && elapsed ? (
          <PropText prop={layout.elapsed} className="elapsed" dim={!elapsed.running}>
            <span className="timer-label">{elapsed.label}</span> {elapsed.value}
          </PropText>
        ) : null}
        {layout.mediaRemaining && remaining ? (
          <PropText
            prop={layout.mediaRemaining}
            className={`media-remaining${remaining.overdue ? ' overdue' : ''}`}
            dim={!remaining.running}
          >
            <span className="timer-label">{remaining.label}</span> {remaining.value}
          </PropText>
        ) : null}
        {layout.messages ? <Messages prop={layout.messages} shown={shownMsgs} /> : null}
        {snap.bus === 'none' ? <div className="offline-dot" title="Not connected to the hub" /> : null}
      </div>
    </div>
  );
}
