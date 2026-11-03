import { type Cue, expandCues, type Media, type Playlist, type Presentation } from '@ordo/domain';
import { useMemo } from 'react';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { useUi } from '../../state/ui.ts';

export type OperatorPlaylist = {
  playlist?: Playlist;
  live: boolean;
  cues: Cue[];
  presentation: (id: string) => Presentation | undefined;
  media: (id: string) => Media | undefined;
};

/**
 * The playlist the operator view shows: the live one (frozen, from live state) while a service is live,
 * otherwise the selected library playlist previewed with the same cue expansion.
 */
export function useOperatorPlaylist(): OperatorPlaylist {
  const state = useLive((s) => s.state);
  const lib = useLibrary((s) => s.data);
  const selectedId = useUi((s) => s.selectedPlaylistId);
  return useMemo(() => {
    if (state.mode === 'live' && state.resolved) {
      const r = state.resolved;
      const libMedia = new Map(lib.media.map((m) => [m.id, m]));
      return {
        playlist: r.playlist,
        live: true,
        cues: state.cues,
        presentation: (id) => r.presentations[id],
        media: (id) => r.media[id] ?? libMedia.get(id),
      };
    }
    const playlist = lib.playlists.find((p) => p.id === selectedId) ?? lib.playlists[0];
    const presMap: Record<string, Presentation> = {};
    for (const p of lib.presentations) presMap[p.id] = p;
    const mediaMap: Record<string, Media> = {};
    for (const m of lib.media) mediaMap[m.id] = m;
    const cues = playlist ? expandCues({ playlist, presentations: presMap, media: mediaMap }) : [];
    return {
      playlist,
      live: false,
      cues,
      presentation: (id) => presMap[id],
      media: (id) => mediaMap[id],
    };
  }, [state.mode, state.resolved, state.cues, lib.playlists, lib.presentations, lib.media, selectedId]);
}
