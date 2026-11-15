import type { SlideObject } from '@ordo/domain';
import { useState } from 'react';
import { ColorPill, PaintPill, type PaintValue } from '../../components/ColorPicker.tsx';
import { Menu } from '../../components/Menu.tsx';
import {
  alignSelection,
  deleteSelection,
  duplicateSelection,
  pictureToBackground,
  reorderSelection,
  replacePictureWith,
  ungroupSelection,
} from './actions.ts';
import { MediaPickerDialog } from './BackgroundPicker.tsx';
import { endCrop, startCrop, useCropMode } from './CropControl.tsx';
import { change, useEditor } from './editorStore.ts';
import { geomInfo, shapeName, withDash, withFill, withGradient } from './ObjectShapeFields.tsx';
import { getSlide, markOverride, updateObject, updateSlide } from './ops.ts';
import { hasGroup, isLocked } from './ops/group.ts';
import { type ObjectBar, type ObjectBarContext, OBJECT_BAR_ORDER, objectBarFor } from './objectBars.ts';
import { coversSlide } from './ops/slides.ts';
import type { AlignTo } from './placement.ts';
import { TextFloatingControls, textObjectStyle } from './TextControls.tsx';

export { type ContrastMode, contrastChoice } from './TextControls.tsx';

/** The multi-selection bar's Align menu: where, what it says, its accessible name. */
const ALIGN_ITEMS: readonly [AlignTo, string, string][] = [
  ['left', '⇤ Align left', 'Align left'],
  ['cx', '⇹ Center horizontally', 'Center horizontally'],
  ['right', '⇥ Align right', 'Align right'],
  ['top', '⤒ Align top', 'Align top'],
  ['cy', '⇳ Center vertically', 'Center vertically'],
  ['bottom', '⤓ Align bottom', 'Align bottom'],
];

export interface FloatingContextBarProps {
  readOnly: boolean;
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}

/**
 * Proposal B ("Canvas-First") Floating Contextual Formatting & Action Bar:
 * Floats cleanly above the selected object on the stage so 90% of formatting happens in-context
 * without a permanent right sidebar, while `More…` opens the focused Slide-Over Tune Drawer.
 *
 * Which bar shows is the bar registry's choice (objectBars.ts, design/15 "Object bars"): the built-in bars
 * below (`BUILTIN_BARS`), the M9 tracks' (`OBJECT_BARS`) and any registered one, first by order among those
 * that apply to the primary object; every bar ends with the same tail actions.
 */
export function FloatingContextBar({ readOnly, drawerOpen, onToggleDrawer }: FloatingContextBarProps) {
  const draft = useEditor((s) => s.draft);
  const slideId = useEditor((s) => s.slideId);
  const objectId = useEditor((s) => s.objectId);
  const objectIds = useEditor((s) => s.objectIds);
  const range = useEditor((s) => s.textRange);

  if (!draft || !slideId || !objectId) return null;
  const slide = getSlide(draft, slideId);
  const o = slide?.objects.find((x) => x.id === objectId);
  if (!o) return null;

  const locked = isLocked(o);
  const off = readOnly || locked;
  const selectedObjs = slide?.objects.filter((x) => objectIds.includes(x.id)) ?? [];
  const grouped = hasGroup(selectedObjs);
  const multi = objectIds.length > 1;

  const isSong = draft.kind === 'song';
  // A table, a chart or a picture is never the lyric box, whatever `lyricObjectId` names.
  const isLyric =
    isSong &&
    o.type === 'text' &&
    (slide?.lyricObjectId === o.id ||
      (!slide?.lyricObjectId && slide?.objects.find((x) => x.type === 'text')?.id === o.id));
  const themed = isLyric && !!draft.themeId;

  const setObj = (fn: (x: SlideObject) => SlideObject, key?: string, overridePath?: string | string[]) => {
    const paths =
      overridePath === undefined ? [] : typeof overridePath === 'string' ? [overridePath] : overridePath;
    if (readOnly || (locked && !(paths.length === 1 && paths[0] === 'box'))) return;
    change((p) => {
      let q = updateObject(p, slideId, o.id, fn);
      if (themed && paths.length) q = updateSlide(q, slideId, (s) => paths.reduce(markOverride, s));
      return q;
    }, key);
  };

  const layerMenu = (
    <Menu
      label="Layer"
      disabled={readOnly}
      items={[
        { label: '⤒ Bring to front', name: 'Front', onSelect: () => reorderSelection('front') },
        { label: '↑ Bring forward', name: 'Forward', onSelect: () => reorderSelection('forward') },
        { label: '↓ Send backward', name: 'Backward', onSelect: () => reorderSelection('backward') },
        { label: '⤓ Send to back', name: 'Back', onSelect: () => reorderSelection('back') },
      ]}
    />
  );

  const tailActions = (
    <>
      <span className="ed-fbar-sep" />
      {grouped && !readOnly && (
        <button
          type="button"
          className="small ghost"
          onClick={() => ungroupSelection()}
          title="Ungroup selection"
        >
          Ungroup
        </button>
      )}
      {layerMenu}
      <button
        type="button"
        className="small ghost ed-fbar-icon"
        disabled={readOnly}
        aria-label="Duplicate object"
        title="Duplicate (Ctrl+D)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => duplicateSelection()}
      >
        ⧉
      </button>
      <button
        type="button"
        className="small ghost danger ed-fbar-icon"
        disabled={readOnly}
        aria-label="Delete object"
        title="Delete (Del)"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => deleteSelection()}
      >
        🗑
      </button>
      <span className="ed-fbar-sep" />
      <button
        type="button"
        className={`small ed-fbar-more${drawerOpen ? ' on' : ''}`}
        aria-label="More object options"
        aria-expanded={drawerOpen}
        title="Open fine-tune inspector drawer"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleDrawer}
      >
        More…
      </button>
    </>
  );

  const ctx: ObjectBarContext = {
    o,
    off,
    readOnly,
    setObj,
    tailActions,
    range,
    slideId,
    draft,
    count: objectIds.length,
  };
  const Bar = objectBarFor(o, multi, BUILTIN_BARS)?.Component ?? NeutralBar;
  return <Bar {...ctx} />;
}

