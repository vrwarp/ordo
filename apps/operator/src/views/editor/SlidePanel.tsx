import { api } from '@ordo/client';
import { type Presentation, type Slide, strapText } from '@ordo/domain';
import type { Job } from '@ordo/protocol';
import { useState } from 'react';
import { confirmDialog } from '../../components/Confirm.tsx';
import { NumberField, TextField } from '../../components/fields.tsx';
import { useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { SlideBackgroundSection } from './BackgroundReplace.tsx';
import { change, replaceBase, save, useEditor } from './editorStore.ts';
import { SlideSoundPanel } from './MediaPanels.tsx';
import { SlideMidiCues } from './SlideMidiCues.tsx';
import { resetSlideToTheme, themeOf, updateSlide } from './ops.ts';
import { PptxSlideCard } from './PptxSlideCard.tsx';
import { followReimport, isJob, rebuildsFromPptx } from './pptxJobs.ts';

export async function makeSlideEditable(
  slide: Slide,
  p: Presentation,
  dirty: boolean,
  setBusy?: (busy: boolean) => void,
): Promise<void> {
  // A PowerPoint page is rebuilt from the stored file (M4 item F, the hub's re-import of this slide);
  // anything else (a PDF page, a file no longer stored) gets text boxes over the page picture.
  const native = rebuildsFromPptx(p, slide);
  const ok = await confirmDialog(
    'Make this slide editable',
    native
      ? 'ordo rebuilds this slide from the PowerPoint file: its text, pictures and shapes become objects you can edit, in place of the page picture. Objects you added stay on top, and its notes stay.'
      : 'Text boxes are created from the PowerPoint text with approximate position and size. The rendered page stays as the background until you remove it.\n\nFonts will not match PowerPoint exactly.',
    'Make editable',
  );
  if (!ok) return;
  if (dirty && !(await save())) return;
  setBusy?.(true);
  try {
    const res = await api<Presentation | Job>(`/presentations/${p.id}/slides/${slide.id}/make-editable`, {
      method: 'POST',
    });
    if (isJob(res)) {
      await followReimport(p.id, res, 'make-editable', slide.id);
      return;
    }
    replaceBase(res);
    toast('Slide converted. Check fonts and positions: they are approximate.', 'warn', 8000);
  } catch (e) {
    toast(`Could not convert: ${errorText(e)}`, 'error');
  } finally {
    setBusy?.(false);
  }
}

/**
 * Slide-level properties: lyric box, background override, the slide's own sound, loop duration, notes, theme
 * overrides, import.
 */
export function SlidePanel({ slide, p, readOnly }: { slide: Slide; p: Presentation; readOnly: boolean }) {
  const themes = useLibrary((s) => s.data.themes);
  const media = useLibrary((s) => s.data.media);
  const dirty = useEditor((s) => s.dirty);
  const [busy, setBusy] = useState(false);
  const [editingStrapFor, setEditingStrapFor] = useState<string | null>(null);
  const set = (fn: (s: Slide) => Slide, key?: string) =>
    !readOnly && change((q) => updateSlide(q, slide.id, fn), key);
  const texts = slide.objects.filter((o) => o.type === 'text');
  const defaultStrap = slide.scripture
    ? `${slide.scripture.ref.book} ${slide.scripture.ref.chapter}:${slide.scripture.ref.verseFrom}${slide.scripture.ref.verseTo ? `-${slide.scripture.ref.verseTo}` : ''}\n${slide.scripture.text}`
    : strapText(slide);
  const strapShown =
    editingStrapFor === slide.id ||
    (slide.bottomThirdText !== undefined
      ? slide.bottomThirdText.trim().length > 0
      : defaultStrap.trim().length > 0);
  const makeEditable = () => makeSlideEditable(slide, p, dirty, setBusy);
  return (
    <div className="col" style={{ gap: 10 }}>
      <b>Slide</b>
      {p.kind === 'song' && texts.length > 1 && (
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
      {p.kind === 'slides' && (
        <div className="card col small" style={{ gap: 6, padding: 8 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <label className="check" style={{ fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={strapShown}
                disabled={readOnly}
                onChange={(e) => {
                  const on = e.target.checked;
                  setEditingStrapFor(on ? slide.id : null);
                  set((s) => ({
                    ...s,
                    bottomThirdText: on ? (s.bottomThirdText ? s.bottomThirdText : defaultStrap) : '',
                  }));
                }}
              />
              Show on Bottom-Third Stream
            </label>
            {slide.bottomThirdText !== undefined && !readOnly && (
              <button
                type="button"
                className="small ghost"
                onClick={() => {
                  setEditingStrapFor(null);
                  set((s) => ({ ...s, bottomThirdText: undefined }));
                }}
                title="Use slide text automatically"
              >
                Auto
              </button>
            )}
          </div>
          {strapShown ? (
            <TextField
              label="Bottom-third text (1–2 lines on livestream/lobby)"
              multiline
              rows={2}
              value={slide.bottomThirdText ?? defaultStrap}
              disabled={readOnly}
              onChange={(val) => {
                setEditingStrapFor(slide.id);
                set((s) => ({ ...s, bottomThirdText: val }), `strap:${slide.id}`);
              }}
            />
          ) : (
            <span className="muted">Suppressed on livestream &amp; lobby lower-third screens.</span>
          )}
        </div>
      )}
      <SlideBackgroundSection slide={slide} p={p} readOnly={readOnly} />
      <SlideSoundPanel slide={slide} media={(id) => media.find((m) => m.id === id)} readOnly={readOnly} />
      <SlideMidiCues
        cues={slide.midiCues}
        onChange={(midiCues) => set((s) => ({ ...s, midiCues }))}
        readOnly={readOnly}
      />
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
      {p.kind === 'song' && slide.overrides && slide.overrides.length > 0 && (
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
