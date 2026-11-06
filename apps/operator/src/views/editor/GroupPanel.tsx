import type { Box, SlideObject } from '@ordo/domain';
import { useRef, useState } from 'react';
import { BoxEditor, NumberField, Select } from '../../components/fields.tsx';
import { setSelectionBox, ungroupSelection } from './actions.ts';
import { selectObject, selectObjects, useEditor } from './editorStore.ts';
import { getSlide } from './ops.ts';
import { groupBox, groupMembers, hasGroup, isLocked, keepsAspect } from './ops/group.ts';

/*
 * The Object panel's parts for the selection (M4 item B; design/27 §11 item 5 and "Locked objects"): the
 * locked note, the group note, and the box editor, which edits the group box when several objects are
 * selected. Each store-bound part has a props-only `…View` rendered by the tests.
 */

/** A fieldset that only groups (no border), so `disabled` reaches every control inside it. */
const BARE = { border: 0, margin: 0, padding: 0, minWidth: 0 } as const;

/** A short name for an object in the panel's lists: its kind, and the start of its text. */
export function objectLabel(o: SlideObject, opts: { inSentence?: boolean } = {}): string {
  // In a sentence the kind word is lowercased ('the text “…”'); the volunteer's own text and the name
  // PowerPoint keep their letters.
  const kind = (w: string) => (opts.inSentence ? w.toLowerCase() : w);
  if (o.type === 'text') {
    const t = o.text.replace(/\s+/g, ' ').trim();
    return t ? `${kind('Text')} “${t.length > 28 ? `${t.slice(0, 28)}…` : t}”` : kind('Text (empty)');
  }
  if (o.type === 'image') return o.play ? kind('Video') : isLocked(o) ? 'PowerPoint art' : kind('Picture');
  return o.shape === 'line'
    ? kind('Line')
    : `${kind('Shape')} (${o.shape === 'rect' ? 'rectangle' : 'ellipse'})`;
}

/**
 * 'From PowerPoint (not editable)': a locked object (PowerPoint art for a chart, SmartArt or WordArt, table
 * grids) can be moved, resized, deleted and put in front or behind; its text, style and geometry fields are
 * read-only.
 */
export function LockedNote({ o }: { o: SlideObject }) {
  if (!isLocked(o)) return null;
  return (
    <div className="col" style={{ gap: 4 }} data-locked-note>
      <span>
        <span className="tag amber">From PowerPoint (not editable)</span>
      </span>
      <span className="muted small">
        PowerPoint drew this{keepsAspect(o) ? ' picture' : ''}: move it, resize it
        {keepsAspect(o) ? ' (it keeps its shape)' : ''}, delete it or put it in front or behind. To change
        what it shows, edit it in PowerPoint and re-import.
      </span>
    </div>
  );
}

/** The group note for the open slide's selection (store-bound). */
export function GroupNote({ o, readOnly }: { o: SlideObject; readOnly: boolean }) {
  const slide = useEditor((s) => (s.draft ? getSlide(s.draft, s.slideId) : undefined));
  const ids = useEditor((s) => s.objectIds);
  if (!slide) return null;
  const selected = slide.objects.filter((x) => ids.includes(x.id));
  const groupIds = groupMembers(slide, o.id);
  const group = slide.objects.filter((x) => groupIds.includes(x.id));
  return (
    <GroupNoteView
      primary={o}
      selected={selected}
      group={group}
      readOnly={readOnly}
      onSelectOne={(id) => selectObject(id)}
      onSelectGroup={() => selectObjects(groupIds, o.id)}
      onUngroup={ungroupSelection}
    />
  );
}

/**
 * What the selection is and what the fields below edit: several objects selected together (a PowerPoint
 * group, a shape with its text, or gathered with Shift-click) move, resize and delete as one, and the fields
 * edit the primary one; a member selected alone (Alt-click, a long press on touch) can take its group back.
 * Every canvas gesture has its control here: 'Select one' for Alt-click, 'Select the group', 'Ungroup'.
 */
