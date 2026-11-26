import { type ActionId, newId, type PlaylistItem, type Presentation } from '@ordo/domain';
import { useMemo, useState } from 'react';
import { openContextMenu } from '../../components/ContextMenu.tsx';
import { Dialog } from '../../components/Dialog.tsx';
import { PropertyRow, SegmentedControl, Select } from '../../components/fields.tsx';
import { Icon, playlistItemIconName } from '../../components/Icons.tsx';
import { SlidePreviewRoll, slidePreviewRollHeight } from '../../components/SlidePreviewRoll.tsx';
import { VirtualList } from '../../components/VirtualList.tsx';
import { navigate } from '../../useRoute.ts';
import { useLibrary } from '../../state/library.ts';
import { useSearch } from '../../services/search.ts';
import { stateTag } from '../library/MediaTab.tsx';

export const ACTIONS: { value: ActionId; label: string }[] = [
  { value: 'clearAll', label: 'Clear all to black' },
  { value: 'clearSlide', label: 'Blank slide (keep background)' },
  { value: 'toggleBlankText', label: 'Toggle hold blank text' },
  { value: 'clearLowerThird', label: 'Clear lower third' },
  { value: 'clearProps', label: 'Clear props' },
  { value: 'clearMedia', label: 'Clear media' },
  { value: 'clearBackground', label: 'Clear background' },
  { value: 'logo', label: 'Show logo' },
];

type BrowserTab = 'presentation' | 'media' | 'cues';

/**
 * Insert presentations (with arrangement), media, timers and actions into a playlist
 * (design/30 §5.2): 3 segmented tabs (`Songs` | `Media` | `Cues`), double-click to add,
 * and hover-revealed icon-only `+` button (accessible name `Add`).
 */
