import { type Arrangement, newId, type Presentation } from '@ordo/domain';
import { useState } from 'react';
import { ArrangementEditor } from '../../components/ArrangementEditor.tsx';
import { confirmDialog } from '../../components/Confirm.tsx';
import { NumberField, Select, TextField, TransitionEditor } from '../../components/fields.tsx';
import { authoringArrangement, upsertArrangement } from '../../lib/arrangement.ts';
import { useLibrary } from '../../state/library.ts';
import { BackgroundPicker } from './BackgroundPicker.tsx';
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
      'Apply theme',
      `Apply “${t.name}” to this presentation? ${n} slide${n === 1 ? '' : 's'} will change. Per-slide overrides are kept.`,
      'Apply',
    );
    if (ok) set((q) => applyTheme(q, t));
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <TextField
        label="Title"
        value={p.title}
        disabled={readOnly}
        onChange={(title) => set((q) => ({ ...q, title }), 'title')}
      />
      <Select
        label="Type"
        value={p.kind}
        disabled={readOnly}
        options={[
          { value: 'song', label: 'Song' },
          { value: 'slides', label: 'Slides (sermon, announcements)' },
          { value: 'loop', label: 'Announcement loop (auto-advance)' },
        ]}
        onChange={(kind) =>
          set((q) => ({ ...q, kind, loop: kind === 'loop' ? (q.loop ?? { defaultSlideMs: 8000 }) : q.loop }))
        }
      />
      {p.kind === 'loop' && (
        <NumberField
          label="Default slide duration (seconds)"
          value={(p.loop?.defaultSlideMs ?? 8000) / 1000}
          min={1}
          max={600}
          step={0.5}
          onChange={(v) => set((q) => ({ ...q, loop: { defaultSlideMs: Math.round(v * 1000) } }))}
        />
      )}
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
          onChange={(ccli) => set((q) => ({ ...q, meta: { ...q.meta, ccli: ccli || undefined } }), 'ccli')}
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
      {p.kind === 'song' && (
        <NumberField
          label="Lines per slide (for new slides from lyrics)"
          value={p.linesPerSlide ?? 2}
          min={1}
          max={12}
          disabled={readOnly}
          onChange={(linesPerSlide) => set((q) => ({ ...q, linesPerSlide }))}
        />
      )}
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
      <label className="field">
        <span>Default background</span>
        <BackgroundPicker
          value={p.backgroundMediaId}
          disabled={readOnly}
          onChange={(backgroundMediaId) => set((q) => ({ ...q, backgroundMediaId }))}
        />
      </label>
      <label className="field">
        <span>Transition</span>
        <TransitionEditor
          value={p.transition}
          allowInherit
          onChange={(transition) => set((q) => ({ ...q, transition }))}
        />
      </label>
      <ArrangementsSection p={p} readOnly={readOnly} />
      <PptxReport p={p} readOnly={readOnly} />
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
