import { DEMO } from '@ordo/client';
import { controller } from '../services/controller.ts';
import { useLive } from '../state/live.ts';

/**
 * Every Go live button goes through here. With the hub connected the hub resolves the playlist, as always.
 * Without it the operator is asked first (LocalGoLiveDialog): this PC resolves the playlist from its cached
 * library and runs the service itself until End service (design/17 "Going live without the hub").
 */
export function startService(playlistId: string): void {
  const s = useLive.getState();
  // The GitHub Pages demo has no hub: every service runs in the browser, without asking.
  if (DEMO) {
    controller()?.goLiveLocal(playlistId);
    return;
  }
  if (s.hubConnected) {
    controller()?.goLive(playlistId);
    return;
  }
  useLive.setState({ localGoLive: playlistId });
  controller()?.offlineCheck(playlistId);
}
