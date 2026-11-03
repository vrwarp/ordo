import { hubNow } from '@ordo/client';
import { type PropBox, rgbaCss, type TextStyle } from '@ordo/domain';
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { StageHost } from './host.ts';
import {
  boxCss,
  MESSAGE_FADE_MS,
  reconcileMessages,
  type ShownMessage,
  type StageText,
  textCss,
} from './model.ts';

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

/**
 * The stage, drawn from the view model the link worker posts (design/16, design/25). Nothing here reads
 * the live state: text, timers and the clock arrive computed; only layout fitting and message fades run
 * on this thread.
 */
export function App(props: { host: StageHost }) {
  const h = props.host;
  const snap = useSyncExternalStore(h.subscribe, h.getSnapshot);
  const scale = useStageScale();
  const v = snap.view;
  const { layout } = v;

  // Messages: reconcile with the active list so new ones fade in and removed ones fade out.
  const [shownMsgs, setShownMsgs] = useState<ShownMessage[]>([]);
  const activeSig = v.messages.map((m) => `${m.id}:${m.text}`).join('|');
  const [fadeTick, setFadeTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSig captures the active list
  useEffect(() => {
    setShownMsgs((prev) => {
      const nextList = reconcileMessages(prev, v.messages, hubNow());
      const same = nextList.length === prev.length && nextList.every((m, i) => m === prev[i]);
      return same ? prev : nextList;
    });
  }, [activeSig, fadeTick]);
  // Drop faded-out messages once their fade has run.
  useEffect(() => {
    if (!shownMsgs.some((m) => m.phase === 'out')) return;
    const t = setTimeout(() => setFadeTick((x) => x + 1), MESSAGE_FADE_MS + 20);
    return () => clearTimeout(t);
  }, [shownMsgs]);

  const stageStyle: CSSProperties = {
    transform: `translate(-50%, -50%) scale(${scale})`,
    background: rgbaCss(layout.clearColor),
  };
  const { countdown, elapsed, remaining } = v;

  return (
    <div className="viewport" style={{ background: rgbaCss(layout.clearColor) }}>
      <div className="stage" style={stageStyle}>
        {layout.current ? (
          <TextRegion
            className="current"
            box={layout.current.box}
            style={layout.current.style}
            text={v.current}
            section={layout.section}
            fontsVersion={snap.fontsVersion}
          />
        ) : null}
        {layout.next && v.next ? (
          <TextRegion
            className="next"
            box={layout.next.box}
            style={layout.next.style}
            text={v.next}
            section={layout.section}
            fontsVersion={snap.fontsVersion}
          />
        ) : null}
        {layout.clock ? (
          <PropText prop={layout.clock} className="clock">
            {v.clock}
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
        {v.bus === 'none' || snap.linkDown ? (
          <div
            className="offline-dot"
            title={snap.linkDown ? 'Stage link restarting' : 'Not connected to the hub'}
          />
        ) : null}
      </div>
    </div>
  );
}
