import { hubNow } from '@ordo/client';
import type { Media, Presentation } from '@ordo/domain';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from './state/library.ts';
import { useLive } from './state/live.ts';

/** Re-render every `ms` and return hub time. */
export function useHubNow(ms = 1000): number {
  const [, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return hubNow();
}

/** True once the element has scrolled into view (stays true). */
export function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [vis, setVis] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || vis) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVis(true);
      return;
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setVis(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [vis]);
  return [ref, vis];
}

/** Media lookup preferring the live resolved copy, then the library. */
export function useMediaLookup(): (id: string) => Media | undefined {
  const media = useLibrary((s) => s.data.media);
  const resolved = useLive((s) => s.state.resolved);
  return useMemo(() => {
    const map = new Map(media.map((m) => [m.id, m]));
    return (id: string) => resolved?.media[id] ?? map.get(id);
  }, [media, resolved]);
}

export function usePresentationLookup(): (id: string) => Presentation | undefined {
  const list = useLibrary((s) => s.data.presentations);
  return useMemo(() => {
    const map = new Map(list.map((p) => [p.id, p]));
    return (id: string) => map.get(id);
  }, [list]);
}

/** Presentations locked by the live playlist (prd/09). */
export function useLockedIds(): Set<string> {
  const resolved = useLive((s) => (s.state.mode === 'live' ? s.state.resolved : undefined));
  return useMemo(() => {
    const ids = new Set<string>();
    if (!resolved) return ids;
    for (const it of resolved.playlist.items) if (it.kind === 'presentation') ids.add(it.presentationId);
    return ids;
  }, [resolved]);
}

export function useLivePlaylistId(): string | undefined {
  return useLive((s) => (s.state.mode === 'live' ? s.state.resolved?.playlist.id : undefined));
}
