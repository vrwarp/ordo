import { firstText, type Media, type Presentation, type Section, type Slide } from '@ordo/domain';
import { useMemo } from 'react';
import { useMediaLookup, useVisible } from '../hooks.ts';
import { stillHash, useThumb } from '../services/thumbs.ts';

export function getSectionSlides(s: Section): { id: string; text: string }[] {
  return (s.slides ?? []).map((sl) => {
    const lines: string[] = [];
    for (const obj of sl.objects ?? []) {
      if (obj.type === 'text' && obj.text?.trim()) {
        lines.push(obj.text.trim());
      }
    }
    return { id: sl.id, text: lines.join('\n') };
  });
}

function SlideMiniThumb({
  slide,
  p,
  index,
  media,
  compact,
}: {
  slide: Slide;
  p: Presentation;
  index: number;
  media: (id: string) => Media | undefined;
  compact: boolean;
}) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const bgId = slide.backgroundMediaId ?? p.backgroundMediaId;
  const bg = bgId ? stillHash(media(bgId)) : undefined;
  const url = useThumb(
    slide,
    {
      isSong: p.kind === 'song',
      bg,
      media,
      width: 480,
    },
    visible,
  );

  const text = firstText(slide);
  // Large thumbnails (twice as big): 272x153 for library, 224x126 in playlist sidebar (exact 16:9)
  const cardWidth = compact ? 224 : 272;
  const cardHeight = compact ? 126 : 153;

  return (
    <div
      ref={ref}
      className="col"
      style={{
        width: cardWidth,
        flexShrink: 0,
        gap: 4,
      }}
    >
      <div
        style={{
          width: cardWidth,
          height: cardHeight,
          borderRadius: 6,
          overflow: 'hidden',
          background: '#0a0b0d',
          border: '1.5px solid var(--line)',
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {url ? (
          <img
            src={url}
            alt={text || `Slide ${index + 1}`}
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        ) : (
          <div
            style={{
              padding: 6,
              fontSize: compact ? 11 : 12,
              color: 'var(--fg3)',
              textAlign: 'center',
              lineHeight: 1.3,
              overflow: 'hidden',
              maxHeight: '100%',
              userSelect: 'none',
            }}
          >
            {text ? text.slice(0, 60) : `${index + 1}`}
          </div>
        )}
        <span
          style={{
            position: 'absolute',
            bottom: 5,
            right: 6,
            background: 'rgba(0,0,0,0.85)',
            fontSize: compact ? 10 : 11,
            fontWeight: 700,
            padding: '2px 6px',
            borderRadius: 5,
            color: '#fff',
            lineHeight: 1.2,
            userSelect: 'none',
          }}
        >
          {index + 1}
        </span>
      </div>
      {text && (
        <span
          className="muted ellipsis"
          style={{
            fontSize: compact ? 10.5 : 11.5,
            lineHeight: 1.25,
            width: cardWidth,
            userSelect: 'none',
          }}
          title={text}
        >
          {text}
        </span>
      )}
    </div>
  );
}

export function SlidePreviewRoll({
  p,
  compact = false,
  onAddArrangement,
}: {
  p: Presentation;
  compact?: boolean;
  onAddArrangement?: (arrangementId?: string) => void;
}) {
  const media = useMediaLookup();
  const byId = useMemo(() => new Map(p.sections.map((s) => [s.id, s])), [p.sections]);

  const entries = useMemo(() => {
    const authoring = p.sections.map((s, index) => ({ s, key: s.id, index }));
    if (p.arrangements.length === 0) {
      return [
        {
          key: 'authoring',
          id: undefined as string | undefined,
          name: 'Authoring order',
          isDefault: false,
          orderedSections: authoring,
        },
      ];
    }
    return p.arrangements.map((arr, idx) => {
      const orderedSections =
        arr.sectionIds.length > 0
          ? (arr.sectionIds
              .map((id, index) => {
                const s = byId.get(id);
                return s ? { s, key: `${id}-${index}`, index } : null;
              })
              .filter(Boolean) as { s: Section; key: string; index: number }[])
          : authoring;
      return {
        key: arr.id,
        id: arr.id as string | undefined,
        name: arr.name,
        isDefault: idx === 0 && p.arrangements.length > 1,
        orderedSections,
      };
    });
  }, [p.arrangements, byId, p.sections]);

  return (
    <div className="col" style={{ gap: compact ? 10 : 14, width: '100%', minHeight: 0 }}>
      {entries.map((entry, entryIdx) => {
        const slideCount = entry.orderedSections.reduce((acc, { s }) => acc + (s.slides?.length ?? 0), 0);
        return (
          <div
            key={entry.key}
            className="col"
            style={{
              gap: compact ? 6 : 8,
              width: '100%',
              paddingTop: entryIdx > 0 ? (compact ? 10 : 12) : 0,
              borderTop: entryIdx > 0 ? '1px solid var(--line)' : 'none',
            }}
          >
            {/* Arrangement header row */}
            <div
              className="row"
              style={{
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                fontSize: compact ? 11 : 12,
                flexShrink: 0,
              }}
            >
              <div className="row" style={{ alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 }}>
                <span className="ellipsis" style={{ color: 'var(--fg)', fontWeight: 600 }}>
                  {entry.name}
                  {entry.isDefault && (
                    <span className="muted" style={{ fontWeight: 400, marginLeft: 5 }}>
                      (default)
                    </span>
                  )}
                </span>
                <span className="muted small" style={{ opacity: 0.8, flexShrink: 0 }}>
                  {entry.orderedSections.length} {entry.orderedSections.length === 1 ? 'sec' : 'secs'} ·{' '}
                  {slideCount} {slideCount === 1 ? 'slide' : 'slides'}
                </span>
              </div>

              {onAddArrangement && (
                <button
                  type="button"
                  className="small primary"
                  style={{ flexShrink: 0 }}
                  onClick={() => onAddArrangement(entry.id)}
                >
                  Add
                </button>
              )}
            </div>

            {/* Slide preview horizontal filmstrip grouped by section */}
            <div
              className="row"
              style={{
                gap: compact ? 10 : 14,
                overflowX: 'auto',
                overflowY: 'hidden',
                paddingBottom: 6,
                alignItems: 'flex-start',
                flexShrink: 0,
              }}
            >
              {entry.orderedSections.length === 0 ? (
                <div className="muted small" style={{ fontStyle: 'italic', padding: 8 }}>
                  No slides in this presentation.
                </div>
              ) : (
                entry.orderedSections.map(({ s, key }, secIdx) => {
                  const slides = s.slides ?? [];
                  return (
                    <div
                      key={key}
                      className="col"
                      style={{
                        gap: 4,
                        flexShrink: 0,
                        paddingRight: secIdx < entry.orderedSections.length - 1 ? (compact ? 8 : 12) : 0,
                        borderRight:
                          secIdx < entry.orderedSections.length - 1 ? '1px solid var(--line)' : 'none',
                      }}
                    >
                      <div className="row" style={{ alignItems: 'center', gap: 5 }}>
                        <span
                          className="tag"
                          style={{
                            fontSize: 9.5,
                            fontWeight: 700,
                            padding: '2.5px 7px',
                          }}
                        >
                          {s.short || s.label}
                        </span>
                        <span
                          className="small bold ellipsis"
                          style={{ color: 'var(--fg)', fontSize: 11, maxWidth: compact ? 130 : 180 }}
                        >
                          {s.label}
                        </span>
                      </div>

                      <div className="row" style={{ gap: compact ? 6 : 8 }}>
                        {slides.map((sl, slideIdx) => (
                          <SlideMiniThumb
                            key={sl.id}
                            slide={sl}
                            p={p}
                            index={slideIdx}
                            media={media}
                            compact={compact}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Approximate height (px) of a stacked SlidePreviewRoll for VirtualList expanded row sizing. */
export function slidePreviewRollHeight(p: Presentation | undefined, compact = false): number {
  const count = Math.max(1, p?.arrangements.length ?? 1);
  if (compact) return 150 + count * 240;
  return 145 + count * 275;
}
