import { useEffect, useState } from 'react';
import { Dialog } from '../../components/Dialog.tsx';
import { reloadLatest, save, useEditor } from './editorStore.ts';
import type { MergeConflict } from './merge.ts';

/** The conflicts listed by name; past these, "and N more". */
const SHOWN = 8;

/**
 * The editor's save conflict (design/27 §11 item 17; M4 item H): someone else saved since the editor's base
 * and the three-way merge (`merge.ts`) could not combine every change, so the dialog says what overlaps
 * (`MergeConflict.what`, by slide number) and keeps the two ways out. Focus starts on Cancel (nothing is
 * lost) and goes back where it was when the dialog closes.
 */
export function ConflictDialog() {
  const conflicts = useEditor((s) => s.mergeConflicts);
  // Read while rendering, before Cancel takes the focus.
  const [back] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  useEffect(
    () => () => {
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    },
    [back],
  );
  return (
    <ConflictDialogView
      conflicts={conflicts}
      onCancel={() => useEditor.setState({ conflict: false })}
      onReload={() => void reloadLatest()}
      onSaveMine={() => void save(true)}
    />
  );
}

export function ConflictDialogView(props: {
  /** What the merge could not combine; empty when there was nothing to merge with. */
  conflicts: readonly MergeConflict[];
  /** Keep editing (the draft stays unsaved). */
  onCancel: () => void;
  /** Discard the draft and load the version that won. */
  onReload: () => void;
  /** Save the draft over theirs (theirs stays in the history). */
  onSaveMine: () => void;
}) {
  const { conflicts } = props;
  const shown = conflicts.slice(0, SHOWN);
  const more = conflicts.length - shown.length;
  return (
    <Dialog
      title="Changed by someone else"
      onClose={props.onCancel}
      footer={
        <>
          <button type="button" onClick={props.onCancel} autoFocus>
            Cancel
          </button>
          <button type="button" onClick={props.onReload}>
            Reload theirs (discard mine)
          </button>
          <button type="button" className="primary" onClick={props.onSaveMine}>
            Save mine anyway
          </button>
        </>
      }
    >
      {conflicts.length ? (
        <>
          <p style={{ marginTop: 0 }} id="ordo-merge-conflicts">
            Someone else saved this presentation after you opened it. Changes to different slides and boxes
            are combined when you save, but these changes overlap:
          </p>
          <ul style={{ margin: '0 0 12px', paddingLeft: 18 }} aria-labelledby="ordo-merge-conflicts">
            {shown.map((c) => (
              <li key={`${c.level}:${c.slideId ?? ''}:${c.key}:${c.what}`}>{c.what}</li>
            ))}
            {more > 0 && <li>and {more === 1 ? 'one more' : `${more} more`}</li>}
          </ul>
          <p style={{ marginBottom: 0 }}>
            Saving yours replaces their whole version (it stays in the history), or reload to see their
            changes.
          </p>
        </>
      ) : (
        <p style={{ marginTop: 0 }}>
          This presentation was saved by someone else after you opened it. Saving yours replaces theirs (their
          version stays in the history), or reload to see their changes.
        </p>
      )}
    </Dialog>
  );
}