/** A selection of several objects: aligned to the slide as one block (placement.ts), as the drawer's align bar does. */
function MultiBar({ readOnly, count, tailActions }: ObjectBarContext) {
  return (
    <div className="ed-floating-inner">
      <span className="ed-scope-pill">{count} selected</span>
      <Menu
        label="Align"
        disabled={readOnly}
        items={ALIGN_ITEMS.map(([to, label, name]) => ({
          label,
          name,
          onSelect: () => alignSelection(to),
        }))}
      />
      {tailActions}
    </div>
  );
}

function TextBar({ o, range, off, setObj, tailActions }: ObjectBarContext) {
  if (o.type !== 'text') return null;
  return (
    <TextFloatingControls
      o={o}
      range={range}
      off={off}
      setStyle={textObjectStyle(o.id, setObj)}
      tailActions={tailActions}
    />
  );
}

/** A plain shape (no table, chart or decoration, unlocked): its geometry, fill and stroke. */
function ShapeBar({ o, off, setObj, tailActions }: ObjectBarContext) {
  if (o.type !== 'shape') return null;
  const info = geomInfo(o);
  const paintVal: PaintValue = o.gradient
    ? { kind: 'gradient', gradient: o.gradient }
    : o.fill
      ? { kind: 'solid', color: o.fill }
      : { kind: 'none' };
  const curDash = o.dash ?? 'solid';
  const nextDash = curDash === 'solid' ? 'dash' : curDash === 'dash' ? 'sysDot' : 'solid';

  return (
    <div className="ed-floating-inner">
      {!info ? (
        <select
          aria-label="Shape geometry"
          value={o.shape}
          disabled={off}
          className="ed-fbar-select"
          onChange={(e) =>
            setObj((x) => (x.type === 'shape' ? { ...x, shape: e.target.value as typeof o.shape } : x))
          }
        >
          <option value="rect">Rect</option>
          <option value="ellipse">Ellipse</option>
          <option value="line">Line</option>
        </select>
      ) : (
        <span className="ed-scope-pill">{shapeName(o)}</span>
      )}

      {o.shape !== 'line' && (
        <PaintPill
          value={paintVal}
          modes={['none', 'solid', 'linear', 'radial']}
          disabled={off}
          compact
          ariaLabel="Shape fill"
          onChange={(next) => {
            if (next.kind === 'none') setObj((x) => (x.type === 'shape' ? withFill(x, false) : x));
            else if (next.kind === 'solid')
              setObj((x) => {
                if (x.type !== 'shape') return x;
                const { gradient: _g, ...rest } = x;
                return { ...rest, fill: next.color };
              }, `shape:${o.id}:fill`);
            else
              setObj((x) => (x.type === 'shape' ? withGradient(x, next.gradient) : x), `shape:${o.id}:grad`);
          }}
        />
      )}

      <span className="ed-fbar-sep" />
      {o.stroke ? (
        <>
          <ColorPill
            value={o.stroke.color}
            disabled={off}
            compact
            ariaLabel="Stroke color"
            onChange={(color) =>
              setObj((x) => (x.type === 'shape' && x.stroke ? { ...x, stroke: { ...x.stroke, color } } : x))
            }
          />
          <button
            type="button"
            className="small ghost"
            disabled={off}
            title={`Dash: ${curDash} (click to cycle)`}
            aria-label="Cycle stroke dash"
            onClick={() => setObj((x) => (x.type === 'shape' ? withDash(x, nextDash) : x))}
          >
            {curDash === 'solid' ? '───' : curDash === 'dash' ? '- -' : '•••'}
          </button>
        </>
      ) : (
        <button
          type="button"
          className="small ghost"
          disabled={off}
          onClick={() =>
            setObj((x) =>
              x.type === 'shape'
                ? { ...x, stroke: { width: 4, color: { r: 255, g: 255, b: 255, a: 1 } } }
                : x,
            )
          }
        >
          + Stroke
        </button>
      )}
      {tailActions}
    </div>
  );
}

