import {
  type Arrangement,
  firstText,
  newId,
  type Presentation,
  type Section,
  type Slide,
} from '@ordo/domain';
import { type ReactNode, useMemo } from 'react';
import { authoringArrangement } from '../../lib/arrangement.ts';
import { useLibrary } from '../../state/library.ts';
import { BackgroundPicker } from './BackgroundPicker.tsx';
import { change, selectSlide, useEditor } from './editorStore.ts';
import { LookPreviews } from './LookPreviews.tsx';
import { applyTheme, newSlideFor, resetSlideToTheme, themeOf, updateSlide } from './ops.ts';

const STANDARD_SECTION_LABELS = [
  'Verse 1',
  'Verse 2',
  'Verse 3',
  'Verse 4',
  'Pre-Chorus',
  'Chorus',
  'Chorus 2',
  'Bridge',
  'Bridge 2',
  'Tag',
  'Intro',
  'Outro',
  'Instrumental',
  'Ending',
];

export function SongReflowEditor(props: {
  presentation: Presentation;
  readOnly: boolean;
  selectedSlideId?: string;
  onSwitchToCanvas: () => void;
  banners?: ReactNode;
}) {
  const { presentation: p, readOnly, selectedSlideId, onSwitchToCanvas, banners } = props;
  const themes = useLibrary((s) => s.data.themes);
  const theme = themeOf(p, themes);
  const ed = useEditor();

  const activeArrangement: Arrangement = useMemo(() => {
    return p.arrangements[0] ?? authoringArrangement(p);
  }, [p]);

  const updateLyricTextOnSlide = (sl: Slide, text: string): Slide => {
    const lyricId = sl.lyricObjectId;
    const target =
      (lyricId && sl.objects.find((o) => o.id === lyricId)) || sl.objects.find((o) => o.type === 'text');
    if (target && target.type === 'text') {
      return {
        ...sl,
        objects: sl.objects.map((o) => (o.id === target.id ? { ...o, text } : o)),
      };
    }
    const newObjId = newId();
    return {
      ...sl,
      lyricObjectId: newObjId,
      objects: [
        ...sl.objects,
        {
          id: newObjId,
          type: 'text',
          box: { ...theme.lyricBox },
          style: { ...theme.text },
          text,
          opacity: 1,
        },
      ],
    };
  };

  const updateSlideText = (slideId: string, text: string) => {
    if (readOnly) return;
    // Split on '---' followed by Enter (newline) so typing '---' + Enter cleanly splits into a new slide
    if (/(?:^|\r?\n)---\r?\n/.test(text)) {
      const parts = text.split(/(?:^|\r?\n)---\r?\n/).map((x) => x.replace(/^\n+|\n+$/g, ''));
      if (parts.length > 1) {
        let focusSlideId: string | undefined;
        change((prev) => {
          const curTheme = themeOf(prev, themes);
          const sec = prev.sections.find((s) => s.slides.some((sl) => sl.id === slideId));
          if (!sec) return prev;
          const slideIdx = sec.slides.findIndex((sl) => sl.id === slideId);
          const firstSlide = updateSlide(prev, slideId, (sl) => updateLyricTextOnSlide(sl, parts[0] ?? ''));
          const extraSlides: Slide[] = parts.slice(1).map((part) => newSlideFor(prev, curTheme, part));
          focusSlideId = extraSlides[0]?.id;
          return {
            ...firstSlide,
            sections: firstSlide.sections.map((s) =>
              s.id === sec.id
                ? {
                    ...s,
                    slides: [
                      ...s.slides.slice(0, slideIdx + 1),
                      ...extraSlides,
                      ...s.slides.slice(slideIdx + 1),
                    ],
                  }
                : s,
            ),
          };
        });
        if (focusSlideId) {
          const targetId = focusSlideId;
          selectSlide(targetId);
          requestAnimationFrame(() => {
            const el = document.querySelector<HTMLTextAreaElement>(
              `textarea[data-reflow-slide="${targetId}"]`,
            );
            el?.focus();
          });
        }
        return;
      }
    }

    change(
      (prev) => updateSlide(prev, slideId, (sl) => updateLyricTextOnSlide(sl, text)),
      `reflow-text:${slideId}`,
    );
  };

  const updateSlideNotes = (slideId: string, notes: string) => {
    if (readOnly) return;
    change(
      (prev) =>
        updateSlide(prev, slideId, (sl) => ({
          ...sl,
          notes: notes || undefined,
        })),
      `reflow-notes:${slideId}`,
    );
  };

  const addSlideToSection = (sectionId: string) => {
    if (readOnly) return;
    const slide = newSlideFor(p, theme, '');
    change((prev) => ({
      ...prev,
      sections: prev.sections.map((sec) =>
        sec.id === sectionId ? { ...sec, slides: [...sec.slides, slide] } : sec,
      ),
    }));
    selectSlide(slide.id);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-reflow-slide="${slide.id}"]`);
      el?.focus();
    });
  };

  const addSection = (label: string) => {
    if (readOnly) return;
    const newSec: Section = {
      id: newId(),
      label,
      short: label.slice(0, 3).toUpperCase(),
      slides: [newSlideFor(p, theme, '')],
    };
    change((prev) => ({
      ...prev,
      sections: [...prev.sections, newSec],
      arrangements:
        prev.arrangements.length > 0
          ? prev.arrangements.map((a, idx) =>
              idx === 0 ? { ...a, sectionIds: [...a.sectionIds, newSec.id] } : a,
            )
          : prev.arrangements,
    }));
    const firstId = newSec.slides[0]!.id;
    selectSlide(firstId);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-reflow-slide="${firstId}"]`);
      el?.focus();
    });
  };

  const removeSection = (sectionId: string) => {
    if (readOnly || p.sections.length <= 1) return;
    const remaining = p.sections.filter((s) => s.id !== sectionId);
    const removedSec = p.sections.find((s) => s.id === sectionId);
    const wasSelectedInRemoved = removedSec?.slides.some((sl) => sl.id === (selectedSlideId ?? ed.slideId));
    change((prev) => ({
      ...prev,
      sections: prev.sections.filter((s) => s.id !== sectionId),
      arrangements: prev.arrangements.map((a) => ({
        ...a,
        sectionIds: a.sectionIds.filter((id) => id !== sectionId),
      })),
    }));
    if (wasSelectedInRemoved && remaining[0]?.slides[0]) {
      selectSlide(remaining[0].slides[0].id);
    }
  };

  const removeSlide = (sectionId: string, slideId: string) => {
    if (readOnly) return;
    const sec = p.sections.find((s) => s.id === sectionId);
    let fallbackId: string | undefined;
    if (sec && slideId === (selectedSlideId ?? ed.slideId)) {
      const idx = sec.slides.findIndex((sl) => sl.id === slideId);
      fallbackId = sec.slides[idx + 1]?.id ?? sec.slides[idx - 1]?.id;
    }
    change((prev) => ({
      ...prev,
      sections: prev.sections.map((s) =>
        s.id === sectionId ? { ...s, slides: s.slides.filter((sl) => sl.id !== slideId) } : s,
      ),
    }));
    if (fallbackId) selectSlide(fallbackId);
  };

  return (
    <div className="ed-reflow col grow" style={{ minHeight: 0, overflow: 'hidden' }}>
      {/* Top Reflow Toolbar */}
      <div
        className="row wrap"
        style={{
          padding: '8px 16px',
          background: 'var(--subtle, #141416)',
          borderBottom: '1px solid var(--line)',
          alignItems: 'center',
          gap: 14,
        }}
      >
        <div
          className="row"
          style={{ background: 'var(--bg)', borderRadius: 6, padding: 2, border: '1px solid var(--line)' }}
        >
          <button type="button" className="small on" style={{ fontWeight: 600 }}>
            Lyric Script
          </button>
          <button
            type="button"
            className="small ghost"
            onClick={onSwitchToCanvas}
            title="Switch to freeform visual slide canvas"
          >
            Slide Canvas
          </button>
        </div>

        <label className="row small" style={{ alignItems: 'center', gap: 6 }}>
          <span className="muted">Title:</span>
          <input
            type="text"
            value={p.title}
            disabled={readOnly}
            onChange={(e) => change((prev) => ({ ...prev, title: e.target.value }), 'title')}
            style={{ width: 180, fontWeight: 600 }}
          />
        </label>

        <label className="row small" style={{ alignItems: 'center', gap: 6 }}>
          <span className="muted">Theme:</span>
          <select
            value={p.themeId ?? ''}
            disabled={readOnly}
            onChange={(e) => {
              const nextId = e.target.value;
              const chosen = themes.find((t) => t.id === nextId);
              change((prev) => (chosen ? applyTheme(prev, chosen) : { ...prev, themeId: undefined }));
            }}
          >
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="row small" style={{ alignItems: 'center', gap: 6 }}>
          <span className="muted">Background:</span>
          <BackgroundPicker
            value={p.backgroundMediaId}
            disabled={readOnly}
            onChange={(bgId) => change((prev) => ({ ...prev, backgroundMediaId: bgId }))}
          />
        </label>

        <span className="spacer" />

        {/* Arrangement Pills */}
        <div className="row small wrap" style={{ alignItems: 'center', gap: 4 }}>
          <span className="muted">Arrangement:</span>
          {(() => {
            const seen = new Map<string, number>();
            return activeArrangement.sectionIds.map((secId) => {
              const occ = (seen.get(secId) ?? 0) + 1;
              seen.set(secId, occ);
              const sec = p.sections.find((s) => s.id === secId);
              if (!sec) return null;
              return (
                <button
                  key={`${secId}#${occ}`}
                  type="button"
                  className="tag"
                  style={{ cursor: 'pointer', background: 'var(--bg)', border: '1px solid var(--line)' }}
                  onClick={() => {
                    const targetEl = document.getElementById(`section-${secId}`);
                    targetEl?.scrollIntoView({ behavior: 'smooth' });
                  }}
                >
                  {sec.short || sec.label}
                </button>
              );
            });
          })()}
        </div>
      </div>

      {banners}

      {/* Main Two-Column Reflow Workspace */}
      <div className="row grow" style={{ minHeight: 0, overflow: 'hidden' }}>
        {/* Left Column: Fast Section Cards & Lyrics */}
        <div className="col grow" style={{ minHeight: 0, overflowY: 'auto', padding: 16, gap: 16 }}>
          {p.sections.map((sec) => (
            <div
              key={sec.id}
              id={`section-${sec.id}`}
              className="card col"
              style={{
                gap: 12,
                borderLeft: '4px solid var(--primary, #3b82f6)',
                background: 'var(--card-bg, #1e1e24)',
              }}
            >
              {/* Section Header */}
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                  <select
                    value={sec.label}
                    disabled={readOnly}
                    style={{ fontWeight: 600, fontSize: 15 }}
                    onChange={(e) => {
                      const newLabel = e.target.value;
                      change((prev) => ({
                        ...prev,
                        sections: prev.sections.map((s) =>
                          s.id === sec.id
                            ? { ...s, label: newLabel, short: newLabel.slice(0, 3).toUpperCase() }
                            : s,
                        ),
                      }));
                    }}
                  >
                    {!STANDARD_SECTION_LABELS.includes(sec.label) && (
                      <option value={sec.label}>{sec.label}</option>
                    )}
                    {STANDARD_SECTION_LABELS.map((lbl) => (
                      <option key={lbl} value={lbl}>
                        {lbl}
                      </option>
                    ))}
                  </select>
                  <span className="muted small">
                    {sec.slides.length} slide{sec.slides.length > 1 ? 's' : ''}
                  </span>
                </div>
                <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="small"
                    disabled={readOnly}
                    onClick={() => addSlideToSection(sec.id)}
                  >
                    + Add Slide
                  </button>
                  {p.sections.length > 1 && !readOnly && (
                    <button
                      type="button"
                      className="small ghost danger"
                      title="Delete section"
                      onClick={() => removeSection(sec.id)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {/* Slide Text Blocks */}
              <div className="col" style={{ gap: 10 }}>
                {sec.slides.map((slide, sIdx) => {
                  const isSelected = slide.id === (selectedSlideId ?? ed.slideId);
                  const text = firstText(slide) ?? '';
                  const hasCustom =
                    slide.objects.length > 1 ||
                    slide.objects.some((o) => o.type !== 'text') ||
                    (slide.overrides?.length ?? 0) > 0;

                  return (
                    <div
                      key={slide.id}
                      onClick={() => selectSlide(slide.id)}
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        border: isSelected ? '2px solid var(--primary, #3b82f6)' : '1px solid var(--line)',
                        background: isSelected ? 'rgba(59, 130, 246, 0.08)' : 'var(--bg)',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="muted small" style={{ fontWeight: 600 }}>
                          Slide {sIdx + 1}
                        </span>
                        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                          {hasCustom && (
                            <span
                              className="tag"
                              style={{ background: 'rgba(234, 179, 8, 0.2)', color: '#eab308' }}
                            >
                              Custom Layout
                            </span>
                          )}
                          {hasCustom && !readOnly && (
                            <button
                              type="button"
                              className="small ghost"
                              onClick={(e) => {
                                e.stopPropagation();
                                change((prev) =>
                                  updateSlide(prev, slide.id, (sl) =>
                                    resetSlideToTheme(sl, themeOf(prev, themes)),
                                  ),
                                );
                              }}
                              title="Reset positions and formatting back to theme defaults"
                            >
                              Reset to Theme
                            </button>
                          )}
                          {sec.slides.length > 1 && !readOnly && (
                            <button
                              type="button"
                              className="small ghost danger"
                              title="Remove slide"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeSlide(sec.id, slide.id);
                              }}
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Lyric Textarea */}
                      <textarea
                        data-reflow-slide={slide.id}
                        rows={Math.max(2, text.split('\n').length)}
                        value={text}
                        disabled={readOnly}
                        placeholder="Enter lyrics for this slide (type --- and press Enter to split)..."
                        style={{
                          fontSize: 15,
                          lineHeight: 1.4,
                          resize: 'vertical',
                          fontFamily: 'inherit',
                          padding: 8,
                        }}
                        onFocus={() => selectSlide(slide.id)}
                        onChange={(e) => updateSlideText(slide.id, e.target.value)}
                      />

                      {/* Inline Chords / Musician Notes */}
                      <div className="row" style={{ alignItems: 'center', gap: 6 }}>
                        <span className="muted small" style={{ fontSize: 11, width: 95 }}>
                          Chords / Notes:
                        </span>
                        <input
                          type="text"
                          value={slide.notes ?? ''}
                          disabled={readOnly}
                          placeholder="e.g. G - C - Em - D (shown on Stage Display)"
                          style={{ fontSize: 12, flex: 1, padding: '4px 6px' }}
                          onFocus={() => selectSlide(slide.id)}
                          onChange={(e) => updateSlideNotes(slide.id, e.target.value)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Quick Add Section Bar */}
          <div className="row wrap" style={{ gap: 8, alignItems: 'center', padding: '8px 0' }}>
            <span className="muted small">Add section:</span>
            {['Verse', 'Chorus', 'Bridge', 'Tag', 'Outro'].map((kind) => {
              const count = p.sections.filter((s) => s.label.startsWith(kind)).length;
              const nextLabel =
                count > 0 && kind !== 'Chorus' && kind !== 'Tag' ? `${kind} ${count + 1}` : kind;
              return (
                <button
                  key={kind}
                  type="button"
                  className="small"
                  disabled={readOnly}
                  onClick={() => addSection(nextLabel)}
                >
                  + {nextLabel}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right Column: 3-Screen Live Preview Strip */}
        <div
          className="col"
          style={{
            width: 320,
            minWidth: 320,
            borderLeft: '1px solid var(--line)',
            background: 'var(--subtle, #141416)',
            padding: 12,
            gap: 12,
            overflowY: 'auto',
          }}
        >
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <strong style={{ fontSize: 13 }}>Screen Previews</strong>
            <button
              type="button"
              className="small ghost"
              onClick={onSwitchToCanvas}
              title="Open full visual slide editor"
            >
              Canvas &amp; Settings &rarr;
            </button>
          </div>
          <span className="muted small" style={{ marginTop: -6 }}>
            Live preview across Audience, Stage, and Stream:
          </span>
          <LookPreviews presentation={p} slideId={selectedSlideId ?? ed.slideId} compact />
        </div>
      </div>
    </div>
  );
}
