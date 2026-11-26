import { api } from '@ordo/client';
import {
  formatSongCredits,
  parseLyrics,
  type Presentation,
  sectionSlideTexts,
  songFromParsed,
} from '@ordo/domain';
import { useMemo, useState } from 'react';
import { keyed } from '../../lib/keys.ts';
import { Dialog } from '../../components/Dialog.tsx';
import { Check, NumberField } from '../../components/fields.tsx';
import { upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { navigate } from '../../useRoute.ts';

/** New song from pasted lyrics with a live section/slide preview before saving (prd/03, prd/05). */
export function NewSongDialog({ onClose, folderId }: { onClose: () => void; folderId?: string }) {
  const general = useLibrary((s) => s.data.settings.general);
  const themes = useLibrary((s) => s.data.themes);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [ccli, setCcli] = useState('');
  const [copyright, setCopyright] = useState('');
  const [titleSlide, setTitleSlide] = useState(Boolean(general.defaultTitleSlide));
  const [text, setText] = useState('');
  const [lps, setLps] = useState(general.defaultLinesPerSlide || 2);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseLyrics(text), [text]);
  const theme = themes.find((t) => t.id === general.defaultThemeId) ?? themes[0];
  const effTitle = title.trim() || parsed.title || 'Untitled song';
  const effMeta = {
    author: author.trim() || parsed.author,
    ccli: ccli.trim() || parsed.ccli,
    copyright: copyright.trim() || parsed.copyright,
    key: parsed.key,
    tempo: parsed.tempo,
    tags: [] as string[],
  };
  const creditsPreview = formatSongCredits(effMeta, general.ccliLicense);

  const save = async (open: boolean) => {
    setBusy(true);
    try {
      const p: Presentation = songFromParsed(
        {
          ...parsed,
          author: effMeta.author,
          ccli: effMeta.ccli,
          copyright: effMeta.copyright,
        },
        {
          title: effTitle,
          linesPerSlide: lps,
          theme,
          source: { kind: 'paste' },
          titleSlide,
        },
      );
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
  const slides =
    parsed.sections.reduce((n, s) => n + sectionSlideTexts(s, lps).length, 0) + (titleSlide ? 1 : 0);
  return (
    <Dialog
      title="New song from lyrics"
      onClose={onClose}
      width={980}
      footer={
        <>
          <span className="muted small grow">
            {parsed.sections.length} sections, {slides} slides
            {effMeta.ccli ? ` · CCLI ${effMeta.ccli}` : ''}
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
        <div className="col" style={{ gap: 8 }}>
          <input
            placeholder={parsed.title ? `Title (${parsed.title})` : 'Title'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="grid2" style={{ gap: 8 }}>
            <input
              placeholder={parsed.author ? `Author (${parsed.author})` : 'Author / Artist (optional)'}
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
            />
            <input
              placeholder={parsed.ccli ? `CCLI Song # (${parsed.ccli})` : 'CCLI Song # (optional)'}
              value={ccli}
              onChange={(e) => setCcli(e.target.value)}
            />
          </div>
          <input
            placeholder={
              parsed.copyright ? `Copyright (${parsed.copyright})` : 'Copyright (e.g. 2020 Publisher)'
            }
            value={copyright}
            onChange={(e) => setCopyright(e.target.value)}
          />
          <textarea
            rows={18}
            autoFocus
            placeholder={
              'Paste lyrics. Label sections with Verse 1, Chorus, Bridge (or V1, C, B).\nBlank lines split slides.'
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ fontFamily: 'inherit' }}
          />
          <div
            className="row wrap"
            style={{ gap: 12, alignItems: 'center', justifyContent: 'space-between' }}
          >
            <NumberField label="Lines per slide" value={lps} min={1} max={12} onChange={setLps} />
            <Check
              label="Include Title Slide (Title, Author, CCLI)"
              value={titleSlide}
              onChange={setTitleSlide}
            />
          </div>
        </div>
        <div className="col" style={{ maxHeight: 560, overflow: 'auto', gap: 8 }}>
          <h4>Preview</h4>
          {parsed.order.length > 0 && (
            <span className="muted small">
              Arrangement: {titleSlide ? `Title · ${parsed.order.join(' · ')}` : parsed.order.join(' · ')}
            </span>
          )}
          {titleSlide && (
            <div className="card" style={{ padding: 10, borderColor: 'rgba(56, 189, 248, 0.45)' }}>
              <b>Title Slide</b> <span className="tag">TTL</span>
              <div
                className="fallback-text"
                style={{
                  background: '#000',
                  borderRadius: 4,
                  fontSize: 12,
                  marginTop: 6,
                  padding: '10px 8px',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 13 }}>{effTitle}</div>
                {creditsPreview && (
                  <div className="muted" style={{ fontSize: 10.5, marginTop: 4, whiteSpace: 'pre-line' }}>
                    {creditsPreview}
                  </div>
                )}
              </div>
            </div>
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