/** A picture or a video: crop, replace, use as background, loop. */
function PictureBar({ o, off, setObj, tailActions, draft }: ObjectBarContext) {
  const croppingId = useCropMode((s) => s.objectId);
  const [replacingMedia, setReplacingMedia] = useState(false);
  if (o.type !== 'image') return null;
  const isCropping = croppingId === o.id;
  const canBg = coversSlide(draft, o);

  return (
    <div className="ed-floating-inner">
      <button
        type="button"
        className={`small${isCropping ? ' on' : ''}`}
        disabled={off}
        aria-pressed={isCropping}
        onClick={() => (isCropping ? endCrop() : startCrop(o.id))}
      >
        {isCropping ? 'Done crop' : 'Crop'}
      </button>
      <button type="button" className="small ghost" disabled={off} onClick={() => setReplacingMedia(true)}>
        Replace
      </button>
      {canBg && (
        <button
          type="button"
          className="small ghost"
          disabled={off}
          onClick={() => pictureToBackground(o.id)}
          title="Move image to slide background"
        >
          Use as BG
        </button>
      )}
      {o.play && (
        <button
          type="button"
          className={`small ghost${o.play.loop ? ' on' : ''}`}
          disabled={off}
          title="Toggle video loop"
          onClick={() =>
            setObj((x) =>
              x.type === 'image' && x.play ? { ...x, play: { ...x.play, loop: !x.play.loop } } : x,
            )
          }
        >
          {o.play.loop ? '↻ Loop' : '1× Play'}
        </button>
      )}
      {tailActions}
      {replacingMedia && !off && (
        <MediaPickerDialog
          title={o.play ? 'Choose a poster image' : 'Choose an image'}
          kinds={['image']}
          needsSize={o.fit !== 'contain' && o.fit !== 'cover'}
          onClose={() => setReplacingMedia(false)}
          onPick={(m) => {
            replacePictureWith(o.id, m);
            setReplacingMedia(false);
          }}
        />
      )}
    </div>
  );
}

/** What an object is, as the neutral bar's scope pill says it. */
export function objectLabel(o: SlideObject): string {
  const what =
    o.type === 'text'
      ? 'Text box'
      : o.type === 'image'
        ? o.play
          ? 'Video'
          : 'Image'
        : o.table
          ? 'Table'
          : o.chart
            ? 'Chart'
            : o.decor
              ? 'Decoration'
              : shapeName(o);
  return isLocked(o) ? `${what} (locked)` : what;
}

/**
 * Every object no other bar claims (a chart, a decoration, a locked shape): what it is, then the tail
 * actions (Layer, Duplicate, Delete, More…). Its fields are edited in the drawer, or not at all.
 */
function NeutralBar({ o, tailActions }: ObjectBarContext) {
  return (
    <div className="ed-floating-inner">
      <span className="ed-scope-pill">{objectLabel(o)}</span>
      {tailActions}
    </div>
  );
}

/** A plain shape: no table, chart or decoration (each draws instead of the shape's legacy fields), unlocked. */
const plainShape = (o: SlideObject) => o.type === 'shape' && !o.table && !o.chart && !o.decor && !isLocked(o);
const B = OBJECT_BAR_ORDER;

/** The floating bar's own bars; M9's are added by objectBars.ts. */
export const BUILTIN_BARS: readonly ObjectBar[] = [
  { id: 'multi', order: B.multi, selection: 'many', applies: () => true, Component: MultiBar },
  { id: 'text', order: B.text, applies: (o) => o.type === 'text', Component: TextBar },
  { id: 'shape', order: B.shape, applies: plainShape, Component: ShapeBar },
  { id: 'picture', order: B.picture, applies: (o) => o.type === 'image', Component: PictureBar },
  { id: 'neutral', order: B.neutral, applies: () => true, Component: NeutralBar },
];
