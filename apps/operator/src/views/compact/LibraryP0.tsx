import type { Presentation } from '@ordo/domain';
import { useMemo, useState } from 'react';
import { useLockedIds } from '../../hooks.ts';
import { type MessageKey, t } from '../../i18n/index.ts';
import { useSearch } from '../../services/search.ts';
import { useLibrary } from '../../state/library.ts';

/** Rows drawn at once; a search narrows the rest (P1's bottom search and filters replace this view). */
const MAX_ROWS = 300;

/** "Song · John Newton": the kind in words and the author, the row's second line. */
function rowMeta(p: Presentation): string {
  const kind = t(`kind.${p.kind}` as MessageKey);
  return p.meta.author ? `${kind} · ${p.meta.author}` : kind;
}

/**
 * The Library tab in P0 (design/28 §2.2; owner question 6's minimum, which P1's Library with bottom search
 * replaces): a search field at the top, never focused on open; the presentations the core worker's index finds
 * (archived ones left out), each one 56 px row that opens its slide previews. Read-only: no New, Edit, Archive
 * or Delete.
 */
export function LibraryP0() {
  const [q, setQ] = useState('');
  const presentations = useLibrary((s) => s.data.presentations);
  // Nothing from the phone's copy or the hub yet (an offline start without a copy): not "No songs yet".
  const loaded = useLibrary((s) => s.loaded);
  const hits = useSearch(q, { kind: 'presentation' });
  const locked = useLockedIds();
  const byId = useMemo(() => new Map(presentations.map((p) => [p.id, p])), [presentations]);
  const list = useMemo(
    () => hits.map((h) => byId.get(h.id)).filter((p): p is Presentation => !!p && !p.archived),
    [hits, byId],
  );
  const empty = !presentations.some((p) => !p.archived);
  const query = q.trim();
  return (
    <div className="compact-body" data-compact-library>
      {loaded && !empty && (
        <div className="compact-search">
          <input
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            placeholder={t('library.search')}
            aria-label={t('library.searchLabel')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      )}
      {!loaded ? (
        <p className="compact-empty" data-not-loaded>
          {t('library.notLoaded')}
        </p>
      ) : empty ? (
        <p className="compact-empty">{t('library.empty')}</p>
      ) : !list.length && query ? (
        <p className="compact-empty">{t('library.noMatch', { q: query.slice(0, 100) })}</p>
      ) : (
        <ul className="compact-list">
          {list.slice(0, MAX_ROWS).map((p) => (
            <li key={p.id}>
              <a className="compact-row" href={`#/previews/${encodeURIComponent(p.id)}`}>
                <span className="compact-row-text">
                  <span className="compact-row-title" dir="auto">
                    {p.title}
                  </span>
                  <span className="compact-row-meta" dir="auto">
                    {rowMeta(p)}
                  </span>
                </span>
                {locked.has(p.id) && <span className="tag red">{t('library.locked')}</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
      {list.length > MAX_ROWS && (
        <p className="compact-note">{t('library.more', { n: list.length - MAX_ROWS })}</p>
      )}
    </div>
  );
}
