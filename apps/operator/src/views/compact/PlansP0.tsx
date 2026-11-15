import type { Playlist } from '@ordo/domain';
import { useMemo } from 'react';
import { useLivePlaylistId, useMediaLookup, usePresentationLookup } from '../../hooks.ts';
import { formatDate, t } from '../../i18n/index.ts';
import { itemSubtitle, itemTitle } from '../../lib/playlistItems.ts';
import { useLibrary } from '../../state/library.ts';

/** "Sun 22 Nov · 6 items" (just the count for a plan without a date). */
function planMeta(p: Playlist): string {
  const items = t('plans.items', { n: p.items.length });
  return p.serviceDate ? t('plans.rowMeta', { date: formatDate(p.serviceDate), items }) : items;
}

/** The plans, newest service first (the venue PC's order: PlaylistsView). */
function PlanList({ playlists, liveId }: { playlists: Playlist[]; liveId: string | undefined }) {
  const sorted = useMemo(
    () =>
      [...playlists].sort(
        (a, b) => (b.serviceDate ?? '').localeCompare(a.serviceDate ?? '') || a.name.localeCompare(b.name),
      ),
    [playlists],
  );
  if (!sorted.length)
    return (
      <div className="compact-body" data-compact-plans>
        <p className="compact-empty">{t('plans.empty')}</p>
      </div>
    );
  return (
    <div className="compact-body" data-compact-plans>
      <ul className="compact-list">
        {sorted.map((p) => (
          <li key={p.id}>
            <a className="compact-row" href={`#/playlists/${encodeURIComponent(p.id)}`}>
              <span className="compact-row-text">
                <span className="compact-row-title" dir="auto">
                  {p.name}
                </span>
                <span className="compact-row-meta">{planMeta(p)}</span>
                {p.id === liveId && (
                  <span className="compact-live" data-plan-live>
                    <span className="dot red sm" aria-hidden="true" /> {t('plans.live')}
                  </span>
                )}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One plan: its items in order; a presentation opens its previews. */
function PlanDetail({ plan, live }: { plan: Playlist; live: boolean }) {
  const presentation = usePresentationLookup();
  const media = useMediaLookup();
  const op = useMemo(() => ({ presentation, media }), [presentation, media]);
  return (
    <div className="compact-body" data-compact-plan>
      {live && (
        <p className="compact-banner" data-plan-live role="status">
          <span className="dot red sm" aria-hidden="true" /> {t('plans.liveBanner')}
        </p>
      )}
      <p className="compact-note">{planMeta(plan)}</p>
      {!plan.items.length ? (
        <p className="compact-empty">{t('plans.noItems')}</p>
      ) : (
        <ol className="compact-list compact-items">
          {plan.items.map((it, i) => {
            const text = (
              <>
                <span className="compact-num" aria-hidden="true">
                  {i + 1}
                </span>
                <span className="compact-row-text">
                  <span className="compact-row-title" dir="auto">
                    {itemTitle(it, op)}
                  </span>
                  {itemSubtitle(it, op) && (
                    <span className="compact-row-meta" dir="auto">
                      {itemSubtitle(it, op)}
                    </span>
                  )}
                </span>
              </>
            );
            return (
              <li key={it.id}>
                {it.kind === 'presentation' && presentation(it.presentationId) ? (
                  <a className="compact-row" href={`#/previews/${encodeURIComponent(it.presentationId)}`}>
                    {text}
                  </a>
                ) : (
                  <div className="compact-row static">{text}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

/**
 * The Plans tab in P0 (design/28 §2.2; P1's Plans and Plan with readiness replace it): the plans with their date
 * and item count and the one live at the venue marked; a plan's detail lists its items, numbered, and says when
 * it is live (locked until the service ends). Read-only: plans are made and changed on a computer or an iPad.
 */
export function PlansP0({ id }: { id?: string }) {
  const playlists = useLibrary((s) => s.data.playlists);
  const loaded = useLibrary((s) => s.loaded);
  const liveId = useLivePlaylistId();
  if (!loaded)
    return (
      <div className="compact-body">
        <p className="compact-empty" data-not-loaded>
          {t('library.notLoaded')}
        </p>
      </div>
    );
  if (!id) return <PlanList playlists={playlists} liveId={liveId} />;
  const plan = playlists.find((p) => p.id === id);
  if (!plan)
    return (
      <div className="compact-body">
        <p className="compact-empty">{t('plans.missing')}</p>
      </div>
    );
  return <PlanDetail plan={plan} live={plan.id === liveId} />;
}
