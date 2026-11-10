import { api } from '@ordo/client';
import { type Box, DEFAULT_THEME, newId, type Theme } from '@ordo/domain';
import { useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { FontPicker } from '../../components/FontPicker.tsx';
import { AlignIcon, VAlignIcon, hexToRgb, rgbToHex } from '../../components/AlignIcons.tsx';
import { removeLocal, saveSettings, upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { ThemeCanvas, ThemeThumbnail } from './ThemeCanvas.tsx';
import { ThemeRevisionsDialog } from './ThemeRevisionsDialog.tsx';

const TEST_SCENARIOS = [
  {
    id: 'chorus',
    label: '2-Line Chorus (Contemporary)',
    text: 'Way maker, miracle worker, promise keeper\nLight in the darkness, my God that is who You are',
  },
  {
    id: 'verse',
    label: '4-Line Hymn (Traditional)',
    text: 'Amazing grace how sweet the sound\nThat saved a wretch like me\nI once was lost but now am found\nWas blind but now I see',
  },
  {
    id: 'impact',
    label: '1-Line Punch / Bridge',
    text: 'Hallelujah, praise the Lord, oh my soul!',
  },
  {
    id: 'wrap',
    label: '3-Line Verse',
    text: 'Your love never fails, it never gives up\nNever runs out on me\nOn and on and on and on it goes',
  },
];

const PRESETS: { id: string; label: string; desc: string; box: Box }[] = [
  {
    id: 'full-center',
    label: 'Center Screen',
    desc: 'Auditorium main displays',
    box: { x: 120, y: 140, w: 1680, h: 800, rotation: 0 },
  },
  {
    id: 'lower-third',
    label: 'Lower Third',
    desc: 'Livestream video overlay',
    box: { x: 120, y: 720, w: 1680, h: 280, rotation: 0 },
  },
  {
    id: 'bottom-center',
    label: 'Bottom Third',
    desc: 'Lower stage placement',
    box: { x: 120, y: 640, w: 1680, h: 380, rotation: 0 },
  },
  {
    id: 'top-banner',
    label: 'Top Banner',
    desc: 'Top caption monitors',
    box: { x: 120, y: 80, w: 1680, h: 280, rotation: 0 },
  },
];

const FONT_SIZES = [
  { label: '54', size: 54 },
  { label: '72', size: 72 },
  { label: '84', size: 84 },
  { label: '96', size: 96 },
  { label: '112', size: 112 },
];

const QUICK_COLORS = [
  { label: 'Crisp White', hex: '#ffffff', color: { r: 255, g: 255, b: 255, a: 1 } },
  { label: 'Warm Cream', hex: '#f6f5ee', color: { r: 246, g: 245, b: 238, a: 1 } },
  { label: 'Soft Gold', hex: '#fef08a', color: { r: 254, g: 240, b: 138, a: 1 } },
  { label: 'Sky Cyan', hex: '#7dd3fc', color: { r: 125, g: 211, b: 252, a: 1 } },
];

export function ThemesTab() {
  const themes = useLibrary((s) => s.data.themes);
  const general = useLibrary((s) => s.data.settings.general);
  const defaultThemeId = general.defaultThemeId ?? DEFAULT_THEME.id;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [historyTheme, setHistoryTheme] = useState<Theme | null>(null);

  const editingTheme = themes.find((t) => t.id === editingId);
  const [draft, setDraft] = useState<Theme | null>(null);
  const [scenarioId, setScenarioId] = useState('chorus');

  const onStartEdit = (t: Theme) => {
    setDraft({ ...t });
    setEditingId(t.id);
  };

  const makeDefault = async (themeId: string) => {
    try {
      await saveSettings('general', { ...general, defaultThemeId: themeId });
      toast('Church default lyric theme updated.', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const createTheme = async () => {
    try {
      const base = themes[0] ?? DEFAULT_THEME;
      const t = await api<Theme>('/themes', {
        method: 'POST',
        json: { ...base, id: newId(), name: 'New Lyric Theme' },
      });
      upsertLocal('themes', t);
      setDraft({ ...t });
      setEditingId(t.id);
      toast('Created new lyric theme.', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const duplicateTheme = async (source: Theme) => {
    try {
      const t = await api<Theme>('/themes', {
        method: 'POST',
        json: { ...source, id: newId(), name: `${source.name} (Copy)` },
      });
      upsertLocal('themes', t);
      toast(`Duplicated as “${t.name}”.`, 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const saveTheme = async () => {
    if (!draft) return;
    try {
      const updated = await api<Theme>(`/themes/${draft.id}`, { method: 'PUT', json: draft });
      upsertLocal('themes', updated);
      setDraft(updated);
      toast(`Theme saved (v${updated.rev ?? 1}).`, 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const deleteTheme = async (t: Theme) => {
    if (t.id === DEFAULT_THEME.id) {
      toast('The built-in default theme cannot be deleted.', 'error');
      return;
    }
    if (
      !(await confirmDialog(
        'Delete theme',
        `Delete lyric theme “${t.name}”? Any existing songs using this theme will keep their current styling.`,
        'Delete',
        true,
      ))
    ) {
      return;
    }
    try {
      await api(`/themes/${t.id}`, { method: 'DELETE' });
      removeLocal('themes', t.id);
      if (editingId === t.id) {
        setEditingId(null);
        setDraft(null);
      }
      toast('Theme deleted.', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const activeScenario = TEST_SCENARIOS.find((s) => s.id === scenarioId) ?? TEST_SCENARIOS[0]!;

  return (
    <div
      style={{
        padding: '16px 20px',
        maxWidth: 1400,
        margin: '0 auto',
        height: '100%',
        boxSizing: 'border-box',
        overflowY: 'auto',
      }}
    >
      {historyTheme && (
        <ThemeRevisionsDialog
          id={historyTheme.id}
          themeName={historyTheme.name}
          onClose={() => setHistoryTheme(null)}
          onRestored={(restored) => {
            if (editingId === restored.id) setDraft(restored);
          }}
        />
      )}

      {/* GALLERY VIEW */}
      {!editingId && (
        <div className="col" style={{ gap: 20 }}>
          <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h2 style={{ margin: 0 }}>Lyric Themes</h2>
              <span className="muted small">
                Visual templates for worship song lyrics. PowerPoint sermon decks and announcements retain
                their original slide designs.
              </span>
            </div>
            <button type="button" className="primary" onClick={() => void createTheme()}>
              + New Lyric Theme
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
              gap: 20,
              alignItems: 'stretch',
            }}
          >
            {themes.map((t) => {
              const isDefault = t.id === defaultThemeId;
              return (
                <div
                  key={t.id}
                  className="card col"
                  style={{
                    gap: 12,
                    padding: 14,
                    background: 'var(--panel)',
                    border: isDefault ? '1.5px solid var(--accent, #38bdf8)' : '1px solid var(--line)',
                    borderRadius: 10,
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div className="col" style={{ gap: 10 }}>
                    <div
                      className="row wrap"
                      style={{ justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, fontSize: 16 }}>{t.name}</span>
                        {isDefault && (
                          <span
                            className="tag green"
                            style={{ fontSize: 11, padding: '2px 8px', fontWeight: 600 }}
                            title="Applied automatically when pasting or importing new worship songs"
                          >
                            ★ Church Default
                          </span>
                        )}
                      </div>
                      <span className="tag" style={{ fontSize: 11 }}>
                        v{t.rev ?? 1}
                      </span>
                    </div>

                    {/* Live 16:9 Thumbnail Preview */}
                    <div
                      style={{ cursor: 'pointer' }}
                      onClick={() => onStartEdit(t)}
                      title="Click to visually edit theme"
                    >
                      <ThemeThumbnail box={t.lyricBox} text={t.text} sample={'Way Maker\nMiracle Worker'} />
                    </div>

                    <div className="muted small" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span>{t.text.fontFamily || 'Sans-serif'}</span>
                      <span>·</span>
                      <span>{t.text.fontSizePx ?? 72}px</span>
                      <span>·</span>
                      <span style={{ textTransform: 'capitalize' }}>{t.text.align ?? 'center'}</span>
                    </div>
                  </div>

                  <div className="row wrap" style={{ gap: 6, marginTop: 8, justifyContent: 'space-between' }}>
                    <div className="row" style={{ gap: 6 }}>
                      <button type="button" className="small on" onClick={() => onStartEdit(t)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="small ghost"
                        onClick={() => setHistoryTheme(t)}
                        title="View revision history"
                      >
                        History
                      </button>
                      {!isDefault && (
                        <button
                          type="button"
                          className="small ghost"
                          onClick={() => void makeDefault(t.id)}
                          title="Set as church default for newly created worship songs"
                        >
                          Make Default
                        </button>
                      )}
                    </div>

                    <div className="row" style={{ gap: 4 }}>
                      <button
                        type="button"
                        className="small ghost"
                        onClick={() => void duplicateTheme(t)}
                        title="Duplicate this theme"
                      >
                        Copy
                      </button>
                      <button
                        type="button"
                        className="small danger ghost"
                        disabled={t.id === DEFAULT_THEME.id}
                        onClick={() => void deleteTheme(t)}
                        title={
                          t.id === DEFAULT_THEME.id
                            ? 'Built-in default theme cannot be deleted'
                            : 'Delete theme'
                        }
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* MODERN LYRIC THEME DESIGNER */}
      {editingId && draft && (
        <div className="col" style={{ gap: 18 }}>
          {/* Top Bar Header */}
          <div
            className="row wrap"
            style={{
              justifyContent: 'space-between',
              alignItems: 'center',
              borderBottom: '1px solid var(--line)',
              paddingBottom: 12,
              gap: 12,
            }}
          >
            <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setEditingId(null);
                  setDraft(null);
                }}
              >
                ← Back to Themes
              </button>

              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    background: 'var(--bg2)',
                    border: '1px solid var(--line)',
                    borderRadius: 6,
                    padding: '5px 10px',
                    color: 'var(--fg)',
                    width: 200,
                  }}
                  placeholder="Theme name"
                />
                <span className="tag" style={{ fontSize: 11 }}>
                  v{draft.rev ?? 1}
                </span>
                {draft.id === defaultThemeId ? (
                  <span className="tag green" style={{ fontSize: 11, padding: '2px 8px' }}>
                    ★ Church Default
                  </span>
                ) : (
                  <button
                    type="button"
                    className="small ghost"
                    onClick={() => void makeDefault(draft.id)}
                    title="Set as church default for newly created worship songs"
                  >
                    Make Default
                  </button>
                )}
              </div>
            </div>

            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="ghost" onClick={() => setHistoryTheme(editingTheme ?? draft)}>
                History (v{draft.rev ?? 1})
              </button>
              <button
                type="button"
                className="danger ghost"
                disabled={draft.id === DEFAULT_THEME.id}
                onClick={() => void deleteTheme(draft)}
              >
                Delete
              </button>
              <button type="button" className="primary big" onClick={() => void saveTheme()}>
                Save Theme
              </button>
            </div>
          </div>

          {/* Figma/Canva-Inspired Workspace: Hero Canvas + Modern Inspector */}
          <div className="theme-designer-grid">
            {/* HERO CANVAS COLUMN */}
            <div className="col" style={{ gap: 14 }}>
              <div
                className="card col"
                style={{
                  gap: 12,
                  padding: 16,
                  background: 'var(--bg2)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                }}
              >
                <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 12,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: 'var(--fg2)',
                    }}
                  >
                    Auditorium Slide Canvas (1920 × 1080)
                  </span>
                  <span className="muted small">Drag box or handles to reposition</span>
                </div>

                {/* The Interactive WYSIWYG Canvas */}
                <ThemeCanvas
                  box={draft.lyricBox}
                  text={draft.text}
                  onChangeBox={(lyricBox) => setDraft({ ...draft, lyricBox })}
                  scenario={activeScenario}
                />

                {/* Worship Song Test Scenarios */}
                <div className="col" style={{ gap: 6, marginTop: 4 }}>
                  <span className="muted small" style={{ fontSize: 11 }}>
                    Sample Worship Lyrics:
                  </span>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {TEST_SCENARIOS.map((sc) => (
                      <button
                        key={sc.id}
                        type="button"
                        className={`small ${scenarioId === sc.id ? 'on' : 'ghost'}`}
                        style={{ fontSize: 11 }}
                        onClick={() => setScenarioId(sc.id)}
                      >
                        {sc.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Placement Presets Bar */}
              <div
                className="card col"
                style={{
                  gap: 10,
                  padding: 14,
                  background: 'var(--bg2)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: 12,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--fg2)',
                  }}
                >
                  Screen Placement Presets
                </span>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                    gap: 8,
                  }}
                >
                  {PRESETS.map((p) => {
                    const isSelected =
                      draft.lyricBox.x === p.box.x &&
                      draft.lyricBox.y === p.box.y &&
                      draft.lyricBox.w === p.box.w &&
                      draft.lyricBox.h === p.box.h;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`col ${isSelected ? 'on' : 'ghost'}`}
                        style={{
                          padding: '10px 8px',
                          textAlign: 'center',
                          alignItems: 'center',
                          gap: 3,
                          borderRadius: 8,
                          height: 'auto',
                        }}
                        onClick={() => setDraft({ ...draft, lyricBox: { ...p.box } })}
                      >
                        <span style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</span>
                        <span className="muted small" style={{ fontSize: 10, lineHeight: 1.2 }}>
                          {p.desc}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* VISUAL INSPECTOR COLUMN */}
            <div className="col" style={{ gap: 14 }}>
              {/* Typography Card */}
              <div
                className="card col"
                style={{
                  gap: 14,
                  padding: 16,
                  background: 'var(--bg2)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                }}
              >
                <span
                  style={{
                    fontWeight: 600,
                    fontSize: 12,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--fg2)',
                  }}
                >
                  Typography
                </span>

                {/* Font Picker */}
                <div className="col" style={{ gap: 6 }}>
                  <label className="small muted">Font Family</label>
                  <FontPicker
                    value={draft.text.fontFamily}
                    onChange={(fontFamily) => setDraft({ ...draft, text: { ...draft.text, fontFamily } })}
                  />
                </div>

                {/* Font Size Stepper & Quick Sizes */}
                <div className="col" style={{ gap: 8 }}>
                  <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <label className="small muted">Font Size</label>
                    <div className="row" style={{ gap: 4 }}>
                      {FONT_SIZES.map((fs) => (
                        <button
                          key={fs.size}
                          type="button"
                          className={`small ${draft.text.fontSizePx === fs.size ? 'on' : 'ghost'}`}
                          style={{ padding: '2px 8px', fontSize: 11 }}
                          onClick={() => setDraft({ ...draft, text: { ...draft.text, fontSizePx: fs.size } })}
                        >
                          {fs.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="row" style={{ gap: 10, alignItems: 'center' }}>
                    <div className="stepper-box">
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            text: {
                              ...draft.text,
                              fontSizePx: Math.max(24, (draft.text.fontSizePx ?? 72) - 4),
                            },
                          })
                        }
                      >
                        −
                      </button>
                      <input
                        type="number"
                        value={draft.text.fontSizePx ?? 72}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            text: { ...draft.text, fontSizePx: Math.max(20, Number(e.target.value)) },
                          })
                        }
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setDraft({
                            ...draft,
                            text: {
                              ...draft.text,
                              fontSizePx: Math.min(160, (draft.text.fontSizePx ?? 72) + 4),
                            },
                          })
                        }
                      >
                        +
                      </button>
                    </div>

                    <input
                      type="range"
                      min={36}
                      max={140}
                      step={2}
                      value={draft.text.fontSizePx ?? 72}
                      onChange={(e) =>
                        setDraft({ ...draft, text: { ...draft.text, fontSizePx: Number(e.target.value) } })
                      }
                      style={{ flex: 1, accentColor: 'var(--accent, #38bdf8)' }}
                    />
                  </div>
                </div>

                {/* Style & Casing Segmented Bar */}
                <div className="col" style={{ gap: 6 }}>
                  <label className="small muted">Style & Casing</label>
                  <div className="segmented-bar">
                    <button
                      type="button"
                      className={(draft.text.fontWeight ?? 400) >= 700 ? 'active' : ''}
                      style={{ fontWeight: 700 }}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          text: {
                            ...draft.text,
                            fontWeight: (draft.text.fontWeight ?? 400) >= 700 ? 400 : 700,
                          },
                        })
                      }
                    >
                      B Bold
                    </button>
                    <button
                      type="button"
                      className={draft.text.fontStyle === 'italic' ? 'active' : ''}
                      style={{ fontStyle: 'italic' }}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          text: {
                            ...draft.text,
                            fontStyle: draft.text.fontStyle === 'italic' ? 'normal' : 'italic',
                          },
                        })
                      }
                    >
                      I Italic
                    </button>
                    <button
                      type="button"
                      className={draft.text.transform === 'uppercase' ? 'active' : ''}
                      style={{ letterSpacing: '0.04em' }}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          text: {
                            ...draft.text,
                            transform: draft.text.transform === 'uppercase' ? 'none' : 'uppercase',
                          },
                        })
                      }
                    >
                      AA Caps
                    </button>
                  </div>
                </div>

                {/* Text Alignment: Segmented Buttons */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                    gap: 10,
                  }}
                >
                  <div className="col" style={{ gap: 6 }}>
                    <label className="small muted">Horizontal Align</label>
                    <div className="segmented-bar">
                      {(['left', 'center', 'right'] as const).map((a) => (
                        <button
                          key={a}
                          type="button"
                          className={draft.text.align === a ? 'active' : ''}
                          onClick={() => setDraft({ ...draft, text: { ...draft.text, align: a } })}
                          title={`Align ${a}`}
                        >
                          <AlignIcon align={a} />
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="col" style={{ gap: 6 }}>
                    <label className="small muted">Vertical Align</label>
                    <div className="segmented-bar">
                      {(['top', 'middle', 'bottom'] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          className={draft.text.valign === v ? 'active' : ''}
                          onClick={() => setDraft({ ...draft, text: { ...draft.text, valign: v } })}
                          title={`Vertical ${v}`}
                        >
                          <VAlignIcon valign={v} />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Text Color Swatches */}
                <div className="col" style={{ gap: 8 }}>
                  <label className="small muted">Text Color</label>
                  <div className="row wrap" style={{ gap: 10, alignItems: 'center' }}>
                    {QUICK_COLORS.map((c) => {
                      const isSelected =
                        draft.text.color.r === c.color.r &&
                        draft.text.color.g === c.color.g &&
                        draft.text.color.b === c.color.b;
                      return (
                        <button
                          key={c.hex}
                          type="button"
                          onClick={() => setDraft({ ...draft, text: { ...draft.text, color: c.color } })}
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: '50%',
                            background: c.hex,
                            border: isSelected
                              ? '2.5px solid var(--accent, #38bdf8)'
                              : '1px solid var(--line)',
                            cursor: 'pointer',
                            boxShadow: isSelected ? '0 0 8px rgba(56, 189, 248, 0.6)' : 'none',
                          }}
                          title={c.label}
                        />
                      );
                    })}
                    <input
                      type="color"
                      value={rgbToHex(draft.text.color.r, draft.text.color.g, draft.text.color.b)}
                      onChange={(e) => {
                        const { r, g, b } = hexToRgb(e.target.value);
                        setDraft({ ...draft, text: { ...draft.text, color: { r, g, b, a: 1 } } });
                      }}
                      style={{
                        width: 34,
                        height: 34,
                        padding: 0,
                        border: '1px solid var(--line)',
                        borderRadius: '50%',
                        background: 'transparent',
                        cursor: 'pointer',
                      }}
                      title="Custom color picker"
                    />
                  </div>
                </div>
              </div>

              {/* Readability & Projection Contrast Card */}
              <div
                className="card col"
                style={{
                  gap: 12,
                  padding: 16,
                  background: 'var(--bg2)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                }}
              >
                <div className="col" style={{ gap: 2 }}>
                  <span
                    style={{
                      fontWeight: 600,
                      fontSize: 12,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: 'var(--fg2)',
                    }}
                  >
                    Projection Contrast & Readability
                  </span>
                  <span className="muted small" style={{ fontSize: 11 }}>
                    Crucial for readability over bright stage lights and motion videos.
                  </span>
                </div>

                {/* 4 Contrast Preset Cards */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
                    gap: 8,
                    width: '100%',
                    boxSizing: 'border-box',
                  }}
                >
                  <button
                    type="button"
                    className={`contrast-card-btn ${!draft.text.outline && !draft.text.shadow ? 'active' : ''}`}
                    onClick={() => {
                      const { outline: _, shadow: __, ...rest } = draft.text;
                      setDraft({ ...draft, text: rest });
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 13.5, color: '#fff', textAlign: 'center', lineHeight: 1.2 }}>
                      Clean Text
                    </span>
                    <span className="muted small" style={{ fontSize: 10.5, textAlign: 'center' }}>
                      No stroke or shadow
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`contrast-card-btn ${draft.text.shadow && !draft.text.outline ? 'active' : ''}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        text: {
                          ...draft.text,
                          outline: undefined,
                          shadow: { dx: 0, dy: 3, blur: 8, color: { r: 0, g: 0, b: 0, a: 0.9 } },
                        },
                      })
                    }
                  >
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 13.5,
                        color: '#fff',
                        textAlign: 'center',
                        lineHeight: 1.2,
                        textShadow: '0 3px 6px rgba(0,0,0,0.9)',
                      }}
                    >
                      Soft Shadow
                    </span>
                    <span className="muted small" style={{ fontSize: 10.5, textAlign: 'center' }}>
                      Natural depth
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`contrast-card-btn ${draft.text.outline && !draft.text.shadow ? 'active' : ''}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        text: {
                          ...draft.text,
                          shadow: undefined,
                          outline: { width: 4, color: { r: 0, g: 0, b: 0, a: 1 } },
                        },
                      })
                    }
                  >
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 13.5,
                        color: '#fff',
                        textAlign: 'center',
                        lineHeight: 1.2,
                        textShadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000',
                      }}
                    >
                      Outline (Church)
                    </span>
                    <span className="muted small" style={{ fontSize: 10.5, textAlign: 'center' }}>
                      Sharp on bright screens
                    </span>
                  </button>

                  <button
                    type="button"
                    className={`contrast-card-btn ${draft.text.outline && draft.text.shadow ? 'active' : ''}`}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        text: {
                          ...draft.text,
                          outline: { width: 4, color: { r: 0, g: 0, b: 0, a: 1 } },
                          shadow: { dx: 0, dy: 4, blur: 10, color: { r: 0, g: 0, b: 0, a: 0.85 } },
                        },
                      })
                    }
                  >
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 13.5,
                        color: '#fff',
                        textAlign: 'center',
                        lineHeight: 1.2,
                        textShadow:
                          '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 3px 6px rgba(0,0,0,0.8)',
                      }}
                    >
                      Outline + Shadow
                    </span>
                    <span className="muted small" style={{ fontSize: 10.5, textAlign: 'center' }}>
                      Maximum contrast
                    </span>
                  </button>
                </div>

                {/* Thickness Slider if outline active */}
                {draft.text.outline && (
                  <div className="col" style={{ gap: 6, marginTop: 4 }}>
                    <div
                      className="row wrap"
                      style={{ justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <label className="small muted">Outline Thickness ({draft.text.outline.width} px)</label>
                      <div className="row" style={{ gap: 4 }}>
                        {[2, 4, 6, 8].map((w) => (
                          <button
                            key={w}
                            type="button"
                            className={`small ${draft.text.outline?.width === w ? 'on' : 'ghost'}`}
                            style={{ padding: '2px 7px', fontSize: 11 }}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                text: {
                                  ...draft.text,
                                  outline: {
                                    width: w,
                                    color: draft.text.outline?.color ?? { r: 0, g: 0, b: 0, a: 1 },
                                  },
                                },
                              })
                            }
                          >
                            {w}px
                          </button>
                        ))}
                      </div>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={12}
                      value={draft.text.outline.width}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          text: {
                            ...draft.text,
                            outline: {
                              width: Number(e.target.value),
                              color: draft.text.outline?.color ?? { r: 0, g: 0, b: 0, a: 1 },
                            },
                          },
                        })
                      }
                      style={{ width: '100%', accentColor: 'var(--accent, #38bdf8)' }}
                    />
                  </div>
                )}
              </div>

              {/* Advanced Geometry & Padding (Collapsible) */}
              <details
                style={{
                  background: 'var(--bg2)',
                  border: '1px solid var(--line)',
                  borderRadius: 12,
                  padding: '10px 14px',
                }}
              >
                <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 12, color: 'var(--fg2)' }}>
                  Advanced Coordinates & Insets (px)
                </summary>
                <div className="col" style={{ gap: 10, marginTop: 10 }}>
                  <div className="grid4">
                    <label className="col" style={{ gap: 3 }}>
                      <span className="small muted">X</span>
                      <input
                        type="number"
                        value={draft.lyricBox.x}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            lyricBox: { ...draft.lyricBox, x: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                    <label className="col" style={{ gap: 3 }}>
                      <span className="small muted">Y</span>
                      <input
                        type="number"
                        value={draft.lyricBox.y}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            lyricBox: { ...draft.lyricBox, y: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                    <label className="col" style={{ gap: 3 }}>
                      <span className="small muted">Width</span>
                      <input
                        type="number"
                        value={draft.lyricBox.w}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            lyricBox: { ...draft.lyricBox, w: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                    <label className="col" style={{ gap: 3 }}>
                      <span className="small muted">Height</span>
                      <input
                        type="number"
                        value={draft.lyricBox.h}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            lyricBox: { ...draft.lyricBox, h: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                  </div>

                  <div className="grid2">
                    <label className="col" style={{ gap: 3 }}>
                      <span className="small muted">Line Spacing ({draft.text.lineHeight ?? 1.25})</span>
                      <input
                        type="range"
                        min={0.9}
                        max={1.8}
                        step={0.05}
                        value={draft.text.lineHeight ?? 1.25}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            text: { ...draft.text, lineHeight: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                    <label className="col" style={{ gap: 3 }}>
                      <span className="small muted">Padding ({draft.text.padding ?? 20} px)</span>
                      <input
                        type="range"
                        min={0}
                        max={80}
                        step={4}
                        value={draft.text.padding ?? 20}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            text: { ...draft.text, padding: Number(e.target.value) },
                          })
                        }
                      />
                    </label>
                  </div>
                </div>
              </details>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
