import { fileUrl } from '@ordo/client';
import type { Media } from '@ordo/domain';
import { useMemo, useState } from 'react';
import { type MessageKey, t } from '../../i18n/index.ts';
import { isPresentationPicture } from '../../lib/mediaUse.ts';
import { tileHash } from '../../services/thumbs.ts';
import { useLibrary } from '../../state/library.ts';
import { MediaPreview } from '../library/MediaTab.tsx';

const STATE_TAG: Record<Media['state'], string> = {
  uploaded: 'amber',
  processing: 'amber',
  ready: 'green',
  failed: 'red',
};

/**
 * The Media tab in P0 (design/28 §2.2; P1's Media grid with search and filters replaces it): the library's
 * media by name (the pictures imports made for presentations left out, as the venue PC's Media tab does by
 * default), each row its still, its name, its state in words and its kind; a tap opens the preview as a sheet.
 * Read-only: no upload, rename, delete, background or playback fields.
 */
export function MediaP0() {
  const media = useLibrary((s) => s.data.media);
  const [previewing, setPreviewing] = useState<Media>();
  const list = useMemo(
    () => media.filter((m) => !isPresentationPicture(m)).sort((a, b) => a.name.localeCompare(b.name)),
    [media],
  );
  return (
    <div className="compact-body" data-compact-media>
      {!list.length ? (
        <p className="compact-empty">{t('media.empty')}</p>
      ) : (
        <ul className="compact-list">
          {list.map((m) => {
            const still = tileHash(m);
            return (
              <li key={m.id}>
                <button
                  type="button"
                  className="compact-row compact-media-row"
                  data-media-row
                  onClick={() => setPreviewing(m)}
                >
                  <span
                    className="compact-tile"
                    aria-hidden="true"
                    style={still ? { backgroundImage: `url(${fileUrl(still)})` } : undefined}
                  >
                    {!still && (m.kind === 'audio' ? '♫' : '▶')}
                  </span>
                  <span className="compact-row-text">
                    <span className="compact-row-title" dir="auto">
                      {m.name}
                    </span>
                    <span className="compact-row-meta">
                      <span className={`tag ${STATE_TAG[m.state] ?? 'amber'}`}>
                        {t(`media.state.${m.state}` as MessageKey)}
                      </span>{' '}
                      {t(`media.kind.${m.kind}` as MessageKey)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {previewing && <MediaPreview m={previewing} onClose={() => setPreviewing(undefined)} />}
    </div>
  );
}
