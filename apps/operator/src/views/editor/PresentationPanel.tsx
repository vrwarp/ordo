import { type Arrangement, newId, type Presentation } from '@ordo/domain';
import { useState } from 'react';
import { ArrangementEditor } from '../../components/ArrangementEditor.tsx';
import { confirmDialog } from '../../components/Confirm.tsx';
import { NumberField, Select, TextField, TransitionEditor } from '../../components/fields.tsx';
import { authoringArrangement, upsertArrangement } from '../../lib/arrangement.ts';
import { useLibrary } from '../../state/library.ts';
import { BackgroundPicker } from './BackgroundPicker.tsx';
import { ReplaceOnAllSlides } from './BackgroundReplace.tsx';
import { change } from './editorStore.ts';
import { applyTheme, themeChangeCount } from './ops.ts';
import { PptxReport } from './PptxReport.tsx';

/** Presentation metadata, theme, background, transition, loop timing and arrangements. */
export function PresentationPanel({ p, readOnly }: { p: Presentation; readOnly: boolean }) {
  const themes = useLibrary((s) => s.data.themes);
  const [theme, setTheme] = useState(p.themeId ?? '');
  const set = (fn: (q: Presentation) => Presentation, key?: string) => !readOnly && change(fn, key);
  const meta = p.meta;
  const applyChosen = async () => {
    const t = themes.find((x) => x.id === theme);
    if (!t) return;
    const n = themeChangeCount(p, t);
    const ok = await confirmDialog(
      'Apply lyric theme',
      `Apply “${t.name}” to this presentation's lyric slides? ${n} slide${n === 1 ? '' : 's'} will change. Per-slide overrides are kept.`,
      'Apply',
    );
    if (ok) set((q) => applyTheme(q, t));
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      {/* 1. Identity & Classification (Type is fixed at creation) */}
      <TextField
        label="Title"
        value={p.title}
        disabled={readOnly}
        onChange={(title) => set((q) => ({ ...q, title }), 'title')}
      />
      <div className="field">
        <span className="label">Type</span>
        <div className="row" style={{ alignItems: 'center', gap: 8, padding: '4px 0' }}>
          <span
            className="tag"
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: '4px 10px',
              borderRadius: 6,
              background: 'var(--bg3)',
              border: '1px solid var(--line)',
              color: 'var(--fg)',
            }}
          >
            {p.kind === 'song'
              ? '🎵 Worship Song'
              : p.kind === 'loop'
                ? '🔁 Announcement Loop (Auto-advance)'
                : '📊 Slide Deck (Sermon / Presentation)'}
          </span>
        </div>
      </div>
      <TextField
        label="Tags (comma separated)"
        value={(meta.tags ?? []).join(', ')}
        disabled={readOnly}
        commitOnBlur
        onChange={(t) =>
          set((q) => ({
            ...q,
            meta: {
              ...q.meta,
              tags: t
                .split(',')
                .map((x) => x.trim())
                .filter(Boolean),
            },
          }))
        }
      />

      {/* 2. Announcement Loop Settings */}
      {p.kind === 'loop' && (
        <div className="col" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <span
            className="small bold"
            style={{ textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg2)' }}
          >
            Loop Playback
          </span>
          <NumberField
            label="Default slide duration (seconds)"
            value={(p.loop?.defaultSlideMs ?? 8000) / 1000}
            min={1}
            max={600}
            step={0.5}
            onChange={(v) => set((q) => ({ ...q, loop: { defaultSlideMs: Math.round(v * 1000) } }))}
          />
          <span className="muted small">
            Slides auto-advance on-air and loop continuously. Individual slides can override their duration in
            the Slide tab.
          </span>
        </div>
      )}

      {/* 3. Worship Song Specific Metadata, Theme & Arrangements */}
      {p.kind === 'song' && (
        <div className="col" style={{ gap: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <span
            className="small bold"
            style={{ textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg2)' }}
          >
            Worship & Musical Details
          </span>
          <div className="grid2">
            <TextField
              label="Author"
              value={meta.author ?? ''}
              disabled={readOnly}
              onChange={(author) =>
                set((q) => ({ ...q, meta: { ...q.meta, author: author || undefined } }), 'author')
              }
            />
            <TextField
              label="CCLI number"
              value={meta.ccli ?? ''}
              disabled={readOnly}
              onChange={(ccli) =>
                set((q) => ({ ...q, meta: { ...q.meta, ccli: ccli || undefined } }), 'ccli')
              }
            />
            <TextField
              label="Key"
              value={meta.key ?? ''}
              disabled={readOnly}
              onChange={(key) => set((q) => ({ ...q, meta: { ...q.meta, key: key || undefined } }), 'key')}
            />
            <NumberField
              label="Tempo (BPM)"
              value={meta.tempo ?? 0}
              min={0}
              disabled={readOnly}
              onChange={(tempo) => set((q) => ({ ...q, meta: { ...q.meta, tempo: tempo || undefined } }))}
            />
          </div>
          <TextField
            label="Copyright"
            value={meta.copyright ?? ''}
            disabled={readOnly}
            onChange={(copyright) =>
              set((q) => ({ ...q, meta: { ...q.meta, copyright: copyright || undefined } }), 'copyright')
            }
          />

          <NumberField
            label="Lines per slide (for new slides from lyrics)"
            value={p.linesPerSlide ?? 2}
            min={1}
            max={12}
            disabled={readOnly}
            onChange={(linesPerSlide) => set((q) => ({ ...q, linesPerSlide }))}
          />

          <ArrangementsSection p={p} readOnly={readOnly} />
        </div>
      )}

      {/* 4. Theme & Formatting (Songs and Slide decks) */}
      {p.kind !== 'loop' && (
        <div className="col" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <span
            className="small bold"
            style={{ textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg2)' }}
          >
            {p.kind === 'song' ? 'Lyric Theme' : 'Theme'}
          </span>
          <label className="field">
            <span>Theme</span>
            <div className="row">
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
                disabled={readOnly}
                className="grow"
              >
                <option value="">No theme</option>
                {themes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.id === p.themeId ? ' (current)' : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="small"
                disabled={readOnly || !theme}
                onClick={() => void applyChosen()}
              >
                Apply…
              </button>
            </div>
          </label>
        </div>
      )}

      {/* 4. Slides / Deck Specific Reports */}
      {p.kind === 'slides' && (
        <div className="col" style={{ gap: 8, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <PptxReport p={p} readOnly={readOnly} />
          <span className="muted small">
            PowerPoint sermon and announcement slides retain their imported layouts.
          </span>
        </div>
      )}

      {/* 5. Universal Slide Defaults (Background & Transition) */}
      <div className="col" style={{ gap: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
        <span
          className="small bold"
          style={{ textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--fg2)' }}
        >
          Slide Defaults
        </span>
        <label className="field">
          <span>Default background</span>
          <BackgroundPicker
            value={p.backgroundMediaId}
            disabled={readOnly}
            onChange={(backgroundMediaId) => set((q) => ({ ...q, backgroundMediaId }))}
          />
        </label>
        <ReplaceOnAllSlides p={p} readOnly={readOnly} />
        <label className="field">
          <span>Transition</span>
          <TransitionEditor
            value={p.transition}
            allowInherit
            onChange={(transition) => set((q) => ({ ...q, transition }))}
          />
        </label>
      </div>
    </div>
  );
}

function ArrangementsSection({ p, readOnly }: { p: Presentation; readOnly: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const list = p.arrangements;
  const update = (a: Arrangement) => change((q) => upsertArrangement(q, a));
  return (
    <section className="col">
      <h4>Arrangements</h4>
      {list.length === 0 && (
        <span className="muted small">
          Authoring order is used. Add an arrangement to reorder or repeat sections.
        </span>
      )}
      {list.map((a, i) => (
        <div key={a.id} className="card col" style={{ padding: 8 }}>
          <div className="row">
            <input
              value={a.name}
              disabled={readOnly}
              onChange={(e) => update({ ...a, name: e.target.value })}
              className="grow"
            />
            {i === 0 && <span className="tag">default</span>}
            <button type="button" className="small" onClick={() => setOpen(open === a.id ? null : a.id)}>
              {open === a.id ? 'Done' : 'Edit'}
            </button>
            {!readOnly && i > 0 && (
              <button
                type="button"
                className="small"
                title="Make default"
                onClick={() =>
                  change((q) => ({ ...q, arrangements: [a, ...q.arrangements.filter((x) => x.id !== a.id)] }))
                }
              >
                ★<span className="touch-label">Make default</span>
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                className="small ghost"
                onClick={() =>
                  change((q) => ({ ...q, arrangements: q.arrangements.filter((x) => x.id !== a.id) }))
                }
              >
                ✕<span className="touch-label">Delete</span>
              </button>
            )}
          </div>
          {open === a.id ? (
            <ArrangementEditor presentation={p} value={a} onChange={update} disabled={readOnly} />
          ) : (
            <span className="muted small">
              {a.sectionIds.map((id) => p.sections.find((s) => s.id === id)?.short ?? '?').join(' ')}
            </span>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          className="small"
          onClick={() => {
            const a = list[0]
              ? { ...list[0], id: newId(), name: `Arrangement ${list.length + 1}` }
              : authoringArrangement(p);
            change((q) => upsertArrangement(q, a));
            setOpen(a.id);
          }}
        >
          + New arrangement
        </button>
      )}
    </section>
  );
}
