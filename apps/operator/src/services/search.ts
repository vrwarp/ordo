import { useEffect, useRef, useState } from 'react';
import type { SearchFilter, SearchHit } from '../core/protocol.ts';
import { SearchIndex } from '../lib/search.ts';
import { useLibrary } from '../state/library.ts';
import { controller } from './controller.ts';

/** Used only while the core worker cannot answer (restarting): the same index on the read model. */
const localIndex = new SearchIndex();

function searchLocally(q: string, f: SearchFilter): SearchHit[] {
  const d = useLibrary.getState().data;
  localIndex.update(d.presentations, d.media);
  return localIndex.search(q, f).map(({ h: _h, t: _t, ...hit }) => hit);
}

/**
 * Library search (design/25): the index lives in the core worker, so typing in a large library never
 * normalizes lyrics on the main thread. Re-runs when the query, the filter or the library changes.
 */
export function useSearch(q: string, f: SearchFilter): SearchHit[] {
  const rev = useLibrary((s) => s.rev);
  const key = JSON.stringify(f);
  const [hits, setHits] = useState<SearchHit[]>(() => (controller() ? [] : searchLocally(q, f)));
  const seq = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the filter is compared by its JSON key
  useEffect(() => {
    const n = ++seq.current;
    const core = controller()?.core;
    if (!core?.alive) {
      setHits(searchLocally(q, f));
      return;
    }
    void core.search(q, f).then((res) => {
      if (n !== seq.current) return;
      setHits(res ?? searchLocally(q, f));
    });
  }, [q, key, rev]);
  return hits;
}