export function AddItemsPanel({ onAdd }: { onAdd: (items: PlaylistItem[]) => void }) {
  const lib = useLibrary((s) => s.data);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<BrowserTab>('presentation');
  const [time, setTime] = useState('10:00');
  const [label, setLabel] = useState('');
  const [action, setAction] = useState<ActionId>('clearAll');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pickerPresId, setPickerPresId] = useState<string | null>(null);
  const pres = useMemo(() => new Map(lib.presentations.map((p) => [p.id, p])), [lib.presentations]);
  const media = useMemo(() => new Map(lib.media.map((m) => [m.id, m])), [lib.media]);
  const searchKind = tab === 'media' ? 'media' : 'presentation';
  const results = useSearch(q, { kind: searchKind, limit: 500 });
  const pickerPres = pickerPresId ? (pres.get(pickerPresId) ?? null) : null;

  const addPresentation = (p: Presentation, arrangementId?: string) => {
    onAdd([
      {
        id: newId(),
        kind: 'presentation',
        presentationId: p.id,
        arrangementId: arrangementId ?? p.arrangements[0]?.id,
      },
    ]);
  };

  const handleAddPresentation = (p: Presentation) => {
    if (p.arrangements.length > 1) {
      setPickerPresId(p.id);
    } else {
      addPresentation(p, p.arrangements[0]?.id);
    }
  };

  return (
    <div className="add-items pl-pane pl-pane-alt">
      <div className="col" style={{ padding: '6px 8px', gap: 6, borderBottom: '1px solid var(--line)' }}>
        <div className="prop-section-title" style={{ margin: 0 }}>
          <span>Library Browser</span>
        </div>
        <SegmentedControl<BrowserTab>
          size="xs"
          ariaLabel="Insert item type"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'presentation', label: 'Songs' },
            { value: 'media', label: 'Media' },
            { value: 'cues', label: 'Cues' },
          ]}
        />
        {tab !== 'cues' && (
          <div className="row" style={{ position: 'relative' }}>
            <input
              className="grow"
              placeholder={tab === 'media' ? 'Search media…' : 'Search title, lyrics, CCLI, tag…'}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              style={{ paddingRight: q ? 24 : undefined }}
            />
            {q && (
              <button
                type="button"
                className="ghost icon-btn"
                style={{ position: 'absolute', right: 2 }}
                onClick={() => setQ('')}
                aria-label="Clear search"
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
        )}
      </div>

      {tab === 'cues' ? (
        <div className="pl-pane-scroll">
          <div className="prop-section">
            <div className="prop-section-title">Timer Cue</div>
            <PropertyRow label="Label">
              <input
                placeholder="Optional label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                style={{ width: '100%' }}
              />
            </PropertyRow>
            <PropertyRow label="Target time">
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                style={{ width: 96 }}
              />
            </PropertyRow>
            <div className="row wrap" style={{ gap: 6, marginTop: 2 }}>
              <button
                type="button"
                className="small"
                onClick={() =>
                  onAdd([
                    {
                      id: newId(),
                      kind: 'timer',
                      timer: { kind: 'countdownTo', timeOfDay: time, label: label.trim() || undefined },
                    },
                  ])
                }
              >
                <Icon name="timer" size={12} />
                Add countdown
              </button>
              <button
                type="button"
                className="small"
                onClick={() =>
                  onAdd([
                    {
                      id: newId(),
                      kind: 'timer',
                      timer: { kind: 'elapsed', label: label.trim() || undefined },
                    },
                  ])
                }
              >
                <Icon name="clock" size={12} />
                Add elapsed timer
              </button>
            </div>
          </div>

          <div className="prop-section">
            <div className="prop-section-title">Action Cue</div>
            <PropertyRow label="Action">
              <Select value={action} options={ACTIONS} onChange={setAction} style={{ flex: 1 }} />
            </PropertyRow>
            <div>
              <button
                type="button"
                className="small"
                onClick={() => onAdd([{ id: newId(), kind: 'action', action }])}
              >
                <Icon name="action" size={12} />
                Add action
              </button>
            </div>
          </div>
        </div>
      ) : (
        <VirtualList
          items={results}
          style={{ flex: 1 }}
          rowHeight={(d) =>
            d.kind === 'presentation' && expandedId === d.id
              ? slidePreviewRollHeight(pres.get(d.id), true)
              : 32
          }
          rowClass={(d) => (d.kind === 'presentation' && expandedId === d.id ? 'expanded' : '')}
          keyOf={(d) => d.id}
          onRowDoubleClick={(d) => {
            if (d.kind === 'presentation') {
              const p = pres.get(d.id);
              if (p) handleAddPresentation(p);
            } else {
              const m = media.get(d.id);
              if (m && m.state === 'ready') {
                onAdd([{ id: newId(), kind: 'media', mediaId: m.id, loop: m.loop, onEnd: 'hold' }]);
              }
            }
          }}
          onRowContextMenu={(e, d) => {
            if (d.kind === 'presentation') {
              const p = pres.get(d.id);
              if (!p) return;
              const isExpanded = expandedId === p.id;
              openContextMenu(
                e,
                [
                  {
                    label: 'Add to playlist',
                    onSelect: () => handleAddPresentation(p),
                  },
                  ...(p.arrangements.length > 1
                    ? [
                        {
                          kind: 'submenu' as const,
                          label: 'Add with arrangement',
                          items: p.arrangements.map((a) => ({
                            label: a.name,
                            onSelect: () => addPresentation(p, a.id),
                          })),
                        },
                      ]
                    : []),
                  { kind: 'separator' },
                  {
                    label: isExpanded ? 'Collapse slide preview' : 'Preview slides',
                    onSelect: () => setExpandedId(isExpanded ? null : p.id),
                  },
                  {
                    label: 'Edit presentation…',
                    onSelect: () => navigate(`#/edit/${p.id}`),
                  },
                ],
                { ariaLabel: `${p.title} actions` },
              );
              return;
            }
            const m = media.get(d.id);
            if (!m) return;
            openContextMenu(
              e,
              [
                {
                  label: 'Add to playlist',
                  onSelect: () => onAdd([{ id: newId(), kind: 'media', mediaId: m.id }]),
                },
              ],
              { ariaLabel: `${m.name} actions` },
            );
          }}
          render={(d) => {
            if (d.kind === 'presentation') {
              const p = pres.get(d.id);
              if (!p) return null;
              const isExpanded = expandedId === p.id;
              return (
                <>
                  <div className="row" style={{ alignItems: 'center', gap: 5, width: '100%', minHeight: 28 }}>
                    <button
                      type="button"
                      className="ghost icon-btn"
                      style={{ width: 18, height: 18, minHeight: 18 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedId(isExpanded ? null : p.id);
                      }}
                      title={isExpanded ? 'Collapse preview' : 'Preview slides'}
                      aria-label={isExpanded ? 'Collapse preview' : 'Preview slides'}
                    >
                      <Icon name={isExpanded ? 'chevronDown' : 'chevronRight'} size={11} />
                    </button>
                    <Icon name={playlistItemIconName('presentation', p.kind)} size={12} className="muted" />
                    <span
                      className="ellipsis grow"
                      style={{ cursor: 'pointer' }}
                      onClick={() => setExpandedId(isExpanded ? null : p.id)}
                      title={`${p.title} (${p.kind}) — Double-click to add`}
                    >
                      {p.title}
                    </span>
                    <button
                      type="button"
                      className="ghost icon-btn row-hover-actions"
                      aria-label="Add"
                      title="Add to playlist"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleAddPresentation(p);
                      }}
                    >
                      <Icon name="plus" size={13} />
                    </button>
                  </div>
                  {isExpanded && (
                    <div
                      className="col"
                      style={{
                        width: '100%',
                        marginTop: 4,
                        padding: '8px 10px',
                        background: 'var(--bg)',
                        borderRadius: 3,
                        border: '1px solid var(--line)',
                        gap: 8,
                        boxSizing: 'border-box',
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SlidePreviewRoll
                        p={p}
                        compact={true}
                        onAddArrangement={(arrId) => addPresentation(p, arrId)}
                      />
                      <div
                        className="row"
                        style={{
                          justifyContent: 'flex-start',
                          alignItems: 'center',
                          paddingTop: 4,
                          borderTop: '1px solid var(--line)',
                          flexShrink: 0,
                        }}
                      >
                        <button type="button" className="small" onClick={() => setExpandedId(null)}>
                          Close
                        </button>
                      </div>
                    </div>
                  )}
                </>
              );
            }
            const m = media.get(d.id);
            if (!m) return null;
            const ready = m.state === 'ready';
            return (
              <>
                <Icon
                  name={m.kind === 'audio' ? 'audio' : m.kind === 'image' ? 'image' : 'video'}
                  size={12}
                  className="muted"
                />
                <span className="ellipsis grow" title={`${m.name} (${m.kind}) — Double-click to add`}>
                  {m.name}
                </span>
                {!ready && stateTag(m)}
                <button
                  type="button"
                  className="ghost icon-btn row-hover-actions"
                  aria-label="Add"
                  disabled={!ready}
                  title={ready ? 'Add to playlist' : 'Available when processing has finished'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAdd([{ id: newId(), kind: 'media', mediaId: m.id, loop: m.loop, onEnd: 'hold' }]);
                  }}
                >
                  <Icon name="plus" size={13} />
                </button>
              </>
            );
          }}
        />
      )}

      {pickerPres && (
        <Dialog
          title={`Choose arrangement — ${pickerPres.title}`}
          width={860}
          onClose={() => setPickerPresId(null)}
          footer={
            <button type="button" className="small" onClick={() => setPickerPresId(null)}>
              Close
            </button>
          }
        >
          <SlidePreviewRoll
            p={pickerPres}
            onAddArrangement={(arrId) => {
              addPresentation(pickerPres, arrId);
              setPickerPresId(null);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}
