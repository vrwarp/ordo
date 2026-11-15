import { installCacheCheck } from './cacheCheck.ts';
import type { Controller } from './controller.ts';
import { installOutputWindows } from './outputs.ts';
import { installProgramViews } from './programView.ts';
import { reacquireOnFirstGesture } from './reacquire.ts';
import { installSurfaces } from './surfaces.ts';

/**
 * What only an operator core runs (design/15 "iPad editing", design/28 §2.1): output windows, program views,
 * the keyboard, Stream Deck and MIDI, the service-cache check and the first-gesture reacquire of output
 * windows, installed in this order. A module of its own (src/pages.ts OPERATE) so the entry never holds the
 * output and control-surface code: the venue PC loads it before its Shell mounts and installs it in the
 * controller's effect, synchronously, so the keyboard effect after it finds the surfaces. Returns the cache
 * check's off.
 */
export function installOperate(ctl: Controller): () => void {
  installOutputWindows(ctl);
  installProgramViews(ctl);
  installSurfaces(ctl);
  const offCacheCheck = installCacheCheck();
  reacquireOnFirstGesture();
  return offCacheCheck;
}

export { surfaces } from './surfaces.ts';
