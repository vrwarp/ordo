import { api } from '@ordo/client';
import type { Presentation, Slide } from '@ordo/domain';
import { useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { NumberField, TextField } from '../../components/fields.tsx';
import { useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { BackgroundPicker } from './BackgroundPicker.tsx';
import { change, replaceBase, save, useEditor } from './editorStore.ts';
import { SlideSoundPanel } from './MediaPanels.tsx';
import { resetSlideToTheme, themeOf, updateSlide } from './ops.ts';
import { PptxSlideCard } from './PptxSlideCard.tsx';

/**
 * Slide-level properties: lyric box, background override, the slide's own sound, loop duration, notes, theme
 * overrides, import.
 */
export function SlidePanel({ slide, p, readOnly }: { slide: Slide; p: Presentation; readOnly: boolean }) {
  const themes = useLibrary((s) => s.data.themes);
  const media = useLibrary((s) => s.data.media);
  const dirty = useEditor((s) => s.dirty);
  const [busy, setBusy] = useState(false);
  const set = (fn: (s: Slide) => Slide, key?: string) =>
    !readOnly && change((q) => updateSlide(q, slide.id, fn), key);
  const texts = slide.objects.filter((o) => o.type === 'text');
  const makeEditable = async () => {
    const ok = await confirmDialog(
      'Make this slide editable',
      'Text boxes are created from the PowerPoint text with approximate position and size. The rendered page stays as the background until you remove it.\n\nFonts will not match PowerPoint exactly.',
      'Make editable',
    );
    if (!ok) return;
    if (dirty && !(await save())) return;
    setBusy(true);
    try {
      const res = await api<Presentation>(`/presentations/${p.id}/slides/${slide.id}/make-editable`, {
        method: 'POST',
      });
      replaceBase(res);
      toast('Slide converted. Check fonts and positions: they are approximate.', 'warn', 8000);
    } catch (e) {
      toast(`Could not convert: ${errorText(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 10 }}>
      <b>Slide</b>
      {texts.length > 0 && (
        <label className="field">
          <span>Lyric box (read by lower-third and stage looks)</span>
          <select
            value={slide.lyricObjectId ?? ''}
            disabled={readOnly}
            onChange={(e) => set((s) => ({ ...s, lyricObjectId: e.target.value || undefined }))}
          >
            <option value="">First text box</option>
            {texts.map((t, i) => (
              <option key={t.id} value={t.id}>
                {i + 1}: {(t.type === 'text' ? t.text : '').slice(0, 30) || '(empty)'}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Background for this slide only</span>
        <BackgroundPicker
          value={slide.backgroundMediaId}
          disabled={readOnly}
          onChange={(backgroundMediaId) => set((s) => ({ ...s, backgroundMediaId }))}
        />
      </label>
      <SlideSoundPanel slide={slide} media={(id) => media.find((m) => m.id === id)} readOnly={readOnly} />
      {p.kind === 'loop' && (
        <NumberField
          label="Duration (seconds)"
          value={(slide.durationMs ?? p.loop?.defaultSlideMs ?? 8000) / 1000}
          min={1}
          max={600}
          step={0.5}
          onChange={(v) => set((s) => ({ ...s, durationMs: Math.round(v * 1000) }))}
        />
      )}
      {(slide.hidden || slide.pptx) && (
        <label className="check" data-hidden-toggle>
          <input
            type="checkbox"
            checked={!!slide.hidden}
            disabled={readOnly}
            onChange={(e) => set((s) => ({ ...s, hidden: e.target.checked || undefined }))}
          />
          Hidden: Next skips it, a click in the slide grid shows it (as in PowerPoint)
        </label>
      )}
      <TextField
        label="Notes"
        multiline
        rows={3}
        value={slide.notes ?? ''}
        disabled={readOnly}
        onChange={(notes) => set((s) => ({ ...s, notes: notes || undefined }), `notes:${slide.id}`)}
      />
      {slide.overrides && slide.overrides.length > 0 && (
        <div className="col">
          <span className="override-mark">
            ● This slide overrides the theme: {slide.overrides.join(', ')}
          </span>
          <button
            type="button"
            className="small"
            disabled={readOnly}
            onClick={() => set((s) => resetSlideToTheme(s, themeOf(p, themes)))}
          >
            Reset to theme
          </button>
        </div>
      )}
      <PptxSlideCard slide={slide} p={p} readOnly={readOnly} />
      {slide.imported && (
        <div className="card col small">
          <span>
            Imported page {slide.imported.page}
            {slide.imported.textBoxes?.length ? ` · ${slide.imported.textBoxes.length} text runs found` : ''}
          </span>
          {slide.imported.textBoxes?.length ? (
            <button
              type="button"
              className="small"
              disabled={readOnly || busy}
              onClick={() => void makeEditable()}
            >
              Make editable
            </button>
          ) : (
            <span className="muted">No extractable text (PDF pages stay images).</span>
          )}
          {slide.objects.length > 0 && (
            <button
              type="button"
              className="small"
              disabled={readOnly}
              onClick={() => set((s) => ({ ...s, imported: undefined }))}
            >
              Remove the original page image
            </button>
          )}
        </div>
      )}
    </div>
  );
}
