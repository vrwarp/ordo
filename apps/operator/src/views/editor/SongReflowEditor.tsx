import { type Arrangement, type MidiTrigger, newId, type Presentation, type Section } from '@ordo/domain';
import { type ReactNode, useMemo, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Icon } from '../../components/Icons.tsx';
import { Menu } from '../../components/Menu.tsx';
import {
  midiTriggerBadge,
  MidiTriggerPicker,
  shouldShowMidiUi,
  slideMidiTrigger,
} from '../../components/MidiTriggerPicker.tsx';
import { SplitPane } from '../../components/SplitPane.tsx';
import { authoringArrangement } from '../../lib/arrangement.ts';
import { sectionTone } from '../../lib/sectionColors.ts';
import { useLibrary } from '../../state/library.ts';
import { BackgroundPicker } from './BackgroundPicker.tsx';
import { composing } from './editorKeys.ts';
import { change, selectSlide, useEditor } from './editorStore.ts';
import { LookPreviews } from './LookPreviews.tsx';
import { applyTheme, newSlideFor, resetSlideToTheme, type TextPiece, themeOf, updateSlide } from './ops.ts';
import {
  caretPieces,
  markerPieces,
  scriptLines,
  scriptText,
  splitScript,
  twoLinePieces,
  typeScript,
} from './songScript.ts';

