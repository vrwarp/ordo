import { api } from '@ordo/client';
import { type Box, DEFAULT_THEME, newId, type Theme } from '@ordo/domain';
import { useEffect, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { BoxEditor, TextField } from '../../components/fields.tsx';
import { TextStyleEditor, withFallback } from '../../components/TextStyleEditor.tsx';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { ThemeCanvas } from './ThemeCanvas.tsx';

const TEST_SCENARIOS = [
  {
    id: 'bilingual',
    label: 'Bilingual (EN / 中文)',
    primary: 'Amazing grace how sweet the sound',
    secondary: '奇异恩典，何等甘甜',
  },
  {
    id: 'chorus',
    label: 'Short Chorus',
    primary: 'Hallelujah, glory to the King!',
    secondary: '哈利路亚，荣耀归于君王！',
  },
  {
    id: 'hymn',
    label: '4-Line Verse',
    primary: 'Through many dangers, toils and snares\nI have already come',
    secondary: '历经诸般患难苦痛，今已安然度过\n恩典一路指引扶持，必领我回天家',
  },
  {
    id: 'scripture',
    label: 'Scripture (John 3:16)',
    primary: 'For God so loved the world that He gave His one and only Son',
    secondary: '神爱世人，甚至将祂的独生子赐给他们，叫一切信祂的不至灭亡，反得永生。',
  },
];

const CJK_FONTS = [
  { label: 'PingFang SC / TC (Apple)', value: 'PingFang SC, PingFang TC' },
  { label: 'Noto Sans CJK / 思源黑体 (Cross-platform)', value: 'Noto Sans CJK SC, Noto Sans SC' },
  { label: 'Microsoft YaHei / 微软雅黑 (Windows)', value: 'Microsoft YaHei, SimHei' },
  { label: 'Kaiti / 楷体 (Serif/Calligraphic)', value: 'Kaiti, STKaiti, DFKai-SB' },
  { label: 'System Sans', value: 'sans-serif' },
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

/** Themes: named default lyric and slide box geometry and typography styles. */
export function ThemesPage() {
  const themes = useLibrary((s) => s.data.themes);
  const [selId, setSelId] = useState(themes[0]?.id);
  const theme = themes.find((t) => t.id === selId) ?? themes[0];
  const [draft, setDraft] = useState<Theme | undefined>(theme);
  const [scenarioId, setScenarioId] = useState('bilingual');
  const [tab, setTab] = useState<'primary' | 'secondary'>('primary');

  useEffect(() => setDraft(theme), [theme]);

  const activeScenario = TEST_SCENARIOS.find((s) => s.id === scenarioId) ?? TEST_SCENARIOS[0]!;

  const currentCjk = (draft?.text.fallbackFonts?.[0] as string | undefined) ?? CJK_FONTS[0]!.value;

  const onSelectCjk = (fontVal: string) => {
    if (!draft) return;
    setDraft({ ...draft, text: withFallback(draft.text, fontVal) });
  };

  const saveTheme = async () => {
    if (!draft) return;
    try {
      upsertLocal('themes', await api<Theme>(`/themes/${draft.id}`, { method: 'PUT', json: draft }));
      toast('Theme saved. Apply it to presentations from the editor.', 'ok');
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const create = async () => {
    try {
      const t = await api<Theme>('/themes', {
        method: 'POST',
        json: { ...(theme ?? DEFAULT_THEME), id: newId(), name: 'New theme' },
      });
      upsertLocal('themes', t);
      setSelId(t.id);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const del = async () => {
    if (!theme || !(await confirmDialog('Delete theme', `Delete “${theme.name}”?`, 'Delete', true))) return;
    try {
      await api(`/themes/${theme.id}`, { method: 'DELETE' });
      removeLocal('themes', theme.id);
      setSelId(undefined);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0 }}>Themes & Slide Styling</h2>
          <span className="muted small">
            Themes format the primary text box of worship songs, scripture readings, and sermon slides.
          </span>
        </div>
        <div className="row wrap" style={{ gap: 8 }}>
          {themes.map((t) => (
            <button
              key={t.id}
              type="button"
              className={t.id === theme?.id ? 'on' : ''}
              onClick={() => setSelId(t.id)}
            >
              {t.name}
            </button>
          ))}
          <button type="button" onClick={() => void create()}>
            + Theme
          </button>
        </div>
      </div>

      {draft && (
        <div
          className="theme-editor-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(340px, 580px) minmax(360px, 1fr)',
            gap: 20,
            alignItems: 'start',
          }}
        >
          {/* Left Column: Styling Controls */}
          <div className="col" style={{ gap: 12 }}>
            <TextField
              label="Theme name"
              value={draft.name}
              onChange={(name) => setDraft({ ...draft, name })}
            />

            <div className="row" style={{ gap: 4 }}>
              <button
                type="button"
                className={`small ${tab === 'primary' ? 'on' : ''}`}
                onClick={() => setTab('primary')}
              >
                Primary Slide Text
              </button>
              <button
                type="button"
                className={`small ${tab === 'secondary' ? 'on' : ''}`}
                onClick={() => setTab('secondary')}
              >
                Secondary Text Defaults
              </button>
            </div>

            {tab === 'primary' ? (
              <div className="card col" style={{ gap: 10 }}>
                <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ margin: 0 }}>Primary Slide Text</h4>
                  <span className="muted small">Drag box or handles in preview to resize</span>
                </div>

                <BoxEditor value={draft.lyricBox} onChange={(lyricBox) => setDraft({ ...draft, lyricBox })} />

                <label className="field">
                  <span>Chinese / CJK Fallback Font</span>
                  <select value={currentCjk} onChange={(e) => onSelectCjk(e.target.value)}>
                    {CJK_FONTS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </label>

                <TextStyleEditor value={draft.text} onChange={(text) => setDraft({ ...draft, text })} />
              </div>
            ) : (
              <div className="card col" style={{ gap: 10 }}>
                <h4 style={{ margin: 0 }}>Secondary Text Defaults</h4>
                <p className="muted small" style={{ margin: 0 }}>
                  Used when clicking “+ Text” in the editor to add subtitles, scripture citations, or notes.
                </p>
                <TextStyleEditor
                  value={draft.textBoxDefaults}
                  onChange={(textBoxDefaults) => setDraft({ ...draft, textBoxDefaults })}
                />
              </div>
            )}

            <div className="row" style={{ marginTop: 8 }}>
              <button type="button" className="primary big" onClick={() => void saveTheme()}>
                Save theme
              </button>
              <button
                type="button"
                className="danger"
                disabled={draft.id === DEFAULT_THEME.id}
                onClick={() => void del()}
              >
                Delete
              </button>
            </div>
          </div>

          {/* Right Column: Interactive Canvas & Alignment Presets */}
          <div className="col" style={{ position: 'sticky', top: 20, gap: 12 }}>
            <div className="card col" style={{ gap: 10 }}>
              <div className="row wrap" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="small bold">Interactive Slide Canvas (1920 × 1080)</span>
                <div className="row wrap" style={{ gap: 4 }}>
                  {PRESET_GEOMETRIES.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className="small"
                      onClick={() => setDraft({ ...draft, lyricBox: { ...preset.box } })}
                      title={`Apply ${preset.label} bounds`}
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
                <span className="muted small">Test content scenario:</span>
                <div className="row wrap" style={{ gap: 4 }}>
                  {TEST_SCENARIOS.map((sc) => (
                    <button
                      key={sc.id}
                      type="button"
                      className={`small ${scenarioId === sc.id ? 'on' : ''}`}
                      onClick={() => setScenarioId(sc.id)}
                    >
                      {sc.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="muted small" style={{ marginTop: 2 }}>
                Click and drag the box to move; drag corners and edges to resize. Magnetic snapping aligns
                with center crosshairs and 5% projection margins.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
