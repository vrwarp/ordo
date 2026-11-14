import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { t } from '../../i18n/index.ts';
import {
  FRESHNESS_GRACE_MS,
  freshnessShown,
  freshnessText,
  readLastContact,
  writeLastContact,
} from '../../lib/freshness.ts';
import { liveSheetText, liveStrip } from '../../lib/liveStrip.ts';
import { pollVenueLiveNow, useVenueLive } from '../../lib/venueLive.ts';
import { useLive } from '../../state/live.ts';
import { useSession } from '../../state/session.ts';

function subscribeOnline(fn: () => void): () => void {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
}

/** navigator.onLine, following its events. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false,
    () => true,
  );
}

/**
 * The Live now strip (design/28 §2.2, decision 12): "Live at the venue: Sunday Service · 6 locked" while a
 * service runs, "Live status unknown: offline" or "... can't reach ordo" when the phone cannot know; hidden
 * otherwise. Its text comes from lib/liveStrip.ts, fed the plan's name and locked ids only, never the cue
 * label the iPad's chip shows. P0's source is the 8 s `/live/summary` poll (lib/venueLive.ts), polled at once
 * on `pageshow` and `online`; P1 swaps in the venue push behind the same input. A dot, a word and a colour;
 * a tap opens the Live sheet.
 */
export function LiveNowStrip() {
  const live = useVenueLive((s) => s.live);
  const status = useVenueLive((s) => s.status);
  const online = useOnline();
  const sessionOffline = useSession((s) => s.status === 'offline');
  const [open, setOpen] = useState(false);
  // Back from the background (a restored page too) or back online: ask at once (§3.11).
  useEffect(() => {
    const now = () => pollVenueLiveNow();
    window.addEventListener('pageshow', now);
    window.addEventListener('online', now);
    return () => {
      window.removeEventListener('pageshow', now);
      window.removeEventListener('online', now);
    };
  }, []);
  const strip = liveStrip({
    live: live ? { playlistName: live.playlistName, presentationIds: live.presentationIds } : undefined,
    status,
    online,
    sessionOffline,
  });
  return (
    <div className="compact-strip-slot" aria-live="polite">
      {strip.kind !== 'hidden' && (
        <button
          type="button"
          className={`compact-strip ${strip.kind}`}
          data-live-strip={strip.kind}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <span className={`dot sm ${strip.kind === 'live' ? 'red' : 'amber'}`} aria-hidden="true" />
          <span className="compact-strip-text">{strip.text}</span>
        </button>
      )}
      {open && (
        <Dialog title={t('live.sheetTitle')} onClose={() => setOpen(false)}>
          <p className="compact-sheet-text" data-live-sheet>
            {liveSheetText(strip)}
          </p>
        </Dialog>
      )}
    </div>
  );
}

/**
 * The freshness line (design/28 §2.2, §2.12 "Offline"): how old this phone's copy may be while it cannot reach
 * ordo; hidden while connected, shown 5 s after a drop (at once on an offline start). The last contact is
 * written when the link goes down and on pagehide while connected, and read on an offline start
 * (lib/freshness.ts, localStorage `ordo.op.lastContact`).
 */
export function FreshnessLine() {
  const online = useOnline();
  const sessionOffline = useSession((s) => s.status === 'offline');
  const hubConnected = useLive((s) => s.hubConnected);
  const everConnected = useLive((s) => s.everConnected);
  const offline = !online || sessionOffline;
  const hubDown = !offline && everConnected && !hubConnected;
  const connected = !offline && !hubDown;
  const [last, setLast] = useState(() => readLastContact(Date.now()));
  const [downSince, setDownSince] = useState<number>();
  const [now, setNow] = useState(() => Date.now());
  const connectedRef = useRef(connected);
  connectedRef.current = connected;
  useEffect(() => {
    if (connected) {
      setDownSince(undefined);
      return;
    }
    const at = Date.now();
    setDownSince(at);
    setNow(at);
    // A drop: the copy is from now. An offline start keeps the time it stored before.
    if (!sessionOffline) {
      writeLastContact(at);
      setLast(at);
    }
    const timer = setTimeout(() => setNow(Date.now()), FRESHNESS_GRACE_MS);
    return () => clearTimeout(timer);
  }, [connected, sessionOffline]);
  useEffect(() => {
    const onHide = () => {
      if (connectedRef.current) writeLastContact(Date.now());
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);
  const text = freshnessText({ offline, hubDown, lastContact: last });
  if (!text || !freshnessShown(downSince, now, sessionOffline)) return null;
  return (
    <div className="compact-fresh" data-freshness role="status">
      {text}
    </div>
  );
}
