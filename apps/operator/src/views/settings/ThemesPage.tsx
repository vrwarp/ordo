import { api } from '@ordo/client';
import { DEFAULT_THEME, newId, type Theme } from '@ordo/domain';
import { useEffect, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { BoxEditor, TextField } from '../../components/fields.tsx';
import { TextStyleEditor } from '../../components/TextStyleEditor.tsx';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';

function ThemeWireframe({ theme }: { theme: Theme }) {
  const { lyricBox: box, text } = theme;
  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
  const leftPct = clamp((box.x / 1920) * 100, 0, 100);
  const topPct = clamp((box.y / 1080) * 100, 0, 100);
  const widthPct = clamp((box.w / 1920) * 100, 0, 100 - leftPct);
  const heightPct = clamp((box.h / 1080) * 100, 0, 100 - topPct);

  const c = text.color;
  const col = `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a ?? 1})`;
  const shadow = text.shadow
    ? `${text.shadow.dx * 0.25}px ${text.shadow.dy * 0.25}px ${text.shadow.blur * 0.25}px rgba(${text.shadow.color.r}, ${text.shadow.color.g}, ${text.shadow.color.b}, ${text.shadow.color.a ?? 1})`
    : undefined;

  const vAlignJustify =
    text.valign === 'top' ? 'flex-start' : text.valign === 'bottom' ? 'flex-end' : 'center';

  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ margin: 0 }}>Slide Preview (16:9)</h4>
        <span className="muted small">
          Box: {box.w} × {box.h} at ({box.x}, {box.y})
        </span>
      </div>
      <div
        className="theme-slide-stage"
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '16 / 9',
          background: 'radial-gradient(ellipse at center, #1b2434 0%, #0a0d14 100%)',
          borderRadius: 6,
          border: '1px solid var(--line)',
          overflow: 'hidden',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: '5%',
            border: '1px dashed rgba(255, 255, 255, 0.08)',
            pointerEvents: 'none',
          }}
          title="Safe area"
        />
        <div
          style={{
            position: 'absolute',
            left: `${leftPct}%`,
            top: `${topPct}%`,
            width: `${widthPct}%`,
            height: `${heightPct}%`,
            border: '1.5px dashed #38bdf8',
            backgroundColor: 'rgba(56, 189, 248, 0.06)',
            borderRadius: 4,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: vAlignJustify,
            overflow: 'hidden',
            padding: `${clamp((text.padding ?? 20) * 0.25, 2, 20)}px`,
            boxSizing: 'border-box',
          }}
        >
          <div
            style={{
              fontFamily: text.fontFamily || 'system-ui, sans-serif',
              fontWeight: text.fontWeight ?? 600,
              fontStyle: text.fontStyle ?? 'normal',
              color: col,
              textAlign: text.align ?? 'center',
              lineHeight: text.lineHeight ?? 1.2,
              textTransform: text.transform !== 'none' ? text.transform : undefined,
              textShadow: shadow,
              fontSize: 'clamp(10px, 2.2vw, 22px)',
              userSelect: 'none',
              wordBreak: 'break-word',
            }}
          >
            Amazing grace how sweet the sound
            <br />
            That saved a wretch like me
          </div>
        </div>
        <span
          style={{
            position: 'absolute',
            left: 8,
            top: 6,
            fontSize: 10,
            color: 'rgba(255,255,255,0.4)',
            fontFamily: 'monospace',
          }}
        >
          1920 × 1080
        </span>
      </div>
      <div className="muted small">
        The blue dashed rectangle shows the lyric box boundary. Font style and line wrapping scale with the
        slide width.
      </div>
    </div>
  );
}

/** Themes: named default lyric box geometry and styles (prd/03). */
export function ThemesPage() {
  const themes = useLibrary((s) => s.data.themes);
  const [selId, setSelId] = useState(themes[0]?.id);
  const theme = themes.find((t) => t.id === selId) ?? themes[0];
  const [draft, setDraft] = useState<Theme | undefined>(theme);
  useEffect(() => setDraft(theme), [theme]);
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
      <h2>Themes</h2>
      <div className="row wrap">
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
      {draft && (
        <div
          className="theme-editor-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(340px, 620px) minmax(320px, 480px)',
            gap: 20,
            alignItems: 'start',
          }}
        >
          <div className="col" style={{ gap: 12 }}>
            <TextField label="Name" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
            <div className="card col">
              <h4>Lyric box</h4>
              <BoxEditor value={draft.lyricBox} onChange={(lyricBox) => setDraft({ ...draft, lyricBox })} />
              <TextStyleEditor value={draft.text} onChange={(text) => setDraft({ ...draft, text })} />
            </div>
            <div className="card col">
              <h4>New text boxes</h4>
              <TextStyleEditor
                value={draft.textBoxDefaults}
                onChange={(textBoxDefaults) => setDraft({ ...draft, textBoxDefaults })}
              />
            </div>
            <div className="row">
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
          <div style={{ position: 'sticky', top: 20 }}>
            <ThemeWireframe theme={draft} />
          </div>
        </div>
      )}
    </div>
  );
}
