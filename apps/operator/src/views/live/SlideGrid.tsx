import { api } from '@ordo/client';
import {
  type Arrangement,
  type Cue,
  firstText,
  type Playlist,
  type PlaylistItem,
  type Slide,
  type TextObject,
  isHiddenCue,
  withoutBackdrops,
} from '@ordo/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Icon, playlistItemIconName } from '../../components/Icons.tsx';
import { InlineArrangementStrip } from '../../components/InlineArrangementStrip.tsx';
import { armDot, waitingForLive } from '../../lib/health.ts';
import { itemSubtitle, itemTitle } from '../../lib/playlistItems.ts';
import { sectionTone } from '../../lib/sectionColors.ts';
import { type CueGroup, groupCues, sectionGoTarget } from '../../lib/sections.ts';
import { slideMediaTags } from '../../lib/slideMedia.ts';
import { controller, dispatch } from '../../services/controller.ts';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { updatePlaylistDraft } from '../../state/playlistOutbox.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { requestScrollToPlaylistItem, setUi, useUi } from '../../state/ui.ts';
import { navigate } from '../../useRoute.ts';
import { ItemSettings } from '../playlists/ItemSettings.tsx';
import { SlideThumb, type ThumbMarks } from './SlideThumb.tsx';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

/** What the tag of a hidden slide says to a pointer or a screen reader. */
const HIDDEN_TITLE = 'Hidden slide: Next skips it; click it to show it';

type HotfixTarget = {
  presentationId: string;
  slideId: string;
  objectId: string;
  label: string;
  initialText: string;
};

/** Primary editable text object on a native slide (excludes whole-slide pre-rendered pictures). */
function editableTextObject(slide: Slide | undefined): TextObject | undefined {
  if (!slide || slide.pptx?.class === 'picture') return undefined;
  if (slide.lyricObjectId) {
    const o = slide.objects.find((x): x is TextObject => x.id === slide.lyricObjectId && x.type === 'text');
    if (o) return o;
  }
  return slide.objects.find((x): x is TextObject => x.type === 'text');
}

/**
 * Keyboard-safe inline typo hotfix card (ADR 0015).
 * `data-keys="off"` plus capture-phase Escape handling guarantees pressing Esc only closes the text box
 * and never fires Clear slide, while warning the volunteer that Space types inside the field.
 */
function SlideTextHotfixCard({
  target,
  onSave,
  onClose,
}: {
  target: HotfixTarget;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(target.initialText);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyCapture, true);
    return () => window.removeEventListener('keydown', onKeyCapture, true);
  }, [onClose]);

  return (
    <div
      className="card col"
      data-keys="off"
      data-hotfix-card
      style={{
        gap: 8,
        marginBottom: 12,
        border: '1px solid var(--amber, #f59e0b)',
        background: 'var(--bg2)',
      }}
    >
      <div
        className="row"
        style={{
          gap: 8,
          alignItems: 'center',
          padding: '6px 8px',
          borderRadius: 6,
          background: 'rgba(245, 158, 11, 0.14)',
          fontSize: 12,
        }}
      >
        <span className="dot amber" />
        <span className="grow">
          <b>Typing in slide hotfix</b> ({target.label}) — Space types here; press <b>Esc</b> or <b>Done</b>{' '}
          to restore slide keys (Stream Deck still works).
        </span>
      </div>
      <textarea
        ref={inputRef}
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ width: '100%', fontFamily: 'inherit', fontSize: 14, resize: 'vertical' }}
      />
      <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="small" onClick={onClose}>
          Cancel (Esc)
        </button>
        <button
          type="button"
          className="primary small"
          onClick={() => {
            onSave(text);
            onClose();
          }}
        >
          Save &amp; Done
        </button>
      </div>
    </div>
  );
}

/**
 * A single playlist item in the continuous playlist scroll view (ProPresenter-style).
 * Displays an item header bar with title, kind, subtitle, on-air badge and actions, optional song
 * arrangement strip, collapsible item settings popover, and its sections and slides.
 */
