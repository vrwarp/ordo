import { api } from '@ordo/client';
import { parseLyrics, type Presentation, sectionSlideTexts, songFromParsed } from '@ordo/domain';
import { useMemo, useState } from 'react';
import { keyed } from '../../lib/keys.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { NumberField } from '../../components/fields.tsx';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { navigate } from '../../useRoute.ts';

/** New song from pasted lyrics with a live section/slide preview before saving (prd/03, prd/05). */
export function NewSongDialog({ onClose, folderId }: { onClose: () => void; folderId?: string }) {
  const general = useLibrary((s) => s.data.settings.general);
  const themes = useLibrary((s) => s.data.themes);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [lps, setLps] = useState(general.defaultLinesPerSlide || 2);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseLyrics(text), [text]);
  const theme = themes.find((t) => t.id === general.defaultThemeId) ?? themes[0];
  const save = async (open: boolean) => {
    setBusy(true);
    try {
      const p: Presentation = songFromParsed(parsed, {
        title: title.trim() || parsed.title || 'Untitled song',
        linesPerSlide: lps,
        theme,
        source: { kind: 'paste' },
      });
      if (folderId) p.folderId = folderId;
      const saved = await api<Presentation>('/presentations', { method: 'POST', json: p });
      upsertLocal('presentations', saved);
      toast(`Saved “${saved.title}”.`, 'ok');
      onClose();
      if (open) navigate({ name: 'edit', id: saved.id });
    } catch (e) {
      toast(`Could not save: ${errorText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const slides = parsed.sections.reduce((n, s) => n + sectionSlideTexts(s, lps).length, 0);
  return (
    <Dialog
      title="New song from lyrics"
      onClose={onClose}
      width={980}
      footer={
        <>
          <span className="muted small grow">
            {parsed.sections.length} sections, {slides} slides
            {parsed.ccli ? ` · CCLI ${parsed.ccli}` : ''}
          </span>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !parsed.sections.length} onClick={() => save(false)}>
            Save
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !parsed.sections.length}
            onClick={() => save(true)}
          >
            Save and edit
          </button>
        </>
      }
    >
      <div className="grid2" style={{ gap: 16 }}>
        <div className="col">
          <input
            placeholder={parsed.title ? `Title (${parsed.title})` : 'Title'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            rows={22}
            autoFocus
            placeholder={
              'Paste lyrics. Label sections with Verse 1, Chorus, Bridge (or V1, C, B).\nBlank lines split slides.'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ fontFamily: 'inherit' }}
          />
          <NumberField label="Lines per slide" value={lps} min={1} max={12} onChange={setLps} />
        </div>
        <div className="col" style={{ maxHeight: 560, overflow: 'auto' }}>
          <h4>Preview</h4>
          {parsed.order.length > 0 && (
            <span className="muted small">Arrangement: {parsed.order.join(' · ')}</span>
          )}
          {parsed.sections.map((s) => (
            <div key={s.label} className="card" style={{ padding: 10 }}>
              <b>{s.label}</b> <span className="tag">{s.short}</span>
              <div className="grid2" style={{ marginTop: 6 }}>
                {keyed(sectionSlideTexts(s, lps), (t) => t).map(({ key, value: t }) => (
                  <div
                    key={key}
                    className="fallback-text"
                    style={{ background: '#000', borderRadius: 4, fontSize: 12 }}
                  >
                    {t}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!parsed.sections.length && <span className="muted">Sections appear here as you paste.</span>}
        </div>
      </div>
    </Dialog>
  );
}