export function SongReflowEditor(props: {
  presentation: Presentation;
  readOnly: boolean;
  selectedSlideId?: string;
  onSwitchToCanvas: () => void;
  banners?: ReactNode;
}) {
  const { presentation: p, readOnly, selectedSlideId, onSwitchToCanvas, banners } = props;
  const themes = useLibrary((s) => s.data.themes);
  const surfacesSettings = useLibrary((s) => s.data.settings.surfaces);
  const midiPresets = surfacesSettings.midiPresets ?? [];
  const theme = themeOf(p, themes);
  const ed = useEditor();
  const [openMidiKey, setOpenMidiKey] = useState<string | null>(null);

  const hasAnyMidi = useMemo(
    () =>
      p.sections.some((sec) => Boolean(sec.midi) || sec.slides.some((sl) => Boolean(slideMidiTrigger(sl)))),
    [p.sections],
  );
  const showMidi = shouldShowMidiUi(surfacesSettings, hasAnyMidi);

  const setSectionMidi = (sectionId: string, midi: MidiTrigger | undefined) => {
    if (readOnly) return;
    change((prev) => ({
      ...prev,
      sections: prev.sections.map((s) => (s.id === sectionId ? { ...s, midi } : s)),
    }));
  };

  const setSlideMidi = (slideId: string, midi: MidiTrigger | undefined) => {
    if (readOnly) return;
    change((prev) => updateSlide(prev, slideId, (sl) => ({ ...sl, midi, midiCues: undefined })));
  };

  const activeArrangement: Arrangement = useMemo(() => {
    return p.arrangements[0] ?? authoringArrangement(p);
  }, [p]);

  const setArrangementSections = (nextSectionIds: string[]) => {
    if (readOnly) return;
    change((prev) => {
      const cur = prev.arrangements[0] ?? authoringArrangement(prev);
      const updated: Arrangement = { ...cur, sectionIds: nextSectionIds };
      return {
        ...prev,
        arrangements: prev.arrangements.length > 0 ? [updated, ...prev.arrangements.slice(1)] : [updated],
      };
    });
  };

  /**
   * Split slide `slideId` (one undo step) and move the focus to the first new slide's field, its caret at the
   * start: `pieces` cut the slide's lyric text (songScript.ts); `typed` stores the field's new value first.
   */
  const splitInto = (
    slideId: string,
    pieces: (text: string) => TextPiece[] | null,
    typed?: { text: string; caret?: number },
  ) => {
    if (readOnly) return false;
    let focusSlideId: string | undefined;
    change((prev) => {
      const out = splitScript(prev, slideId, pieces, themeOf(prev, themes), typed);
      focusSlideId = out.ids[0];
      return out.p;
    });
    if (!focusSlideId) return false;
    const targetId = focusSlideId;
    selectSlide(targetId);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-reflow-slide="${targetId}"]`);
      el?.focus();
      el?.setSelectionRange(0, 0);
    });
    return true;
  };

  /**
   * Split at Cursor (✂ and Alt+Enter): at the caret of this slide's field, and only while that field has the
   * focus (a field never focused reports a caret at 0). At the end: an empty next slide; at the start or
   * without the focus: nothing (`caretPieces`).
   */
  const splitAtCursor = (slideId: string) => {
    if (readOnly) return;
    const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-reflow-slide="${slideId}"]`);
    if (!el || document.activeElement !== el) return;
    const caret = el.selectionStart;
    splitInto(slideId, (text) => caretPieces(text, caret));
  };

  const updateSlideText = (slideId: string, text: string, caret?: number) => {
    if (readOnly) return;
    // '---' and Enter: the words before it stay, the rest goes on new slides (runs and styles kept).
    if (markerPieces(text) && splitInto(slideId, markerPieces, { text, caret })) return;
    change((prev) => typeScript(prev, slideId, text, themeOf(prev, themes), caret), `reflow-text:${slideId}`);
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
      {/* Top Reflow Studio Header + Interactive Arrangement Strip */}
      <div
        className="row wrap"
        style={{
          padding: '8px 16px',
          background: 'var(--subtle, #141416)',
          borderBottom: '1px solid var(--line)',
          alignItems: 'center',
          gap: 12,
        }}
      >
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

        {/* Interactive Arrangement Pill Strip */}
        <div className="row small wrap" style={{ alignItems: 'center', gap: 4 }} data-arrangement-strip>
          <span className="muted">{activeArrangement.name}:</span>
          {(() => {
            const seen = new Map<string, number>();
            return activeArrangement.sectionIds.map((secId, arrIdx) => {
              const occ = (seen.get(secId) ?? 0) + 1;
              seen.set(secId, occ);
              const sec = p.sections.find((s) => s.id === secId);
              if (!sec) return null;
              return (
                <span
                  key={`${secId}#${occ}`}
                  className="song-arr-pill"
                  onContextMenu={(e) => {
                    openContextMenu(
                      e,
                      [
                        {
                          label: `Jump to ${sec.label}`,
                          onSelect: () => {
                            const targetEl = document.getElementById(`section-${secId}`);
                            targetEl?.scrollIntoView({ behavior: 'smooth' });
                          },
                        },
                        {
                          label: 'Duplicate step in arrangement',
                          disabled: readOnly,
                          onSelect: () => {
                            const next = [...activeArrangement.sectionIds];
                            next.splice(arrIdx + 1, 0, secId);
                            setArrangementSections(next);
                          },
                        },
                        ...(arrIdx > 0
                          ? [
                              {
                                label: 'Move step left',
                                disabled: readOnly,
                                onSelect: () => {
                                  const next = [...activeArrangement.sectionIds];
                                  [next[arrIdx - 1], next[arrIdx]] = [next[arrIdx]!, next[arrIdx - 1]!];
                                  setArrangementSections(next);
                                },
                              },
                            ]
                          : []),
                        ...(arrIdx < activeArrangement.sectionIds.length - 1
                          ? [
                              {
                                label: 'Move step right',
                                disabled: readOnly,
                                onSelect: () => {
                                  const next = [...activeArrangement.sectionIds];
                                  [next[arrIdx], next[arrIdx + 1]] = [next[arrIdx + 1]!, next[arrIdx]!];
                                  setArrangementSections(next);
                                },
                              },
                            ]
                          : []),
                        ...(activeArrangement.sectionIds.length > 1
                          ? [
                              { kind: 'separator' as const },
                              {
                                label: 'Remove step from arrangement',
                                danger: true,
                                disabled: readOnly,
                                onSelect: () =>
                                  setArrangementSections(
                                    activeArrangement.sectionIds.filter((_, j) => j !== arrIdx),
                                  ),
                              },
                            ]
                          : []),
                      ],
                      { ariaLabel: `${sec.label} arrangement step actions` },
                    );
                  }}
                >
                  <button
                    type="button"
                    className="song-arr-jump"
                    onClick={() => {
                      const targetEl = document.getElementById(`section-${secId}`);
                      targetEl?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    {sec.short || sec.label}
                  </button>
                  {!readOnly && activeArrangement.sectionIds.length > 1 && (
                    <button
                      type="button"
                      className="song-arr-rm"
                      aria-label={`Remove ${sec.label} from arrangement`}
                      title="Remove step from arrangement"
                      onClick={() =>
                        setArrangementSections(activeArrangement.sectionIds.filter((_, j) => j !== arrIdx))
                      }
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            });
          })()}
          {!readOnly && p.sections.length > 0 && (
            <Menu
              label="+ Step"
              items={p.sections.map((sec) => ({
                label: `+ ${sec.label}`,
                name: sec.label,
                onSelect: () => setArrangementSections([...activeArrangement.sectionIds, sec.id]),
              }))}
            />
          )}
        </div>
      </div>

      {banners}

      {/* Main Two-Column Reflow Workspace */}
      <div className="grow" style={{ minHeight: 0, height: '100%', overflow: 'hidden' }}>
        <SplitPane
          storageKey="editor-reflow-split"
          panels={[
            {
              id: 'reflow-script',
              content: (
                <div className="studio-well col" style={{ padding: 0 }}>
                  {p.sections.map((sec) => {
                    const tone = sectionTone(sec.label, sec.short);
                    return (
                      <div key={sec.id} id={`section-${sec.id}`} className="reflow-section">
                        {/* Section Header */}
                        <div
                          className="row"
                          style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
                          onContextMenu={(e) => {
                            openContextMenu(
                              e,
                              [
                                {
                                  label: 'Add to arrangement',
                                  disabled: readOnly,
                                  onSelect: () =>
                                    setArrangementSections([...activeArrangement.sectionIds, sec.id]),
                                },
                                ...(p.sections.length > 1
                                  ? [
                                      { kind: 'separator' as const },
                                      {
                                        label: 'Delete section',
                                        danger: true,
                                        disabled: readOnly,
                                        onSelect: () => removeSection(sec.id),
                                      },
                                    ]
                                  : []),
                              ],
                              { ariaLabel: `${sec.label} section actions` },
                            );
                          }}
                        >
                          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                            <span
                              className="tag"
                              style={{
                                background: tone.bg,
                                color: tone.fg,
                                fontWeight: 700,
                                border: 'none',
                              }}
                            >
                              {sec.short || sec.label}
                            </span>
                            <input
                              type="text"
                              value={sec.label}
                              disabled={readOnly}
                              placeholder="Section name"
                              style={{
                                fontWeight: 600,
                                fontSize: 15,
                                background: 'transparent',
                                border: '1px solid transparent',
                                padding: '3px 6px',
                                color: 'var(--fg)',
                                width: 170,
                              }}
                              onChange={(e) => {
                                const newLabel = e.target.value;
                                change(
                                  (prev) => ({
                                    ...prev,
                                    sections: prev.sections.map((s) =>
                                      s.id === sec.id
                                        ? { ...s, label: newLabel, short: newLabel.slice(0, 3).toUpperCase() }
                                        : s,
                                    ),
                                  }),
                                  `sec-label:${sec.id}`,
                                );
                              }}
                            />
                            <span className="muted small">
                              {sec.slides.length} slide{sec.slides.length > 1 ? 's' : ''}
                            </span>
                          </div>
                          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                            {showMidi &&
                              (() => {
                                const badge = midiTriggerBadge(sec.midi, midiPresets);
                                const key = `sec:${sec.id}`;
                                const isOpen = openMidiKey === key;
                                return (
                                  <button
                                    type="button"
                                    className={`small ${isOpen ? 'on' : badge ? '' : 'ghost'}`}
                                    title={
                                      badge
                                        ? `Section lighting (on entering ${sec.label}): ${badge.title}`
                                        : `Set lighting / MIDI on entering ${sec.label}`
                                    }
                                    style={{
                                      borderLeft: badge?.color ? `3px solid ${badge.color}` : undefined,
                                    }}
                                    onClick={() => setOpenMidiKey(isOpen ? null : key)}
                                  >
                                    <Icon name="lights" size={13} />
                                    <span>{badge ? badge.label : 'Lights'}</span>
                                  </button>
                                );
                              })()}
                            <button
                              type="button"
                              className="small"
                              disabled={readOnly}
                              onClick={() => addSlideToSection(sec.id)}
                            >
                              <Icon name="plus" size={13} />
                              Add Slide
                            </button>
                            {p.sections.length > 1 && !readOnly && (
                              <button
                                type="button"
                                className="small ghost danger icon-btn"
                                title="Delete section"
                                aria-label={`Delete ${sec.label}`}
                                onClick={() => removeSection(sec.id)}
                              >
                                <Icon name="close" size={13} />
                              </button>
                            )}
                          </div>
                        </div>

                        {openMidiKey === `sec:${sec.id}` && (
                          <div
                            className="card col small"
                            style={{ gap: 8, background: 'var(--panel)', padding: 12 }}
                          >
                            <div
                              className="row"
                              style={{ justifyContent: 'space-between', alignItems: 'center' }}
                            >
                              <b>Lighting / MIDI when entering “{sec.label}”</b>
                              <button
                                type="button"
                                className="small ghost"
                                onClick={() => setOpenMidiKey(null)}
                              >
                                Done
                              </button>
                            </div>
                            <MidiTriggerPicker
                              value={sec.midi}
                              disabled={readOnly}
                              compact
                              onChange={(midi) => setSectionMidi(sec.id, midi)}
                              hint="Saved on this song — applies to all services (fires on every repeat in the arrangement)."
                            />
                          </div>
                        )}

                        {/* Slide Text Blocks */}
                        <div className="col" style={{ gap: 10 }}>
                          {sec.slides.map((slide, sIdx) => {
                            const isSelected = slide.id === (selectedSlideId ?? ed.slideId);
                            const text = scriptText(slide);
                            const nonEmptyLines = scriptLines(text).length;
                            const overflowsStream = nonEmptyLines > 2;
                            const hasCustom =
                              slide.objects.length > 1 ||
                              slide.objects.some((o) => o.type !== 'text') ||
                              (slide.overrides?.length ?? 0) > 0;
                            const slideTrigger = slideMidiTrigger(slide);
                            const slideMidiBadge = midiTriggerBadge(slideTrigger, midiPresets);
                            const slideMidiKey = `sl:${slide.id}`;
                            const slideMidiOpen = openMidiKey === slideMidiKey;

                            return (
                              <div
                                key={slide.id}
                                className={`reflow-slide-row${isSelected ? ' active' : ''}`}
                                onClick={() => selectSlide(slide.id)}
                                onContextMenu={(e) => {
                                  if (!showMidi || readOnly) return;
                                  selectSlide(slide.id);
                                  openContextMenu(
                                    e,
                                    [
                                      {
                                        label: slideMidiBadge
                                          ? 'Edit slide lighting / MIDI…'
                                          : 'Add slide lighting / MIDI…',
                                        onSelect: () => setOpenMidiKey(slideMidiKey),
                                      },
                                      ...(slideTrigger
                                        ? [
                                            {
                                              label: 'Remove slide lighting / MIDI',
                                              danger: true,
                                              onSelect: () => {
                                                setSlideMidi(slide.id, undefined);
                                                if (slideMidiOpen) setOpenMidiKey(null);
                                              },
                                            },
                                          ]
                                        : []),
                                    ],
                                    { ariaLabel: `Slide ${sIdx + 1} actions` },
                                  );
                                }}
                              >
                                <div className="reflow-gutter" style={{ background: tone.bg }} />
                                <div className="reflow-slide-body">
                                  <div
                                    className="row wrap"
                                    style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}
                                  >
                                    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                                      <span className="muted small" style={{ fontWeight: 600 }}>
                                        Slide {sIdx + 1}
                                      </span>
                                      {overflowsStream ? (
                                        <span
                                          className="tag amber row"
                                          style={{ gap: 4 }}
                                          title="Livestream lower-third straps fit 2 lines cleanly"
                                        >
                                          <Icon name="warning" size={12} />
                                          {nonEmptyLines} lines · Clips 2-line Stream
                                        </span>
                                      ) : nonEmptyLines > 0 ? (
                                        <span className="muted small row" style={{ gap: 4 }}>
                                          <Icon name="check" size={12} />
                                          {nonEmptyLines} line{nonEmptyLines === 1 ? '' : 's'}
                                        </span>
                                      ) : null}
                                      {slideMidiBadge && (
                                        <button
                                          type="button"
                                          className={`small ${slideMidiOpen ? 'on' : ''}`}
                                          title={`Slide MIDI: ${slideMidiBadge.title}`}
                                          style={{
                                            borderLeft: slideMidiBadge.color
                                              ? `3px solid ${slideMidiBadge.color}`
                                              : undefined,
                                          }}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenMidiKey(slideMidiOpen ? null : slideMidiKey);
                                          }}
                                        >
                                          <Icon name="zap" size={12} />
                                          {slideMidiBadge.label}
                                        </button>
                                      )}
                                    </div>

                                    <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                                      {showMidi && !slideMidiBadge && isSelected && !readOnly && (
                                        <button
                                          type="button"
                                          className={`small ghost ${slideMidiOpen ? 'on' : ''}`}
                                          title="Add a lighting / MIDI cue on this specific slide"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenMidiKey(slideMidiOpen ? null : slideMidiKey);
                                          }}
                                        >
                                          <Icon name="zap" size={12} />
                                          Lighting
                                        </button>
                                      )}
                                      {overflowsStream && !readOnly && (
                                        <button
                                          type="button"
                                          className="small"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            splitInto(slide.id, twoLinePieces);
                                          }}
                                          title="Automatically split into 2-line slides for livestream lower thirds"
                                        >
                                          Auto-Split (2 lines)
                                        </button>
                                      )}
                                      {!readOnly && text.trim().length > 0 && (
                                        <button
                                          type="button"
                                          className="small ghost"
                                          onMouseDown={(e) => e.preventDefault()}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            splitAtCursor(slide.id);
                                          }}
                                          title="Split slide at cursor position (Alt+Enter / Opt+Enter)"
                                        >
                                          <Icon name="scissors" size={13} />
                                          Split at Cursor
                                        </button>
                                      )}
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
                                          className="small ghost danger icon-btn"
                                          title="Remove slide"
                                          aria-label={`Remove slide ${sIdx + 1}`}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            removeSlide(sec.id, slide.id);
                                          }}
                                        >
                                          <Icon name="close" size={13} />
                                        </button>
                                      )}
                                    </div>
                                  </div>

                                  {slideMidiOpen && (
                                    <div
                                      className="card col small"
                                      style={{ gap: 6, background: 'var(--well)', padding: 10 }}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <div
                                        className="row"
                                        style={{ justifyContent: 'space-between', alignItems: 'center' }}
                                      >
                                        <b>Lighting / MIDI on Slide {sIdx + 1}</b>
                                        <button
                                          type="button"
                                          className="small ghost"
                                          onClick={() => setOpenMidiKey(null)}
                                        >
                                          Done
                                        </button>
                                      </div>
                                      <MidiTriggerPicker
                                        value={slideTrigger}
                                        disabled={readOnly}
                                        compact
                                        onChange={(midi) => setSlideMidi(slide.id, midi)}
                                        hint="Fires when landing on this specific slide."
                                      />
                                    </div>
                                  )}

                                  {/* Lyric Textarea */}
                                  <textarea
                                    className="reflow-textarea"
                                    data-reflow-slide={slide.id}
                                    rows={Math.max(2, text.split('\n').length)}
                                    value={text}
                                    disabled={readOnly}
                                    placeholder="Enter lyrics (Opt+Enter or --- to split into next slide)…"
                                    onFocus={() => selectSlide(slide.id)}
                                    onKeyDown={(e) => {
                                      if (!composing(e) && e.altKey && e.key === 'Enter') {
                                        e.preventDefault();
                                        splitAtCursor(slide.id);
                                      }
                                    }}
                                    onChange={(e) =>
                                      updateSlideText(slide.id, e.target.value, e.target.selectionEnd)
                                    }
                                  />

                                  {/* Inline Chords / Musician Notes */}
                                  <div className="col" style={{ gap: 6 }}>
                                    <div
                                      className="row wrap"
                                      style={{
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        gap: 6,
                                      }}
                                    >
                                      <span className="muted small row" style={{ gap: 5 }}>
                                        <Icon name="music" size={13} />
                                        <span>Band Chords &amp; Stage Cues</span>
                                      </span>
                                      {!readOnly && (
                                        <div className="row" style={{ gap: 4 }}>
                                          {(['[BUILD]', '[SOFT / PADS]', '[HOLD]'] as const).map((cue) => (
                                            <button
                                              key={cue}
                                              type="button"
                                              className="small ghost"
                                              onClick={() => {
                                                const cur = slide.notes?.trim() ?? '';
                                                updateSlideNotes(slide.id, cur ? `${cur} ${cue}` : cue);
                                              }}
                                            >
                                              + {cue}
                                            </button>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                    <textarea
                                      className="reflow-chord-input"
                                      rows={Math.max(1, Math.min(4, (slide.notes ?? '').split('\n').length))}
                                      value={slide.notes ?? ''}
                                      disabled={readOnly}
                                      placeholder="e.g. Key: G · Capo 2 | G - C - Em - D (shown in amber on Stage Display)"
                                      onFocus={() => selectSlide(slide.id)}
                                      onChange={(e) => updateSlideNotes(slide.id, e.target.value)}
                                    />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}

                  {/* Quick Add Section Bar */}
                  <div className="row wrap" style={{ gap: 8, alignItems: 'center', padding: '14px 18px' }}>
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
                          <Icon name="plus" size={12} />
                          {nextLabel}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ),
            },
            {
              id: 'reflow-previews',
              size: 350,
              min: 280,
              max: 520,
              content: (
                <div className="studio-sidebar">
                  <div className="pl-pane-head" style={{ justifyContent: 'space-between' }}>
                    <strong style={{ fontSize: 13.5 }}>Screen Previews</strong>
                    <button
                      type="button"
                      className="small ghost"
                      onClick={onSwitchToCanvas}
                      title="Open full visual slide editor"
                    >
                      <span>Canvas &amp; Settings</span>
                      <Icon name="chevronRight" size={13} />
                    </button>
                  </div>
                  <div className="pl-pane-scroll col" style={{ padding: 14, gap: 12 }}>
                    <span className="muted small">Live preview across Audience, Stage, and Stream:</span>
                    <LookPreviews presentation={p} slideId={selectedSlideId ?? ed.slideId} compact />
                  </div>
                </div>
              ),
            },
          ]}
        />
      </div>
    </div>
  );
}