function PlaylistItemSection({
  item,
  itemIndex,
  op,
  cues,
  liveHere,
  clickToGo,
  thumbSize,
  isLiveItem,
  isActiveItem,
  slideOf,
  marksFor,
  onClick,
  onDouble,
  onUpdatePreviewItem,
  onSaveArrangement,
  onArrangeOpenChange,
  onStartHotfix,
  headerRef,
}: {
  item: PlaylistItem;
  itemIndex: number;
  op: OperatorPlaylist;
  cues: Cue[];
  liveHere: boolean;
  clickToGo: boolean;
  thumbSize: number;
  isLiveItem: boolean;
  isActiveItem: boolean;
  slideOf: (c: Cue) => Slide | undefined;
  marksFor: (c: Cue) => ThumbMarks;
  onClick: (c: Cue) => void;
  onDouble: (c: Cue) => void;
  onUpdatePreviewItem: (fn: (it: PlaylistItem) => PlaylistItem) => void;
  onSaveArrangement: (presentationId: string, a: Arrangement) => Promise<boolean>;
  onArrangeOpenChange: (open: boolean) => void;
  onStartHotfix: (target: HotfixTarget) => void;
  headerRef: (el: HTMLElement | null) => void;
}) {
  const [showSettings, setShowSettings] = useState(false);
  const [showArrange, setShowArrange] = useState(false);
  const groups: CueGroup[] = useMemo(() => groupCues(cues), [cues]);
  const presentation = item.kind === 'presentation' ? op.presentation(item.presentationId) : undefined;
  const isSong = presentation?.kind === 'song';
  const hasCustomOrder = item.kind === 'presentation' && item.sections !== undefined;
  const subtitle = itemSubtitle(item, op);
  const ctl = controller();
  const skipped = item.skipped === true;

  const toggleHiddenSlide = (slideId: string) => {
    if (item.kind !== 'presentation') return;
    const cur = item.hiddenSlides ?? [];
    const next = cur.includes(slideId) ? cur.filter((id) => id !== slideId) : [...cur, slideId];
    if (liveHere) {
      ctl?.hideItemSlides(item.id, next);
    } else {
      onUpdatePreviewItem((it) => {
        if (it.kind !== 'presentation') return it;
        if (!next.length) {
          const { hiddenSlides: _h, ...rest } = it;
          return rest;
        }
        return { ...it, hiddenSlides: next };
      });
    }
  };

  return (
    <div
      className="playlist-item-section"
      data-playlist-item-index={itemIndex}
      ref={headerRef}
      style={skipped ? { opacity: 0.6 } : undefined}
    >
      <div className={`playlist-item-head ${isLiveItem ? 'live-item' : ''}`}>
        <div className="row" style={{ alignItems: 'center', gap: 7, flex: 1, minWidth: 0 }}>
          <span className="muted small" style={{ minWidth: 16, fontVariantNumeric: 'tabular-nums' }}>
            {itemIndex + 1}
          </span>
          <span className="kind-badge" title={item.kind}>
            <Icon name={playlistItemIconName(item.kind, presentation?.kind)} size={12} />
          </span>
          <span className="bold ellipsis" style={skipped ? { textDecoration: 'line-through' } : undefined}>
            {itemTitle(item, op)}
          </span>
          {subtitle && <span className="muted small ellipsis">{subtitle}</span>}
          {isLiveItem && <span className="live-pill-mini">ON AIR</span>}
          {skipped && (
            <span className="tag" style={{ fontSize: 10 }}>
              Skipped
            </span>
          )}
        </div>
        <div className="row" style={{ alignItems: 'center', gap: 4 }}>
          {isSong && presentation && presentation.sections.length > 0 && item.kind === 'presentation' && (
            <button
              type="button"
              className={showArrange || hasCustomOrder ? 'on small' : 'ghost small'}
              onClick={() => setShowArrange((v) => !v)}
              title="Show or hide song section order"
              data-arrange-strip-toggle={item.id}
            >
              <Icon name="arrange" size={12} />
              Arrange
            </button>
          )}
          <button
            type="button"
            className={showSettings ? 'primary icon-btn' : 'ghost icon-btn'}
            onClick={() => setShowSettings((v) => !v)}
            title={liveHere ? 'View item settings (read-only while live)' : 'Item settings'}
            aria-label={`Settings for ${itemTitle(item, op)}`}
            data-item-settings-toggle={item.id}
          >
            <Icon name="sliders" size={13} />
          </button>
          {presentation && (
            <a className="btn small" href={`#/edit/${presentation.id}`}>
              <Icon name="edit" size={11} />
              Edit
            </a>
          )}
        </div>
      </div>

      {isSong &&
        presentation &&
        presentation.sections.length > 0 &&
        item.kind === 'presentation' &&
        (showArrange || hasCustomOrder) && (
          <InlineArrangementStrip
            presentation={presentation}
            arrangementId={item.arrangementId}
            sectionsOverride={item.sections}
            liveMode={liveHere}
            locked={liveHere && isActiveItem}
            hideLiveToggle={showArrange}
            onArrangeOpenChange={onArrangeOpenChange}
            onChangeSections={(sections) => {
              if (liveHere) {
                ctl?.arrangeItem(item.id, sections);
              } else {
                onUpdatePreviewItem((it) => {
                  if (it.kind !== 'presentation') return it;
                  if (sections === null) {
                    const { sections: _s, ...rest } = it;
                    return rest;
                  }
                  return { ...it, sections };
                });
              }
            }}
          />
        )}

      {showSettings && (
        <div
          style={{
            margin: '4px 0 8px',
            border: '1px solid var(--line)',
            borderRadius: 3,
            background: 'var(--bg2)',
          }}
          data-item-settings-popover={item.id}
        >
          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '5px 8px',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <span className="muted small">
              {liveHere ? 'Item settings (read-only while live)' : 'Item settings'}
            </span>
            <button
              type="button"
              className="ghost icon-btn"
              onClick={() => setShowSettings(false)}
              aria-label="Close"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <ItemSettings
            item={item}
            disabled={liveHere}
            onChange={(next) => onUpdatePreviewItem(() => next)}
            onSaveArrangement={onSaveArrangement}
          />
        </div>
      )}

      <div
        className="slide-grid"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${thumbSize}px, 1fr))` }}
      >
        {groups.flatMap((g) => {
          const tone = g.pos >= 0 ? sectionTone(g.label, g.short) : undefined;
          const jumpToSection = () => {
            const i = sectionGoTarget(g);
            if (!liveHere || i === undefined) return;
            if (isLiveItem || clickToGo) ctl?.go(i);
            else ctl?.select(i);
          };
          const doubleJumpToSection = () => {
            const i = sectionGoTarget(g);
            if (liveHere && i !== undefined) ctl?.go(i);
          };
          const openSectionMenu = (e: React.MouseEvent) => {
            e.stopPropagation();
            const target = sectionGoTarget(g);
            openContextMenu(
              e,
              [
                {
                  label: `Go to ${g.label}`,
                  disabled: !liveHere || target === undefined,
                  onSelect: () => {
                    if (liveHere && target !== undefined) ctl?.go(target);
                  },
                },
                {
                  label: `Arm ${g.label}`,
                  disabled: !liveHere || target === undefined,
                  onSelect: () => {
                    if (liveHere && target !== undefined) ctl?.select(target);
                  },
                },
                ...(presentation
                  ? [
                      { kind: 'separator' as const },
                      {
                        label: 'Edit presentation…',
                        onSelect: () => navigate(`#/edit/${presentation.id}`),
                      },
                    ]
                  : []),
              ],
              { ariaLabel: `Section ${g.label} actions` },
            );
          };
          return g.cues.map((c, idxInGroup) => {
            const marks = marksFor(c);
            const band =
              tone && g.pos >= 0
                ? {
                    label: g.label,
                    short: g.short,
                    tone,
                    isFirst: idxInGroup === 0,
                    onJump: liveHere ? jumpToSection : undefined,
                    onDoubleJump: liveHere ? doubleJumpToSection : undefined,
                    onContextMenu: openSectionMenu,
                  }
                : undefined;
            if (c.kind === 'slide') {
              const own = slideOf(c);
              const slide = c.backgroundOverride && own ? withoutBackdrops(own) : own;
              const tags = slideMediaTags(slide, op.media);
              const hidden = isHiddenCue(c);
              const hiddenByService =
                item.kind === 'presentation' && Boolean(c.slideId && item.hiddenSlides?.includes(c.slideId));
              const notesText = slide?.notes?.trim() ?? '';
              const hasNotes = notesText.length > 0;
              const slideText = slide ? firstText(slide).trim() : '';
              const editObj = liveHere && !marks.live ? editableTextObject(own) : undefined;
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
                  sectionBand={band}
                  onClick={() => onClick(c)}
                  onDoubleClick={() => onDouble(c)}
                  onContextMenu={(e) => {
                    openContextMenu(
                      e,
                      [
                        {
                          label: 'Go live (Take)',
                          disabled: !liveHere,
                          onSelect: () => ctl?.go(c.index),
                        },
                        {
                          label: 'Arm (Pre-load)',
                          disabled: !liveHere,
                          onSelect: () => ctl?.select(c.index),
                        },
                        ...(c.slideId && item.kind === 'presentation'
                          ? [
                              { kind: 'separator' as const },
                              {
                                label: hiddenByService
                                  ? 'Include slide in this service'
                                  : 'Skip slide in this service',
                                onSelect: () => toggleHiddenSlide(c.slideId!),
                              },
                            ]
                          : []),
                        ...(editObj && c.presentationId && c.slideId
                          ? [
                              {
                                label: 'Edit words (typo hotfix)…',
                                onSelect: () =>
                                  onStartHotfix({
                                    presentationId: c.presentationId!,
                                    slideId: c.slideId!,
                                    objectId: editObj.id,
                                    label: c.label,
                                    initialText: editObj.text,
                                  }),
                              },
                            ]
                          : []),
                        ...(marks.live
                          ? [
                              { kind: 'separator' as const },
                              {
                                label: 'Clear slide layer',
                                shortcut: 'Esc',
                                onSelect: () => dispatch({ id: 'clearSlide' }),
                              },
                            ]
                          : []),
                        ...(slideText
                          ? [
                              { kind: 'separator' as const },
                              {
                                label: 'Copy slide text',
                                onSelect: () => void navigator.clipboard?.writeText?.(slideText),
                              },
                            ]
                          : []),
                        ...(presentation
                          ? [
                              { kind: 'separator' as const },
                              {
                                label: 'Edit presentation…',
                                onSelect: () => navigate(`#/edit/${presentation.id}`),
                              },
                            ]
                          : []),
                      ],
                      { ariaLabel: `Slide ${c.label} actions` },
                    );
                  }}
                  footer={
                    tags.length > 0 || hidden || hasNotes ? (
                      <>
                        {hidden && (
                          <span className="tag" title={HIDDEN_TITLE} data-hidden-slide>
                            {hiddenByService ? 'skipped' : 'hidden'}
                          </span>
                        )}
                        {hasNotes && (
                          <span
                            className="tag notes"
                            title={`Speaker notes: ${notesText.slice(0, 160)}`}
                            data-slide-notes
                          >
                            notes
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
                onContextMenu={(e) => {
                  openContextMenu(
                    e,
                    [
                      {
                        label: 'Go live (Take)',
                        disabled: !liveHere,
                        onSelect: () => ctl?.go(c.index),
                      },
                      {
                        label: 'Arm (Pre-load)',
                        disabled: !liveHere,
                        onSelect: () => ctl?.select(c.index),
                      },
                      ...(marks.live && c.kind === 'media'
                        ? [
                            { kind: 'separator' as const },
                            {
                              label: c.mediaKind === 'audio' ? 'Clear audio' : 'Clear media layer',
                              onSelect: () => ctl?.clear(c.mediaKind === 'audio' ? 'audio' : 'media'),
                            },
                          ]
                        : []),
                    ],
                    { ariaLabel: `Cue ${c.label} actions` },
                  );
                }}
                footer={<span className="tag">{c.kind === 'media' ? c.mediaKind : c.kind}</span>}
              />
            );
          });
        })}
      </div>
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
  const lib = useLibrary((s) => s.data);
  const outputs = lib.settings.outputs;
  const { thumbSize, clickToGo, followLive } = useUi();
  const audienceOutputs = outputs.filter((o) => o.enabled);
  const ctl = controller();
  const liveHere = op.live;
  const items = op.playlist?.items ?? [];

  const [arrangingOpenCount, setArrangingOpenCount] = useState(0);
  const [hotfix, setHotfix] = useState<HotfixTarget | null>(null);

  const scrollPaneRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const isProgrammaticScroll = useRef(false);
  const scrollTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const liveItem = useLive((s) => {
    const i = s.state.live ?? s.state.armed;
    return i !== undefined ? s.state.cues[i]?.itemIndex : undefined;
  });

  const activeItemIndices = useMemo(() => {
    const set = new Set<number>();
    if (!op.live) return set;
    const add = (idx: number | undefined) => {
      if (idx === undefined) return;
      const itemIdx = state.cues[idx]?.itemIndex;
      if (itemIdx !== undefined) set.add(itemIdx);
    };
    add(state.live);
    add(state.layers.slide.content?.cueIndex);
    add(state.layers.media.content?.cueIndex);
    add(state.audio.content?.cueIndex);
    return set;
  }, [
    op.live,
    state.cues,
    state.live,
    state.layers.slide.content,
    state.layers.media.content,
    state.audio.content,
  ]);

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

  // If followLive is on (and operator is not actively arranging or typing a hotfix), scroll the live slide into view
  useEffect(() => {
    if (followLive && op.live && state.live !== undefined && arrangingOpenCount === 0 && !hotfix) {
      const el = scrollPaneRef.current?.querySelector('.thumb.live');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [followLive, op.live, state.live, arrangingOpenCount, hotfix]);

  const storedBase: Playlist | undefined = op.playlist
    ? (lib.playlists.find((p) => p.id === op.playlist!.id) ?? op.playlist)
    : undefined;

  const updatePreviewItem = useCallback(
    (itemId: string, fn: (it: PlaylistItem) => PlaylistItem) => {
      if (liveHere || !storedBase) return;
      updatePlaylistDraft(storedBase, (p) => ({
        ...p,
        items: p.items.map((it) => (it.id === itemId ? fn(it) : it)),
      }));
    },
    [liveHere, storedBase],
  );

  const saveArrangement = useCallback(
    async (presentationId: string, a: Arrangement): Promise<boolean> => {
      const p = lib.presentations.find((x) => x.id === presentationId);
      if (!p) return false;
      const i = p.arrangements.findIndex((x) => x.id === a.id);
      const arrangements =
        i >= 0 ? p.arrangements.map((x) => (x.id === a.id ? a : x)) : [...p.arrangements, a];
      try {
        const saved = await api<typeof p>(`/presentations/${p.id}`, {
          method: 'PUT',
          json: { ...p, arrangements },
        });
        upsertLocal('presentations', saved);
        return true;
      } catch (e) {
        toast(`Could not save the arrangement: ${errorText(e)}`, 'error');
        return false;
      }
    },
    [lib.presentations],
  );

  const handleArrangeOpenChange = useCallback((open: boolean) => {
    setArrangingOpenCount((c) => Math.max(0, c + (open ? 1 : -1)));
  }, []);

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

  const showBackToOnAir =
    op.live && liveItem !== undefined && (!followLive || viewItem !== liveItem || arrangingOpenCount > 0);

  if (items.length === 0)
    return (
      <div className="pane" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="pane-head">
          <b className="grow ellipsis">{op.playlist?.name ?? 'Live'}</b>
        </div>
        <div className="muted" style={{ padding: 20 }}>
          {op.playlist
            ? 'This playlist is empty. Use "+ Add" on the left to add items.'
            : 'Select a playlist.'}
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
        <b className="grow ellipsis" style={{ fontSize: 12.5 }}>
          {op.playlist?.name ?? 'Playlist'}
        </b>
        {showBackToOnAir && (
          <button
            type="button"
            className="primary small"
            onClick={() => {
              setUi({ followLive: true });
              if (liveItem !== undefined) requestScrollToPlaylistItem(liveItem);
              setUi({ followLive: true });
            }}
            data-back-to-on-air
          >
            <Icon name="arrowUp" size={11} />
            Back to ON AIR
          </button>
        )}
        <label className="check small" title="Single click goes live instead of arming" style={{ gap: 5 }}>
          <input
            type="checkbox"
            checked={clickToGo}
            onChange={(e) => setUi({ clickToGo: e.target.checked })}
          />
          Click = GO
        </label>
        <label className="check small" style={{ gap: 5 }}>
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
          max={320}
          step={20}
          value={thumbSize}
          onChange={(e) => setUi({ thumbSize: Number(e.target.value) })}
          title="Thumbnail size"
          aria-label="Thumbnail size"
          style={{ width: 82 }}
        />
      </div>

      <div className="slides">
        {hotfix && liveHere && (
          <SlideTextHotfixCard
            target={hotfix}
            onSave={(text) =>
              ctl?.editSlideText(hotfix.presentationId, hotfix.slideId, hotfix.objectId, text)
            }
            onClose={() => setHotfix(null)}
          />
        )}
        {items.map((it, itemIdx) => (
          <PlaylistItemSection
            key={it.id}
            item={it}
            itemIndex={itemIdx}
            op={op}
            cues={cuesByItem.get(itemIdx) ?? []}
            liveHere={liveHere}
            clickToGo={clickToGo}
            thumbSize={thumbSize}
            isLiveItem={op.live && liveItem === itemIdx}
            isActiveItem={activeItemIndices.has(itemIdx)}
            slideOf={slideOf}
            marksFor={marksFor}
            onClick={onClick}
            onDouble={onDouble}
            onUpdatePreviewItem={(fn) => updatePreviewItem(it.id, fn)}
            onSaveArrangement={saveArrangement}
            onArrangeOpenChange={handleArrangeOpenChange}
            onStartHotfix={setHotfix}
            headerRef={(el) => {
              itemRefs.current[itemIdx] = el;
            }}
          />
        ))}
      </div>
    </div>
  );
}
