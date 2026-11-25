import type { Media, MidiPreset, PlaylistItem, Presentation } from '@ordo/domain';
import type { ReactNode } from 'react';
import { Icon, playlistItemIconName } from './Icons.tsx';
import { midiTriggerBadge } from './MidiTriggerPicker.tsx';
import { itemSubtitle, itemTitle } from '../lib/playlistItems.ts';

export type ItemLookup = {
  presentation: (id: string) => Presentation | undefined;
  media: (id: string) => Media | undefined;
};

/**
 * Shared playlist item row content used by both Playlists (`PlaylistEditor`) and Live (`PlaylistPane`).
 * Compact-safe: imports no live controller or `startService`.
 */
export function PlaylistItemRowContent({
  item,
  index,
  lookup,
  presets,
  isLive,
  unsaved,
  leading,
  trailing,
}: {
  item: PlaylistItem;
  index: number;
  lookup: ItemLookup;
  presets?: readonly MidiPreset[];
  isLive?: boolean;
  unsaved?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const skipped = item.skipped === true;
  const pres = item.kind === 'presentation' ? lookup.presentation(item.presentationId) : undefined;
  const iconName = playlistItemIconName(item.kind, pres?.kind);
  const midiBadge = item.kind !== 'action' && item.midi ? midiTriggerBadge(item.midi, presets) : null;
  const bgBadge =
    item.kind === 'presentation'
      ? (() => {
          const effBgId = item.backgroundMediaId ?? pres?.backgroundMediaId;
          const effBg = effBgId ? lookup.media(effBgId) : undefined;
          return effBg?.midi ? midiTriggerBadge(effBg.midi, presets) : null;
        })()
      : null;

  const sub = itemSubtitle(item, lookup);

  return (
    <>
      {leading}
      <span
        className="muted small"
        style={{ width: 18, textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}
      >
        {index + 1}
      </span>
      <span className={`kind ${isLive ? 'live' : ''}`} style={{ opacity: skipped ? 0.45 : undefined }}>
        {isLive ? (
          <span className="dot sm" style={{ background: '#fff' }} />
        ) : (
          <Icon name={iconName} size={12} />
        )}
      </span>
      <span className="col grow" style={{ gap: 0, minWidth: 0, opacity: skipped ? 0.55 : undefined }}>
        <span className="ellipsis row" style={{ gap: 5, alignItems: 'center' }}>
          <span className="ellipsis" style={skipped ? { textDecoration: 'line-through' } : undefined}>
            {itemTitle(item, lookup)}
          </span>
          {isLive && <span className="live-pill-mini">ON AIR</span>}
          {skipped && (
            <span
              className="tag"
              style={{ fontSize: 9.5, padding: '1px 4px' }}
              title="Skipped in sequential play"
            >
              skipped
            </span>
          )}
          {unsaved && (
            <span
              className="tag amber"
              style={{ fontSize: 9.5, padding: '1px 4px' }}
              title="Unsaved edits in editor"
            >
              unsaved
            </span>
          )}
          {bgBadge && (
            <span
              className="tag"
              title={`From background: ${bgBadge.title}`}
              style={{
                fontSize: 9.5,
                padding: '1px 4px',
                borderLeft: bgBadge.color ? `3px solid ${bgBadge.color}` : undefined,
                opacity: 0.85,
              }}
            >
              <Icon name="lights" size={9} /> {bgBadge.label}
            </span>
          )}
          {midiBadge && (
            <span
              className="tag"
              title={midiBadge.title}
              style={{
                fontSize: 9.5,
                padding: '1px 4px',
                borderLeft: midiBadge.color ? `3px solid ${midiBadge.color}` : undefined,
                color: midiBadge.missing ? 'var(--warn, #d97706)' : undefined,
              }}
            >
              <Icon name="lights" size={9} /> {midiBadge.label}
            </span>
          )}
        </span>
        {sub && (
          <span className="muted ellipsis" style={{ fontSize: 10.5, lineHeight: 1.15 }}>
            {sub}
          </span>
        )}
      </span>
      {trailing}
    </>
  );
}
