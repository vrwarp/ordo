import { api } from '@ordo/client';
import { DEFAULT_THEME, newId, type Theme } from '@ordo/domain';
import { useEffect, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { BoxEditor, TextField } from '../../components/fields.tsx';
import { TextStyleEditor } from '../../components/TextStyleEditor.tsx';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';

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
    <div className="col" style={{ gap: 12, maxWidth: 700 }}>
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
        <>
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
        </>
      )}
    </div>
  );
}
