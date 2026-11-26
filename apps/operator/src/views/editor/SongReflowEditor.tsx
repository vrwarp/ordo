import {
  type Arrangement,
  formatSongCredits,
  type MidiTrigger,
  newId,
  parseSectionLabel,
  type Presentation,
  type Section,
  titleSectionId,
  titleSlideId,
} from '@ordo/domain';
import { type ReactNode, useMemo, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Check, NumberField, TextField } from '../../components/fields.tsx';
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
  const ccliLicense = useLibrary((s) => s.data.settings.general.ccliLicense);
  const surfacesSettings = useLibrary((s) => s.data.settings.surfaces);
  const midiPresets = surfacesSettings.midiPresets ?? [];
  const theme = themeOf(p, themes);
  const ed = useEditor();
  const [openMidiKey, setOpenMidiKey] = useState<string | null>(null);
  const [showSongInfo, setShowSongInfo] = useState(false);
  const [previewingTitle, setPreviewingTitle] = useState(false);

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

  const titleSecId = titleSectionId(p.id);
  const activeArrangement: Arrangement = useMemo(() => {
    return p.arrangements[0] ?? authoringArrangement(p);
  }, [p]);

  const arrangementIds = useMemo(() => {
    if (!p.meta.titleSlide) return activeArrangement.sectionIds.filter((id) => id !== titleSecId);
    return activeArrangement.sectionIds.includes(titleSecId)
      ? activeArrangement.sectionIds
      : [titleSecId, ...activeArrangement.sectionIds];
  }, [activeArrangement.sectionIds, p.meta.titleSlide, titleSecId]);

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

  const toggleTitleSlide = (nextOn: boolean) => {
    if (readOnly) return;
    change((prev) => {
      const tSecId = titleSectionId(prev.id);
      const arrangements = nextOn
        ? prev.arrangements.length > 0
          ? prev.arrangements.map((a) => ({
              ...a,
              sectionIds: a.sectionIds.includes(tSecId) ? a.sectionIds : [tSecId, ...a.sectionIds],
            }))
          : [{ ...authoringArrangement(prev), sectionIds: [tSecId, ...prev.sections.map((s) => s.id)] }]
        : prev.arrangements.map((a) => ({
            ...a,
            sectionIds: a.sectionIds.filter((id) => id !== tSecId),
          }));
      return {
        ...prev,
        meta: { ...prev.meta, titleSlide: nextOn || undefined },
        arrangements,
      };
    });
    setPreviewingTitle(nextOn);
  };

  /** Insert a Blank step into the arrangement (reusing an existing Blank section if present). */
  const insertBlankStep = (where: 'start' | 'end') => {
    if (readOnly) return;
    change((prev) => {
      const existing = prev.sections.find(
        (s) => s.label.toLowerCase() === 'blank' || s.short.toLowerCase() === 'blk',
      );
      const blankSec: Section = existing ?? {
        id: newId(),
        label: 'Blank',
        short: 'BLK',
        slides: [newSlideFor(prev, themeOf(prev, themes), '')],
      };
      const sections = existing ? prev.sections : [...prev.sections, blankSec];
      const cur = prev.arrangements[0] ?? authoringArrangement(prev);
      const tSecId = titleSectionId(prev.id);
      const baseIds =
        prev.meta.titleSlide && !cur.sectionIds.includes(tSecId)
          ? [tSecId, ...cur.sectionIds]
          : cur.sectionIds;
      const nextIds = where === 'start' ? [blankSec.id, ...baseIds] : [...baseIds, blankSec.id];
      const updated: Arrangement = { ...cur, sectionIds: nextIds };
      return {
        ...prev,
        sections,
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
    setPreviewingTitle(false);
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
    setPreviewingTitle(false);
    selectSlide(slide.id);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`textarea[data-reflow-slide="${slide.id}"]`);
      el?.focus();
    });
  };

  const addSection = (label: string) => {
    if (readOnly) return;
    const parsedLbl = parseSectionLabel(label);
    const newSec: Section = {
      id: newId(),
      label,
      short: parsedLbl?.short ?? label.slice(0, 3).toUpperCase(),
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
    setPreviewingTitle(false);
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

  const infoSummaryParts: string[] = [];
  if (p.meta.author) infoSummaryParts.push(p.meta.author);
  if (p.meta.ccli) infoSummaryParts.push(`CCLI #${p.meta.ccli}`);
  if (p.meta.key) infoSummaryParts.push(`Key: ${p.meta.key}`);
  const creditsPreview = formatSongCredits(p.meta, ccliLicense);
  const titleTone = sectionTone('Title', 'TTL');
  const effectivePreviewSlideId =
    previewingTitle && p.meta.titleSlide ? titleSlideId(p.id) : (selectedSlideId ?? ed.slideId);

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

        <button
          type="button"
          className={`small ${showSongInfo ? 'on' : 'ghost'}`}
          onClick={() => setShowSongInfo((v) => !v)}
          data-song-info-toggle
          title="Edit song author, CCLI number, copyright, key, and tempo"
        >
          <Icon name="sliders" size={13} />
          <span className="ellipsis" style={{ maxWidth: 220 }}>
            {infoSummaryParts.length > 0 ? infoSummaryParts.join(' · ') : 'Song Info & CCLI'}
          </span>
        </button>

        <button
          type="button"
          className={`small ${p.meta.titleSlide ? 'on' : 'ghost'}`}
          disabled={readOnly}
          aria-pressed={Boolean(p.meta.titleSlide)}
          onClick={() => toggleTitleSlide(!p.meta.titleSlide)}
          data-title-slide-toggle
          title="Include an auto-generated Title Slide at the start of this song (Title, Author, Copyright, CCLI)"
        >
          <span>{p.meta.titleSlide ? '✓ Title Slide' : '+ Title Slide'}</span>
        </button>

        <span className="spacer" />

        {/* Interactive Arrangement Pill Strip */}
        <div className="row small wrap" style={{ alignItems: 'center', gap: 4 }} data-arrangement-strip>
          <span className="muted">{activeArrangement.name}:</span>
          {(() => {
            const seen = new Map<string, number>();
            return arrangementIds.map((secId, arrIdx) => {
              const occ = (seen.get(secId) ?? 0) + 1;
              seen.set(secId, occ);
              const isTitle = secId === titleSecId;
              const sec = isTitle ? undefined : p.sections.find((s) => s.id === secId);
              if (!isTitle && !sec) return null;
              const label = isTitle ? 'Title' : sec!.label;
              const short = isTitle ? 'TTL' : sec!.short || sec!.label;
              const removeStep = () => {
                const next = arrangementIds.filter((_, j) => j !== arrIdx);
                if (isTitle && !next.includes(titleSecId)) {
                  toggleTitleSlide(false);
                } else {
                  setArrangementSections(next);
                }
              };
              return (
                <span
                  key={`${secId}#${occ}`}
                  className="song-arr-pill"
                  style={isTitle ? { borderLeft: `3px solid ${titleTone.border}` } : undefined}
                  onContextMenu={(e) => {
                    openContextMenu(
                      e,
                      [
                        isTitle
                          ? {
                              label: 'Preview Title Slide',
                              onSelect: () => {
                                setPreviewingTitle(true);
                                document
                                  .getElementById('section-title-slide')
                                  ?.scrollIntoView({ behavior: 'smooth' });
                              },
                            }
                          : {
                              label: `Jump to ${label}`,
                              onSelect: () => {
                                const targetEl = document.getElementById(`section-${secId}`);
                                targetEl?.scrollIntoView({ behavior: 'smooth' });
                              },
                            },
                        ...(isTitle
                          ? [
                              {
                                label: 'Edit Song Info & CCLI…',
                                onSelect: () => setShowSongInfo(true),
                              },
                            ]
                          : [
                              {
                                label: 'Duplicate step in arrangement',
                                disabled: readOnly,
                                onSelect: () => {
                                  const next = [...arrangementIds];
                                  next.splice(arrIdx + 1, 0, secId);
                                  setArrangementSections(next);
                                },
                              },
                            ]),
                        ...(arrIdx > 0
                          ? [
                              {
                                label: 'Move step left',
                                disabled: readOnly,
                                onSelect: () => {
                                  const next = [...arrangementIds];
                                  [next[arrIdx - 1], next[arrIdx]] = [next[arrIdx]!, next[arrIdx - 1]!];
                                  setArrangementSections(next);
                                },
                              },
                            ]
                          : []),
                        ...(arrIdx < arrangementIds.length - 1
                          ? [
                              {
                                label: 'Move step right',
                                disabled: readOnly,
                                onSelect: () => {
                                  const next = [...arrangementIds];
                                  [next[arrIdx], next[arrIdx + 1]] = [next[arrIdx + 1]!, next[arrIdx]!];
                                  setArrangementSections(next);
                                },
                              },
                            ]
                          : []),
                        ...(arrangementIds.length > 1 || isTitle
                          ? [
                              { kind: 'separator' as const },
                              {
                                label: isTitle ? 'Turn off Title Slide' : 'Remove step from arrangement',
                                danger: true,
                                disabled: readOnly,
                                onSelect: removeStep,
                              },
                            ]
                          : []),
                      ],
                      { ariaLabel: `${label} arrangement step actions` },
                    );
                  }}
                >
                  <button
                    type="button"
                    className="song-arr-jump"
                    onClick={() => {
                      if (isTitle) {
                        setPreviewingTitle(true);
                        document
                          .getElementById('section-title-slide')
                          ?.scrollIntoView({ behavior: 'smooth' });
                      } else {
                        const targetEl = document.getElementById(`section-${secId}`);
                        targetEl?.scrollIntoView({ behavior: 'smooth' });
                      }
                    }}
                  >
                    {short}
                  </button>
                  {!readOnly && (arrangementIds.length > 1 || isTitle) && (
                    <button
                      type="button"
                      className="song-arr-rm"
                      aria-label={isTitle ? 'Turn off Title Slide' : `Remove ${label} from arrangement`}
                      title={isTitle ? 'Turn off Title Slide' : 'Remove step from arrangement'}
                      onClick={removeStep}
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
              items={[
                ...p.sections.map((sec) => ({
                  label: `+ ${sec.label}`,
                  name: sec.label,
                  onSelect: () => setArrangementSections([...arrangementIds, sec.id]),
                })),
                {
                  label: '+ Blank at start (intro / transition)',
                  name: 'Blank at start',
                  onSelect: () => insertBlankStep('start'),
                },
                {
                  label: '+ Blank at end (outro / transition)',
                  name: 'Blank at end',
                  onSelect: () => insertBlankStep('end'),
                },
              ]}
            />
          )}
        </div>
      </div>

      {/* Collapsible Song Metadata & CCLI Editor right inside Lyric Script */}
      {showSongInfo && (
        <div
          className="col"
          data-song-info-panel
          style={{
            padding: '12px 18px',
            background: 'var(--bg2)',
            borderBottom: '1px solid var(--line)',
            gap: 10,
          }}
        >
          <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontSize: 13 }}>Song Details &amp; CCLI Attribution</strong>
            <div className="row" style={{ gap: 10, alignItems: 'center' }}>
              <span className="muted small">
                {ccliLicense ? (
                  <>Venue CCLI License #{ccliLicense}</>
                ) : (
                  <>
                    Venue CCLI License # not set (<a href="#/settings/general">Settings → General</a>)
                  </>
                )}
              </span>
              <button type="button" className="small ghost" onClick={() => setShowSongInfo(false)}>
                Done
              </button>
            </div>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 10,
              alignItems: 'end',
            }}
          >
            <TextField
              label="Song title"
              value={p.title}
              disabled={readOnly}
              onChange={(title) => change((q) => ({ ...q, title }), 'pres:title')}
            />
            <TextField
              label="Author / Artist"
              value={p.meta.author ?? ''}
              placeholder="e.g. John Newton / Chris Tomlin"
              disabled={readOnly}
              onChange={(author) =>
                change((q) => ({ ...q, meta: { ...q.meta, author: author || undefined } }), 'meta:author')
              }
            />
            <TextField
              label="CCLI Song #"
              value={p.meta.ccli ?? ''}
              placeholder="e.g. 7073332"
              disabled={readOnly}
              onChange={(ccli) =>
                change((q) => ({ ...q, meta: { ...q.meta, ccli: ccli || undefined } }), 'meta:ccli')
              }
            />
            <TextField
              label="Copyright"
              value={p.meta.copyright ?? ''}
              placeholder="e.g. 2016 Hillsong Music Publishing"
              disabled={readOnly}
              onChange={(copyright) =>
                change(
                  (q) => ({ ...q, meta: { ...q.meta, copyright: copyright || undefined } }),
                  'meta:copyright',
                )
              }
            />
            <TextField
              label="Key"
              value={p.meta.key ?? ''}
              placeholder="e.g. G"
              disabled={readOnly}
              onChange={(key) =>
                change((q) => ({ ...q, meta: { ...q.meta, key: key || undefined } }), 'meta:key')
              }
            />
            <NumberField
              label="Tempo (BPM)"
              value={p.meta.tempo ?? 0}
              min={0}
              disabled={readOnly}
              onChange={(tempo) =>
                change((q) => ({ ...q, meta: { ...q.meta, tempo: tempo || undefined } }), 'meta:tempo')
              }
            />
          </div>
          <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <Check
              label="Show auto-generated Title Slide at the start of this song (updates automatically from fields above)"
              value={Boolean(p.meta.titleSlide)}
              disabled={readOnly}
              onChange={toggleTitleSlide}
            />
          </div>
        </div>
      )}

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
                  {p.meta.titleSlide && (
                    <div id="section-title-slide" className="reflow-section" data-title-slide-card>
                      <div
                        className="row"
                        style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}
                      >
                        <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                          <span
                            className="tag"
                            style={{
                              background: titleTone.bg,
                              color: titleTone.fg,
                              fontWeight: 700,
                              border: 'none',
                            }}
                          >
                            TTL
                          </span>
                          <span style={{ fontWeight: 600, fontSize: 15 }}>Title Slide</span>
                          <span className="muted small">Auto-generated from Song Info</span>
                        </div>
                        <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                          <button
                            type="button"
                            className="small ghost"
                            onClick={() => setShowSongInfo((v) => !v)}
                          >
                            <Icon name="edit" size={12} />
                            Edit Info
                          </button>
                          {!readOnly && (
                            <button
                              type="button"
                              className="small ghost danger icon-btn"
                              title="Turn off Title Slide"
                              aria-label="Turn off Title Slide"
                              onClick={() => toggleTitleSlide(false)}
                            >
                              <Icon name="close" size={13} />
                            </button>
                          )}
                        </div>
                      </div>
                      <div
                        className={`reflow-slide-row${previewingTitle ? ' active' : ''}`}
                        onClick={() => setPreviewingTitle(true)}
                        style={{ cursor: 'pointer' }}
                      >
                        <div className="reflow-gutter" style={{ background: titleTone.bg }} />
                        <div className="reflow-slide-body" style={{ gap: 4 }}>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>{p.title || 'Untitled song'}</div>
                          {creditsPreview ? (
                            <div className="muted small" style={{ whiteSpace: 'pre-line', lineHeight: 1.4 }}>
                              {creditsPreview}
                            </div>
                          ) : (
                            <div className="muted small" style={{ fontStyle: 'italic' }}>
                              No author, copyright, or CCLI number set yet — click Edit Info to add them.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
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
                            const isSelected =
                              !previewingTitle && slide.id === (selectedSlideId ?? ed.slideId);
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
                                onClick={() => {
                                  setPreviewingTitle(false);
                                  selectSlide(slide.id);
                                }}
                                onContextMenu={(e) => {
                                  if (!showMidi || readOnly) return;
                                  setPreviewingTitle(false);
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
                                      ) : (
                                        <span
                                          className="tag small"
                                          title="Shows only the song's background on audience screens (useful for intros, instrumentals, and transitions)"
                                        >
                                          Blank (background only)
                                        </span>
                                      )}
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
                                    placeholder="Enter lyrics (leave empty for a Blank background-only slide, or Opt+Enter / --- to split)…"
                                    onFocus={() => {
                                      setPreviewingTitle(false);
                                      selectSlide(slide.id);
                                    }}
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
                                      onFocus={() => {
                                        setPreviewingTitle(false);
                                        selectSlide(slide.id);
                                      }}
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
                    {['Verse', 'Chorus', 'Bridge', 'Tag', 'Outro', 'Instrumental', 'Blank'].map((kind) => {
                      const count = p.sections.filter((s) => s.label.startsWith(kind)).length;
                      const nextLabel =
                        count > 0 && kind !== 'Chorus' && kind !== 'Tag' && kind !== 'Blank'
                          ? `${kind} ${count + 1}`
                          : kind;
                      return (
                        <button
                          key={kind}
                          type="button"
                          className="small"
                          disabled={readOnly}
                          onClick={() => {
                            if (kind === 'Blank' && count > 0) {
                              insertBlankStep('end');
                            } else {
                              addSection(nextLabel);
                            }
                          }}
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
                    <LookPreviews presentation={p} slideId={effectivePreviewSlideId} compact />
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
