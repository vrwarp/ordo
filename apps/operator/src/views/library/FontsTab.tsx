import { api, upload } from '@ordo/client';
import type { Font } from '@ordo/domain';
import { useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { GoogleFontsDialog } from '../../components/FontPicker.tsx';
import { Icon } from '../../components/Icons.tsx';
import { SplitPane } from '../../components/SplitPane.tsx';
import { removeLocal, upsertLocal, useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';

/** Fonts on the hub: 2-pane docked Font Library & Live Specimen Inspector (prd/05, design/30). */
export function FontsTab() {
  const fonts = useLibrary((s) => s.data.fonts);
  const [google, setGoogle] = useState(false);
  const [busy, setBusy] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [selectedFamily, setSelectedFamily] = useState<string | undefined>(undefined);
  const [sampleText, setSampleText] = useState(
    'Amazing grace, how sweet the sound\nThat saved a wretch like me',
  );
  const fileRef = useRef<HTMLInputElement>(null);

  const families = useMemo(() => {
    const m = new Map<string, Font[]>();
    for (const f of fonts) m.set(f.family, [...(m.get(f.family) ?? []), f]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [fonts]);

  const activeEntry = families.find(([fam]) => fam === selectedFamily) ?? families[0];

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
    if (
      !(await confirmDialog(
        'Delete font',
        `Delete ${f.family} ${f.weight} ${f.style}? Text using it falls back to another font.`,
        'Delete',
        true,
      ))
    )
      return;
    try {
      await api(`/fonts/${f.id}`, { method: 'DELETE' });
      removeLocal('fonts', f.id);
    } catch (e) {
      toast(errorText(e), 'error');
    }
  };

  const delFamily = async (family: string, list: Font[]) => {
    if (
      !(await confirmDialog(
        'Delete font family',
        `Delete all ${list.length} styles of “${family}”? Text using it falls back to another font.`,
        'Delete',
        true,
      ))
    )
      return;
    for (const f of list) {
      try {
        await api(`/fonts/${f.id}`, { method: 'DELETE' });
        removeLocal('fonts', f.id);
      } catch (err) {
        toast(errorText(err), 'error');
      }
    }
  };

  return (
    <div
      style={{ position: 'relative', height: '100%', minHeight: 0 }}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = [...e.dataTransfer.files];
        if (files.length) void onFiles(files);
      }}
    >
      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".ttf,.otf,.woff,.woff2"
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (files.length) void onFiles(files);
        }}
      />

      <SplitPane
        storageKey="library-fonts-split"
        panels={[
          {
            id: 'fonts-list',
            size: 380,
            min: 280,
            max: 560,
            content: (
              <div className="studio-sidebar">
                <div className="pl-pane-head" style={{ justifyContent: 'space-between' }}>
                  <span className="prop-section-title" style={{ margin: 0 }}>
                    Hub Fonts ({families.length})
                  </span>
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className="small" onClick={() => fileRef.current?.click()}>
                      <Icon name="upload" size={13} />
                      Upload
                    </button>
                    <button type="button" className="primary small" onClick={() => setGoogle(true)}>
                      <Icon name="plus" size={13} />
                      Google Fonts
                    </button>
                  </div>
                </div>
                {busy > 0 && (
                  <div className="progress" style={{ borderRadius: 0 }}>
                    <i style={{ width: `${busy * 100}%` }} />
                  </div>
                )}
                <div className="pl-pane-scroll">
                  {families.map(([family, list]) => {
                    const isSel = activeEntry?.[0] === family;
                    return (
                      <button
                        key={family}
                        type="button"
                        className={`studio-list-row${isSel ? ' sel' : ''}`}
                        onClick={() => setSelectedFamily(family)}
                        onContextMenu={(e) => {
                          openContextMenu(
                            e,
                            [
                              {
                                label: 'Copy font family name',
                                onSelect: () => void navigator.clipboard?.writeText?.(family),
                              },
                              { kind: 'separator' },
                              {
                                label: `Delete all ${list.length} ${list.length === 1 ? 'style' : 'styles'}…`,
                                danger: true,
                                onSelect: () => void delFamily(family, list),
                              },
                            ],
                            { ariaLabel: `${family} font family actions` },
                          );
                        }}
                      >
                        <div className="col grow" style={{ minWidth: 0, gap: 2 }}>
                          <span
                            className="ellipsis"
                            style={{ fontFamily: family, fontSize: 16, fontWeight: 600 }}
                          >
                            {family}
                          </span>
                          <span className="muted small">
                            {list.length} {list.length === 1 ? 'weight' : 'weights'} ·{' '}
                            {[...new Set(list.map((f) => f.source))].join(', ')}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                  {!fonts.length && (
                    <div className="col" style={{ padding: 20, gap: 10 }}>
                      <span className="muted">
                        No fonts uploaded yet. Inter and system fonts are used until you add custom fonts.
                      </span>
                      <span className="muted small">
                        Drop TTF, OTF, WOFF, or WOFF2 files anywhere in this window, or add directly from
                        Google Fonts. Every output caches these files offline so slides match across all
                        screens.
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ),
          },
          {
            id: 'fonts-specimen',
            content: (
              <div className="pl-pane">
                <div className="pl-pane-head" style={{ justifyContent: 'space-between' }}>
                  <span className="prop-section-title" style={{ margin: 0 }}>
                    {activeEntry ? `Specimen · ${activeEntry[0]}` : 'Font Specimen Preview'}
                  </span>
                  {activeEntry && (
                    <button
                      type="button"
                      className="small danger ghost"
                      onClick={() => void delFamily(activeEntry[0], activeEntry[1])}
                    >
                      <Icon name="trash" size={13} />
                      Delete Family
                    </button>
                  )}
                </div>
                <div className="studio-well" style={{ padding: 20 }}>
                  {activeEntry ? (
                    <div className="col" style={{ gap: 20, maxWidth: 820 }}>
                      <div className="col" style={{ gap: 6 }}>
                        <span className="prop-section-title">Live Lyric Specimen</span>
                        <textarea
                          rows={2}
                          value={sampleText}
                          onChange={(e) => setSampleText(e.target.value)}
                          style={{
                            fontFamily: activeEntry[0],
                            fontSize: 28,
                            fontWeight: 600,
                            lineHeight: 1.35,
                            padding: 16,
                            textAlign: 'center',
                          }}
                        />
                      </div>

                      <div className="col" style={{ gap: 10 }}>
                        <span className="prop-section-title">Installed Weights &amp; Styles</span>
                        {activeEntry[1]
                          .slice()
                          .sort((a, b) => a.weight - b.weight)
                          .map((f) => (
                            <div
                              key={f.id}
                              className="row"
                              style={{
                                padding: '12px 16px',
                                background: 'var(--panel)',
                                border: '1px solid var(--line)',
                                borderRadius: 4,
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 12,
                              }}
                            >
                              <div className="col grow" style={{ minWidth: 0, gap: 4 }}>
                                <span
                                  className="ellipsis"
                                  style={{
                                    fontFamily: activeEntry[0],
                                    fontWeight: f.weight,
                                    fontStyle: f.style,
                                    fontSize: 20,
                                  }}
                                >
                                  {sampleText.split('\n')[0] || activeEntry[0]}
                                </span>
                                <span className="muted small">
                                  Weight {f.weight} · {f.style} · {f.source}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="small ghost danger"
                                onClick={() => void del(f)}
                                aria-label={`Delete ${f.family} ${f.weight} ${f.style}`}
                              >
                                <Icon name="trash" size={13} />
                                Delete
                              </button>
                            </div>
                          ))}
                      </div>
                    </div>
                  ) : (
                    <div className="center col" style={{ gap: 12, height: '100%' }}>
                      <Icon name="font" size={32} className="muted" />
                      <span className="muted">
                        Drop TTF / OTF / WOFF2 files anywhere or add from Google Fonts to preview specimens.
                      </span>
                      <div className="row" style={{ gap: 8 }}>
                        <button type="button" onClick={() => fileRef.current?.click()}>
                          <Icon name="upload" size={14} />
                          Choose font files…
                        </button>
                        <button type="button" className="primary" onClick={() => setGoogle(true)}>
                          Add from Google Fonts
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ),
          },
        ]}
      />

      {dragOver && (
        <div className="drop-overlay">
          <Icon name="upload" size={28} />
          <strong>Drop font files (.ttf, .otf, .woff, .woff2) to install on hub</strong>
        </div>
      )}
      {google && <GoogleFontsDialog onClose={() => setGoogle(false)} />}
    </div>
  );
}
