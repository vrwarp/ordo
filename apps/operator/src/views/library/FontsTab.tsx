import { api, upload } from '@ordo/client';
import type { Font } from '@ordo/domain';
import { useMemo, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { GoogleFontsDialog } from '../../components/FontPicker.tsx';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { DropZone } from './MediaTab.tsx';

/** Fonts on the hub: upload TTF/OTF/WOFF/WOFF2, add Google Fonts, delete (prd/05). */
export function FontsTab() {
  const fonts = useLibrary((s) => s.data.fonts);
  const [google, setGoogle] = useState(false);
  const [busy, setBusy] = useState(0);
  const families = useMemo(() => {
    const m = new Map<string, Font[]>();
    for (const f of fonts) m.set(f.family, [...(m.get(f.family) ?? []), f]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [fonts]);
  const onFiles = async (files: File[]) => {
    for (const f of files) {
      setBusy(0.01);
      const fd = new FormData();
      fd.append('file', f, f.name);
      try {
        const res = await upload<Font[] | Font>('/fonts/upload', fd, (x) => setBusy(Math.max(0.01, x)));
        for (const font of Array.isArray(res) ? res : [res]) upsertLocal('fonts', font);
        toast(`Added ${f.name}.`, 'ok');
      } catch (e) {
        toast(`${f.name}: ${errorText(e)}`, 'error');
      }
    }
    setBusy(0);
  };
  const del = async (f: Font) => {
    if (!(await confirmDialog('Delete font', `Delete ${f.family} ${f.weight} ${f.style}? Text using it falls back to another font.`, 'Delete', true)))
      return;
    try {
      await api(`/fonts/${f.id}`, { method: 'DELETE' });
      removeLocal('fonts', f.id);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };
  return (
    <div className="page-pad col" style={{ maxWidth: 900, overflow: 'auto', height: '100%' }}>
      <div className="row">
        <div className="grow">
          <DropZone accept=".ttf,.otf,.woff,.woff2" label="Drop TTF, OTF, WOFF or WOFF2 files (or click)" onFiles={(f) => void onFiles(f)} />
        </div>
        <button type="button" className="primary big" onClick={() => setGoogle(true)}>
          Add from Google Fonts
        </button>
      </div>
      {busy > 0 && (
        <div className="progress">
          <i style={{ width: `${busy * 100}%` }} />
        </div>
      )}
      <p className="muted small">Every output loads these files from the hub or the service cache, so text matches on every screen even offline.</p>
      <table className="list">
        <thead>
          <tr>
            <th>Family</th>
            <th>Styles</th>
            <th>Source</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {families.map(([family, list]) => (
            <tr key={family}>
              <td style={{ fontFamily: family, fontSize: 18 }}>{family}</td>
              <td>
                <div className="row wrap" style={{ gap: 4 }}>
                  {list
                    .sort((a, b) => a.weight - b.weight)
                    .map((f) => (
                      <span key={f.id} className="tag" style={{ fontFamily: family, fontWeight: f.weight, fontStyle: f.style }}>
                        {f.weight} {f.style}{' '}
                        <button type="button" className="ghost small" style={{ minHeight: 18, padding: 0 }} onClick={() => void del(f)}>
                          ✕
                        </button>
                      </span>
                    ))}
                </div>
              </td>
              <td className="muted">{[...new Set(list.map((f) => f.source))].join(', ')}</td>
              <td />
            </tr>
          ))}
        </tbody>
      </table>
      {!fonts.length && <span className="muted">No fonts uploaded yet. Inter and system fonts are used until you add some.</span>}
      {google && <GoogleFontsDialog onClose={() => setGoogle(false)} />}
    </div>
  );
}
