import { type Cue, type PlaylistItem, type Slide, isHiddenCue } from '@ordo/domain';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { armDot, waitingForLive } from '../../lib/health.ts';
import { type CueGroup, groupCues, sectionGoTarget } from '../../lib/sections.ts';
import { slideMediaTags } from '../../lib/slideMedia.ts';
import { controller } from '../../services/controller.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { setUi, useUi } from '../../state/ui.ts';
import { KIND_ICON, itemSubtitle, itemTitle } from './PlaylistPane.tsx';
import { SlideThumb, type ThumbMarks } from './SlideThumb.tsx';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

/** What the tag of a hidden slide says to a pointer or a screen reader. */
const HIDDEN_TITLE = 'Hidden slide: Next skips it; click it to show it';

/**
 * A single playlist item in the continuous playlist scroll view (ProPresenter-style).
 * Displays an item header bar with title, kind, subtitle, on-air badge and actions, followed by its sections and slides.
 */
function PlaylistItemSection({
  item,
  itemIndex,
  op,
  cues,
  liveHere,
  thumbSize,
  isLiveItem,
  slideOf,
  marksFor,
  onClick,
  onDouble,
  headerRef,
}: {
  item: PlaylistItem;
  itemIndex: number;
  op: OperatorPlaylist;
  cues: Cue[];
  liveHere: boolean;
  thumbSize: number;
  isLiveItem: boolean;
  slideOf: (c: Cue) => Slide | undefined;
  marksFor: (c: Cue) => ThumbMarks;
  onClick: (c: Cue) => void;
  onDouble: (c: Cue) => void;
  headerRef: (el: HTMLElement | null) => void;
}) {
  const groups: CueGroup[] = useMemo(() => groupCues(cues), [cues]);
  const presentation = item.kind === 'presentation' ? op.presentation(item.presentationId) : undefined;
  const isSong = presentation?.kind === 'song';
  const subtitle = itemSubtitle(item, op);
  const ctl = controller();

  return (
    <div className="playlist-item-section" data-playlist-item-index={itemIndex} ref={headerRef}>
      <div className={`playlist-item-head ${isLiveItem ? 'live-item' : ''}`}>
        <div className="row" style={{ alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
          <span className="kind-badge" title={item.kind}>
            {KIND_ICON[item.kind]}
          </span>
          <span className="bold ellipsis">{itemTitle(item, op)}</span>
          {subtitle && <span className="muted small ellipsis">{subtitle}</span>}
          {isLiveItem && <span className="live-pill-mini">ON AIR</span>}
        </div>
        <div className="row" style={{ alignItems: 'center', gap: 6 }}>
          {presentation && (
            <a className="btn small" href={`#/edit/${presentation.id}`}>
              Edit
            </a>
          )}
        </div>
      </div>

      {groups.map((g) => (
        <div key={g.pos}>
          {g.pos >= 0 && (
            <div className="section-head">
              <button
                type="button"
                className="small"
                disabled={!liveHere}
                onClick={() => {
                  // GO by cue index: the section shown may belong to an item that is not live.
                  const i = sectionGoTarget(g);
                  if (liveHere && i !== undefined) ctl?.go(i);
                }}
                title="Go to the first slide of this section"
              >
                {g.short || g.label}
              </button>
              <span className="muted">{g.label}</span>
            </div>
          )}
          <div
            className="slide-grid"
            style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))` }}
          >
            {g.cues.map((c) => {
              const marks = marksFor(c);
              if (c.kind === 'slide') {
                const slide = slideOf(c);
                // A slide that plays a video in place or its own sound says so (design/27 §11 item 14).
                const tags = slideMediaTags(slide, op.media);
                // A hidden slide (design/27 §9) is dimmed and tagged, and a click still shows it.
                const hidden = isHiddenCue(c);
                return (
                  <SlideThumb
                    key={c.index}
                    slide={slide}
                    isSong={isSong}
                    bgMediaId={c.backgroundMediaId}
                    media={op.media}
                    label={c.label}
                    number={(c.slideIndexInSection ?? 0) + 1}
                    marks={marks}
                    width={thumbSize}
                    hidden={hidden}
                    onClick={() => onClick(c)}
                    onDoubleClick={() => onDouble(c)}
                    footer={
                      tags.length > 0 || hidden ? (
                        <>
                          {hidden && (
                            <span className="tag" title={HIDDEN_TITLE} data-hidden-slide>
                              hidden
                            </span>
                          )}
                          {tags.map((t) => (
                            <span key={t.kind} className={t.notice ? 'tag amber' : 'tag'} title={t.title}>
                              {t.kind}
                            </span>
                          ))}
                        </>
                      ) : undefined
                    }
                  />
                );
              }
              return (
                <SlideThumb
                  key={c.index}
                  bgMediaId={c.mediaId}
                  media={op.media}
                  isSong={false}
                  label={c.label}
                  marks={marks}
                  width={thumbSize}
                  onClick={() => onClick(c)}
                  onDoubleClick={() => onDouble(c)}
                  footer={<span className="tag">{c.kind === 'media' ? c.mediaKind : c.kind}</span>}
                />
              );
            })}
          </div>
        </div>
      ))}
      {cues.length === 0 && (
        <div className="muted small" style={{ padding: '6px 4px 12px' }}>
          Nothing to show for this item.
        </div>
      )}
    </div>
  );
}

/**
 * The main operator slide area: renders all items of the current playlist in a continuous vertical scroll,
 * allowing smooth scrolling between playlist items (like ProPresenter).
 */
export function SlideGrid({ op, viewItem }: { op: OperatorPlaylist; viewItem?: number }) {
  const state = useLive((s) => s.state);
  const health = useLive((s) => s.health);
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const { thumbSize, clickToGo, followLive } = useUi();
  const audienceOutputs = outputs.filter((o) => o.enabled);
  const ctl = controller();
  const liveHere = op.live;
  const items = op.playlist?.items ?? [];

  const scrollPaneRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const isProgrammaticScroll = useRef(false);
  const scrollTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const liveItem = useLive((s) => {
    const i = s.state.live ?? s.state.armed;
    return i !== undefined ? s.state.cues[i]?.itemIndex : undefined;
  });

  // Group cues by itemIndex
  const cuesByItem = useMemo(() => {
    const map = new Map<number, Cue[]>();
    for (const c of op.cues) {
      const arr = map.get(c.itemIndex);
      if (arr) arr.push(c);
      else map.set(c.itemIndex, [c]);
    }
    return map;
  }, [op.cues]);

  const scrollToItem = useUi((s) => s.scrollToItem);
  const lastHandledReq = useRef<number | null>(null);
  const mountedRef = useRef(false);

  // On initial mount, align with initial viewItem if specified and non-zero
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      if (viewItem && viewItem > 0) {
        const target = itemRefs.current[viewItem];
        if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' });
      }
    }
  }, [viewItem]);

  // When scrollToItem is requested externally (e.g. click in PlaylistPane), scroll that item into view
  useEffect(() => {
    if (!scrollToItem || scrollToItem.req === lastHandledReq.current) return;
    lastHandledReq.current = scrollToItem.req;
    const target = itemRefs.current[scrollToItem.index];
    if (target) {
      isProgrammaticScroll.current = true;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
      scrollTimeout.current = setTimeout(() => {
        isProgrammaticScroll.current = false;
      }, 500);
    }
  }, [scrollToItem]);

  // When scrolling in the grid, update viewItemIndex to the currently visible item
  const onScroll = useCallback(() => {
    if (isProgrammaticScroll.current) return;
    const container = scrollPaneRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    let activeIdx = 0;
    for (let i = 0; i < items.length; i++) {
      const el = itemRefs.current[i];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top <= containerTop + 80) {
        activeIdx = i;
      } else {
        break;
      }
    }
    if (useUi.getState().viewItemIndex !== activeIdx) {
      setUi({ viewItemIndex: activeIdx });
    }
  }, [items.length]);

  // If followLive is on, scroll the live slide thumbnail into view
  useEffect(() => {
    if (followLive && op.live && state.live !== undefined) {
      const el = scrollPaneRef.current?.querySelector('.thumb.live');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [followLive, op.live, state.live]);

  const marksFor = useCallback(
    (c: Cue): ThumbMarks => {
      if (!liveHere) return { live: false, armed: false };
      const live = state.live === c.index;
      const armed = state.armed === c.index;
      const dots =
        live || armed
          ? audienceOutputs.map((o) => ({
              id: o.id,
              name: o.name,
              dot: armDot(health[o.id], c.index, state),
            }))
          : undefined;
      const waiting = live && audienceOutputs.some((o) => waitingForLive(health[o.id], state));
      return { live, armed, dots, waiting };
    },
    [liveHere, state, audienceOutputs, health],
  );

  const onClick = useCallback(
    (c: Cue) => {
      if (!liveHere || !ctl) return;
      if (clickToGo) ctl.go(c.index);
      else ctl.select(c.index);
    },
    [liveHere, ctl, clickToGo],
  );

  const onDouble = useCallback(
    (c: Cue) => {
      if (liveHere && ctl) ctl.go(c.index);
    },
    [liveHere, ctl],
  );

  const slideOf = useCallback(
    (c: Cue) => {
      if (!c.presentationId || !c.slideId) return undefined;
      const p = op.presentation(c.presentationId);
      for (const s of p?.sections ?? []) for (const sl of s.slides) if (sl.id === c.slideId) return sl;
      return undefined;
    },
    [op],
  );

  if (items.length === 0)
    return (
      <div className="pane" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="pane-head">
          <b className="grow ellipsis">{op.playlist?.name ?? 'Live'}</b>
        </div>
        <div className="muted" style={{ padding: 20 }}>
          {op.playlist ? 'This playlist is empty.' : 'Select a playlist.'}
        </div>
      </div>
    );

  return (
    <div
      ref={scrollPaneRef}
      onScroll={onScroll}
      className="pane"
      data-slide-grid-pane
      style={{ display: 'flex', flexDirection: 'column' }}
    >
      <div className="pane-head">
        <b className="grow ellipsis">{op.playlist?.name ?? 'Playlist'}</b>
        <label className="check small" title="Single click goes live instead of arming">
          <input
            type="checkbox"
            checked={clickToGo}
            onChange={(e) => setUi({ clickToGo: e.target.checked })}
          />
          Click = GO
        </label>
        <label className="check small">
          <input
            type="checkbox"
            checked={followLive}
            onChange={(e) => setUi({ followLive: e.target.checked })}
          />
          Follow live
        </label>
        <input
          type="range"
          min={140}
          max={360}
          step={20}
          value={thumbSize}
          onChange={(e) => setUi({ thumbSize: Number(e.target.value) })}
          title="Thumbnail size"
          style={{ width: 90 }}
        />
      </div>

      <div className="slides">
        {!liveHere && (
          <div className="banner blue" style={{ marginBottom: 12 }}>
            Preview. Go live with this playlist to control the outputs.
          </div>
        )}
        {items.map((it, itemIdx) => (
          <PlaylistItemSection
            key={it.id}
            item={it}
            itemIndex={itemIdx}
            op={op}
            cues={cuesByItem.get(itemIdx) ?? []}
            liveHere={liveHere}
            thumbSize={thumbSize}
            isLiveItem={op.live && liveItem === itemIdx}
            slideOf={slideOf}
            marksFor={marksFor}
            onClick={onClick}
            onDouble={onDouble}
            headerRef={(el) => {
              itemRefs.current[itemIdx] = el;
            }}
          />
        ))}
      </div>
    </div>
  );
}
