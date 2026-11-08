import { type Cue, isHiddenCue } from '@ordo/domain';
import { useMemo } from 'react';
import { armDot, waitingForLive } from '../../lib/health.ts';
import { groupCues, sectionGoTarget } from '../../lib/sections.ts';
import { slideMediaTags } from '../../lib/slideMedia.ts';
import { controller } from '../../services/controller.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { setUi, useUi } from '../../state/ui.ts';
import { itemTitle } from './PlaylistPane.tsx';
import { SlideThumb, type ThumbMarks } from './SlideThumb.tsx';
import type { OperatorPlaylist } from './useOperatorPlaylist.ts';

/** What the tag of a hidden slide says to a pointer or a screen reader. */
const HIDDEN_TITLE = 'Hidden slide: Next skips it; click it to show it';

export function SlideGrid({ op, viewItem }: { op: OperatorPlaylist; viewItem: number }) {
  const state = useLive((s) => s.state);
  const health = useLive((s) => s.health);
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const { thumbSize, clickToGo } = useUi();
  const item = op.playlist?.items[viewItem];
  const cues = useMemo(() => op.cues.filter((c) => c.itemIndex === viewItem), [op.cues, viewItem]);
  const groups = useMemo(() => groupCues(cues), [cues]);
  const audienceOutputs = outputs.filter((o) => o.enabled);
  const presentation = item?.kind === 'presentation' ? op.presentation(item.presentationId) : undefined;
  const isSong = presentation?.kind === 'song';
  const ctl = controller();
  const liveHere = op.live;

  const marksFor = (c: Cue): ThumbMarks => {
    if (!liveHere) return { live: false, armed: false };
    const live = state.live === c.index;
    const armed = state.armed === c.index;
    const dots =
      live || armed
        ? audienceOutputs.map((o) => ({ id: o.id, name: o.name, dot: armDot(health[o.id], c.index, state) }))
        : undefined;
    const waiting = live && audienceOutputs.some((o) => waitingForLive(health[o.id], state));
    return { live, armed, dots, waiting };
  };
  const onClick = (c: Cue) => {
    if (!liveHere || !ctl) return;
    if (clickToGo) ctl.go(c.index);
    else ctl.select(c.index);
  };
  const onDouble = (c: Cue) => {
    if (liveHere && ctl) ctl.go(c.index);
  };

  if (!item)
    return (
      <div className="muted" style={{ padding: 20 }}>
        Select a playlist item.
      </div>
    );
  const slideOf = (c: Cue) => {
    if (!c.presentationId || !c.slideId) return undefined;
    const p = op.presentation(c.presentationId);
    for (const s of p?.sections ?? []) for (const sl of s.slides) if (sl.id === c.slideId) return sl;
    return undefined;
  };
  return (
    <div className="pane" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="pane-head">
        <b className="grow ellipsis">{itemTitle(item, op)}</b>
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
            checked={useUi.getState().followLive}
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
        {presentation && (
          <a className="btn small" href={`#/edit/${presentation.id}`}>
            Edit
          </a>
        )}
      </div>
      <div className="slides">
        {!liveHere && (
          <div className="banner blue" style={{ marginBottom: 10 }}>
            Preview. Go live with this playlist to control the outputs.
          </div>
        )}
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
        {cues.length === 0 && <div className="muted">Nothing to show for this item.</div>}
      </div>
    </div>
  );
}
