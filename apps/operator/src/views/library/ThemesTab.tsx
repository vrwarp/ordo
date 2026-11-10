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
    label: '2-Line Chorus',
    text: 'Amazing grace how sweet the sound\nThat saved a wretch like me',
  },
  {
    id: 'verse',
    label: '4-Line Hymn Verse',
    text: 'Through many dangers, toils and snares\nI have already come\n’Tis grace hath brought me safe thus far\nAnd grace will lead me home',
  },
  {
    id: 'impact',
    label: '1-Line Punch',
    text: 'Hallelujah, glory to the King!',
  },
  {
    id: 'scripture',
    label: 'Scripture Passage',
    text: 'For God so loved the world that He gave His only Son, that whoever believes in Him should not perish but have eternal life.',
    citation: '— John 3:16',
  },
];

const PRESET_GEOMETRIES: { label: string; box: Box }[] = [
  {
    label: 'Full Center',
    box: { x: 120, y: 140, w: 1680, h: 800, rotation: 0 },
  },
  {
    label: 'Lower Third',
    box: { x: 120, y: 720, w: 1680, h: 280, rotation: 0 },
  },
  {
    label: 'Top Banner',
    box: { x: 120, y: 80, w: 1680, h: 280, rotation: 0 },
  },
  {
    label: 'Centered Narrow',
    box: { x: 260, y: 140, w: 1400, h: 800, rotation: 0 },
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
  const [tab, setTab] = useState<'primary' | 'secondary'>('primary');

  const onStartEdit = (t: Theme) => {
    setDraft({ ...t });
    setEditingId(t.id);
  };

  const makeDefault = async (themeId: string) => {
    try {
      await saveSettings('general', { ...general, defaultThemeId: themeId });
      toast('Church default presentation theme updated.', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const createTheme = async () => {
    try {
      const base = themes[0] ?? DEFAULT_THEME;
      const t = await api<Theme>('/themes', {
        method: 'POST',
        json: { ...base, id: newId(), name: 'New theme' },
      });
      upsertLocal('themes', t);
      setDraft({ ...t });
      setEditingId(t.id);
      toast('Created new theme.', 'ok');
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
        `Delete “${t.name}”? Any presentations using this theme will keep their current styling.`,
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
              <h2 style={{ margin: 0 }}>Presentation Themes</h2>
              <span className="muted small">
                Visual templates for lyrics, scriptures, and sermon slides. Apply to any presentation from the
                presentation editor.
              </span>
            </div>
            <button type="button" className="primary" onClick={() => void createTheme()}>
              + New Theme
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
                            title="Default theme applied when creating new presentations"
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
                      <ThemeThumbnail box={t.lyricBox} text={t.text} />
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
                          title="Set as church default for newly created presentations"
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
                ← Back to Themes
              </button>
              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{draft.name}</h3>
                <span className="tag" style={{ fontSize: 11 }}>
                  v{draft.rev ?? 1}
                </span>
                {draft.id === defaultThemeId ? (
                  <span className="tag green" style={{ fontSize: 11 }}>
                    ★ Church Default
                  </span>
                ) : (
                  <button type="button" className="small ghost" onClick={() => void makeDefault(draft.id)}>
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
            {/* Left Column: Styling Controls */}
            <div className="col" style={{ gap: 14 }}>
              <TextField
                label="Theme Name"
                value={draft.name}
                onChange={(name) => setDraft({ ...draft, name })}
              />

              <div className="row" style={{ gap: 4 }}>
                <button
                  type="button"
                  className={`small ${tab === 'primary' ? 'on' : 'ghost'}`}
                  onClick={() => setTab('primary')}
                >
                  Primary Slide Text
                </button>
                <button
                  type="button"
                  className={`small ${tab === 'secondary' ? 'on' : 'ghost'}`}
                  onClick={() => setTab('secondary')}
                >
                  Secondary Callouts Defaults
                </button>
              </div>

              {tab === 'primary' ? (
                <div className="card col" style={{ gap: 14, padding: 16 }}>
                  <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <h4 style={{ margin: 0 }}>Primary Slide Text</h4>
                    <span className="muted small">Main worship lyric & scripture box</span>
                  </div>

                  <BoxEditor
                    value={draft.lyricBox}
                    onChange={(lyricBox) => setDraft({ ...draft, lyricBox })}
                  />

                  <TextStyleEditor value={draft.text} onChange={(text) => setDraft({ ...draft, text })} />
                </div>
              ) : (
                <div className="card col" style={{ gap: 14, padding: 16 }}>
                  <div className="col" style={{ gap: 4 }}>
                    <h4 style={{ margin: 0 }}>Secondary Callouts Defaults</h4>
                    <span className="muted small">
                      Used when clicking “+ Text” in the slide editor to add scripture citations, sermon
                      points, or notes.
                    </span>
                  </div>
                  <TextStyleEditor
                    value={draft.textBoxDefaults}
                    onChange={(textBoxDefaults) => setDraft({ ...draft, textBoxDefaults })}
                  />
                </div>
              )}
            </div>

            {/* Right Column: Interactive Canvas & Presets */}
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
                  <span className="muted small">Worship Content Test Scenario:</span>
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
