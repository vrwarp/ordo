import { api } from '@ordo/client';
import { type Box, DEFAULT_THEME, newId, type Theme } from '@ordo/domain';
import { useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { BoxEditor, TextField } from '../../components/fields.tsx';
import { TextStyleEditor } from '../../components/TextStyleEditor.tsx';
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

const PRESET_GEOMETRIES: { label: string; box: Box }[] = [
  {
    label: 'Full Center',
    box: { x: 120, y: 140, w: 1680, h: 800, rotation: 0 },
  },
  {
    label: 'Lower Third (Stream)',
    box: { x: 120, y: 720, w: 1680, h: 280, rotation: 0 },
  },
  {
    label: 'Bottom Center',
    box: { x: 120, y: 640, w: 1680, h: 380, rotation: 0 },
  },
  {
    label: 'Top Banner',
    box: { x: 120, y: 80, w: 1680, h: 280, rotation: 0 },
  },
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
      toast(`Theme saved (revision v${updated.rev ?? 1}).`, 'ok');
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
                Visual styling templates for worship songs and lyrics. Sermon decks and announcements imported
                from PowerPoint retain their original slide designs.
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
                    borderRadius: 8,
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
                            style={{ fontSize: 11, padding: '2px 6px', fontWeight: 600 }}
                            title="Applied automatically when pasting or importing new worship songs"
                          >
                            ★ Church Default for Songs
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
                      <span>{t.text.fontSizePx ?? 54}px</span>
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

      {/* VISUAL EDITOR VIEW */}
      {editingId && draft && (
        <div className="col" style={{ gap: 16 }}>
          {/* Header Action Bar */}
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
            <div className="row" style={{ gap: 12, alignItems: 'center' }}>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setEditingId(null);
                  setDraft(null);
                }}
              >
                ← Back to Lyric Themes
              </button>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{draft.name}</h3>
                <span className="tag" style={{ fontSize: 11 }}>
                  v{draft.rev ?? 1}
                </span>
                {draft.id === defaultThemeId ? (
                  <span className="tag green" style={{ fontSize: 11 }}>
                    ★ Church Default for Songs
                  </span>
                ) : (
                  <button
                    type="button"
                    className="small ghost"
                    onClick={() => void makeDefault(draft.id)}
                    title="Set as default theme for new worship songs"
                  >
                    Make Church Default
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

          {/* 2-Column Responsive Layout */}
          <div
            className="theme-editor-grid"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(340px, 540px) minmax(380px, 1fr)',
              gap: 24,
              alignItems: 'start',
            }}
          >
            {/* Left Column: Focused Lyric Styling Controls */}
            <div className="col" style={{ gap: 14 }}>
              <TextField
                label="Theme Name"
                value={draft.name}
                onChange={(name) => setDraft({ ...draft, name })}
              />

              <div className="card col" style={{ gap: 14, padding: 16 }}>
                <div className="col" style={{ gap: 4 }}>
                  <h4 style={{ margin: 0 }}>Worship Lyric Geometry & Typography</h4>
                  <span className="muted small">
                    Controls the positioning, font, outline, and sizing of worship song lyrics.
                  </span>
                </div>

                <BoxEditor value={draft.lyricBox} onChange={(lyricBox) => setDraft({ ...draft, lyricBox })} />

                <TextStyleEditor value={draft.text} onChange={(text) => setDraft({ ...draft, text })} />
              </div>
            </div>

            {/* Right Column: Interactive Canvas & Worship Presets */}
            <div className="col" style={{ position: 'sticky', top: 16, gap: 14 }}>
              <div className="card col" style={{ gap: 12, padding: 16 }}>
                <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="small bold">Interactive Slide Canvas (1920 × 1080)</span>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {PRESET_GEOMETRIES.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className="small"
                        onClick={() => setDraft({ ...draft, lyricBox: { ...preset.box } })}
                        title={`Apply ${preset.label} geometry`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                <ThemeCanvas
                  box={draft.lyricBox}
                  text={draft.text}
                  onChangeBox={(lyricBox) => setDraft({ ...draft, lyricBox })}
                  scenario={activeScenario}
                />

                <div className="col" style={{ gap: 6, marginTop: 4 }}>
                  <span className="muted small">Worship Song Test Scenario:</span>
                  <div className="row wrap" style={{ gap: 4 }}>
                    {TEST_SCENARIOS.map((sc) => (
                      <button
                        key={sc.id}
                        type="button"
                        className={`small ${scenarioId === sc.id ? 'on' : 'ghost'}`}
                        onClick={() => setScenarioId(sc.id)}
                      >
                        {sc.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="muted small" style={{ marginTop: 2, lineHeight: 1.4 }}>
                  Click and drag the box to move; drag corners and edges to resize. Magnetic snapping aligns
                  with center crosshairs and 5% projector safe margins.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