export function GroupNoteView(props: {
  primary: SlideObject;
  selected: readonly SlideObject[];
  /** The primary's group (itself alone when it has none). */
  group: readonly SlideObject[];
  readOnly: boolean;
  onSelectOne: (id: string) => void;
  onSelectGroup: () => void;
  onUngroup: () => void;
}) {
  const { primary, selected, group } = props;
  const grouped = hasGroup(selected);
  // Both states draw the same container, so focus can stay on it when a button here changes the selection.
  const note = useRef<HTMLDivElement>(null);
  const then = (fn: () => void) => () => {
    fn();
    setTimeout(() => note.current?.focus(), 0);
  };
  const box = { ref: note, tabIndex: -1, role: 'group', 'aria-label': 'Selection', 'data-group-note': '' };
  if (selected.length > 1)
    return (
      <div className="banner blue small col" style={{ gap: 6 }} {...box}>
        <span>
          {selected.length} objects selected{grouped ? ', a group from PowerPoint' : ''}: they move, resize,
          delete and duplicate together. The fields below edit the{' '}
          {objectLabel(primary, { inSentence: true })} only; Alt-click an object (a long press on touch) to
          select it alone.
        </span>
        <div className="row wrap">
          <Select
            label="Select one"
            value={primary.id}
            options={selected.map((o) => ({ value: o.id, label: objectLabel(o) }))}
            onChange={props.onSelectOne}
          />
          {grouped && (
            <button type="button" className="small" disabled={props.readOnly} onClick={then(props.onUngroup)}>
              Ungroup
            </button>
          )}
        </div>
      </div>
    );
  if (group.length > 1)
    return (
      <div className="banner blue small col" style={{ gap: 6 }} {...box}>
        <span>
          Selected alone: one of a group of {group.length} objects. Moving or resizing it now leaves the
          others where they are.
        </span>
        <div className="row wrap">
          <button type="button" className="small" onClick={then(props.onSelectGroup)}>
            Select the group
          </button>
          <button type="button" className="small" disabled={props.readOnly} onClick={props.onUngroup}>
            Take out of the group
          </button>
        </div>
      </div>
    );
  return null;
}

/**
 * The Object panel's box editor (store-bound): the primary object's box, or the group box when several
 * objects are selected (`setSelectionBox`: every member scaled and moved with it).
 */
export function SelectionBox(props: { o: SlideObject; readOnly: boolean; onChange: (box: Box) => void }) {
  const slide = useEditor((s) => (s.draft ? getSlide(s.draft, s.slideId) : undefined));
  const ids = useEditor((s) => s.objectIds);
  const selected = slide?.objects.filter((x) => ids.includes(x.id)) ?? [];
  const box = selected.length > 1 ? groupBox(selected) : undefined;
  if (box)
    return (
      <GroupBoxView
        box={box}
        canTurn={!selected.some(isLocked)}
        readOnly={props.readOnly}
        onChange={setSelectionBox}
      />
    );
  return <ObjectBoxView o={props.o} readOnly={props.readOnly} onChange={props.onChange} />;
}

/**
 * One object's box: X, Y, W, H and Rotation. A locked object does not turn (no Rotation), and a locked art
 * picture keeps its aspect: changing W sets H to match, and the other way round.
 */
export function ObjectBoxView(props: { o: SlideObject; readOnly: boolean; onChange: (box: Box) => void }) {
  const { o } = props;
  return (
    <fieldset disabled={props.readOnly} style={BARE}>
      <BoxEditor
        value={o.box}
        rotation={!isLocked(o)}
        onChange={(b) => props.onChange(keepsAspect(o) ? withAspect(o.box, b) : b)}
      />
    </fieldset>
  );
}

/** `next` with the aspect of `prev` kept: the side that changed leads. */
export function withAspect(prev: Box, next: Box): Box {
  if (!(prev.w > 0 && prev.h > 0)) return next;
  if (next.w !== prev.w) return { ...next, h: Math.max(1, Math.round((next.w * prev.h) / prev.w)) };
  if (next.h !== prev.h) return { ...next, w: Math.max(1, Math.round((next.h * prev.w) / prev.h)) };
  return next;
}

/**
 * The group box of a multi-object selection: X, Y, W and H of the members' bounding box (setting them scales
 * and moves every member; font sizes do not scale), and 'Turn by', which turns the members about the group
 * centre (the canvas's rotate handle), left out when a locked object is selected.
 */
export function GroupBoxView(props: {
  box: Box;
  canTurn: boolean;
  readOnly: boolean;
  onChange: (to: Box) => void;
}) {
  const { box } = props;
  // 'Turn by' is an action, not a value: it shows 0 again after each turn.
  const [turns, setTurns] = useState(0);
  return (
    <fieldset disabled={props.readOnly} className="col" style={{ ...BARE, gap: 8 }} data-group-box>
      <BoxEditor value={box} rotation={false} onChange={props.onChange} />
      {props.canTurn && (
        <NumberField
          key={turns}
          label="Turn by"
          value={0}
          min={-360}
          max={360}
          suffix="°"
          width={70}
          onChange={(deg) => {
            setTurns((n) => n + 1);
            if (deg) props.onChange({ ...box, rotation: deg });
          }}
        />
      )}
    </fieldset>
  );
}
