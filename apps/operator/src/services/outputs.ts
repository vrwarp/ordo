import { appEnv, originOf, roleUrl } from '@ordo/client';
import type { Output } from '@ordo/domain';
import { create } from 'zustand';
import {
  type Placement,
  placementUpdates,
  planLaunch,
  type ScreenInfo,
  toScreenRef,
  windowFeatures,
  windowName,
} from '../lib/screens.ts';
import { saveSettings, settings } from '../state/library.ts';
import { useLive } from '../state/live.ts';
import { toast } from '../state/toasts.ts';
import type { Controller } from './controller.ts';
import { log } from './log.ts';
import { launchedEarlier, markLaunched } from './reacquire.ts';

type ScreenDetailed = ScreenInfo & { availLeft?: number; availTop?: number };
type WindowWithScreens = Window & {
  getScreenDetails?: () => Promise<{ screens: ScreenDetailed[] }>;
};

export type LaunchStore = {
  /** Outputs that opened on the primary screen because their saved screen was not found. */
  unmatched: Placement[];
  screens: ScreenInfo[];
  open: Record<string, boolean>;
  busy: boolean;
  permission?: 'granted' | 'denied' | 'unsupported';
};

export const useLaunch = create<LaunchStore>(() => ({ unmatched: [], screens: [], open: {}, busy: false }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens, tracks and relaunches the output and stage windows (design/15, Launching outputs). */
export class OutputWindows {
  private windows = new Map<string, Window>();
  private watch?: ReturnType<typeof setInterval>;

  constructor(private ctl: Controller) {
    this.watch = setInterval(() => this.refreshOpen(), 2000);
    this.ensureBroadcastRelays();
  }

  ensureBroadcastRelays(): void {
    if (typeof BroadcastChannel === 'undefined' || appEnv().domain) return;
    for (const o of settings().outputs) {
      if (o.enabled && o.token) {
        const url = this.urlFor(o);
        const origin = url ? originOf(url) : location.origin;
        this.ctl.core.attachBroadcast(o.id, origin);
      }
    }
  }

  dispose(): void {
    clearInterval(this.watch);
  }

  urlFor(o: Output): string | null {
    if (!o.token) return null;
    return roleUrl(o.kind === 'stage' ? 'stage' : 'output', {
      domain: appEnv().domain,
      hostIndex: o.hostIndex,
      outputId: o.id,
      token: o.token,
    });
  }

  async screens(): Promise<ScreenInfo[]> {
    const w = window as WindowWithScreens;
    if (typeof w.getScreenDetails === 'function') {
      try {
        // A pending permission prompt never resolves on its own. Give up after 4 s (still inside the
        // click's transient activation, so window.open keeps working) and place on this screen;
        // once the prompt is answered, the next Launch uses every screen.
        const d = await Promise.race([
          w.getScreenDetails(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('permission prompt pending')), 4000),
          ),
        ]);
        useLaunch.setState({ permission: 'granted' });
        return d.screens.map((s) => ({
          label: s.label,
          left: s.left ?? s.availLeft ?? 0,
          top: s.top ?? s.availTop ?? 0,
          width: s.width,
          height: s.height,
          isPrimary: s.isPrimary,
        }));
      } catch (e) {
        log('warn', `getScreenDetails: ${String(e)}`);
        useLaunch.setState({ permission: 'denied' });
      }
    } else useLaunch.setState({ permission: 'unsupported' });
    const s = window.screen as Screen & { availLeft?: number; availTop?: number };
    return [
      {
        label: 'This screen',
        left: s.availLeft ?? 0,
        top: s.availTop ?? 0,
        width: s.width,
        height: s.height,
        isPrimary: true,
      },
    ];
  }

  /** Launch every enabled output on its remembered screen. Must run inside a user gesture. */
  async launch(): Promise<void> {
    // An edit-profile device (an iPad) has no screens to put outputs on (design/15 "iPad editing").
    if (this.ctl.role !== 'operate') return;
    if (useLaunch.getState().busy) return;
    useLaunch.setState({ busy: true });
    try {
      const outputs = settings().outputs;
      if (!outputs.length) {
        toast('No outputs configured. Add outputs in Settings → Outputs.', 'warn');
        return;
      }
      const screens = await this.screens();
      const plan = planLaunch(outputs, screens);
      for (const p of plan) this.openOne(p.output, p.screen);
      const updates = placementUpdates(plan);
      if (updates.length) {
        const byId = new Map(updates.map((o) => [o.id, o]));
        await saveSettings(
          'outputs',
          settings().outputs.map((o) => byId.get(o.id) ?? o),
        ).catch((e) => log('warn', `saving placements: ${String(e)}`));
      }
      const unmatched = plan.filter((p) => !p.matched);
      useLaunch.setState({ unmatched, screens });
      log('info', `launched ${plan.length} windows (${unmatched.length} need placement)`);
      if (plan.length) markLaunched(true);
    } finally {
      useLaunch.setState({ busy: false });
      this.refreshOpen();
    }
  }

  /**
   * Close every window, wait 500 ms, reopen (prd/02 Relaunch outputs). Windows this page did not open
   * (an earlier tab's) are first re-acquired by name so they can be closed; when that fails the user is
   * told, and opening by name still navigates the existing window of that name.
   */
  async relaunch(): Promise<void> {
    // Off the click's own dispatch: opening and closing probe windows (reacquire) inside the input event
    // can leave Chromium's input pipeline waiting (an automated click never completes). Still within the
    // gesture's transient activation, so window.open keeps working.
    await sleep(0);
    const before = this.missing();
    if (before.length) {
      const n = this.reacquire();
      const still = this.missing();
      log('info', `relaunch: re-acquired ${n} of ${before.length} windows without a handle`);
      if (still.length)
        toast(
          `Relaunch: ${still.length} output window${still.length === 1 ? ' was' : 's were'} opened by another operator tab and cannot be closed from here (${still.map((o) => o.name).join(', ')}). Opening new windows; the old ones close themselves once the new ones connect to the hub.`,
          'warn',
          12_000,
        );
    }
    this.closeAll();
    await sleep(500);
    await this.launch();
  }

  /** Enabled outputs this page holds no WindowProxy for. */
  missing(): Output[] {
    return settings().outputs.filter((o) => o.enabled && !!o.token && !this.windows.has(o.id));
  }

  openOne(o: Output, screen: ScreenInfo): Window | null {
    const url = this.urlFor(o);
    if (!url) {
      toast(`${o.name}: no token. Rotate its token in Settings → Outputs.`, 'error');
      return null;
    }
    const w = window.open(url, windowName(o.id), windowFeatures(screen));
    if (!w) {
      toast(`Chrome blocked the window for ${o.name}. Allow pop-ups for this site.`, 'error', 10000);
      return null;
    }
    this.windows.set(o.id, w);
    this.ctl.core.attachWindow(o.id, w, originOf(url));
    return w;
  }

  /** Re-place one output (placement dialog) and remember its screen. */
  async place(o: Output, screen: ScreenInfo): Promise<void> {
    this.closeOne(o.id);
    await sleep(300);
    this.openOne(o, screen);
    const ref = toScreenRef(screen);
    await saveSettings(
      'outputs',
      settings().outputs.map((x) => (x.id === o.id ? { ...x, screen: ref } : x)),
    );
    useLaunch.setState((s) => ({ unmatched: s.unmatched.filter((p) => p.output.id !== o.id) }));
    this.refreshOpen();
  }

  /**
   * Reopen one output after a token rotation. Without a handle (the page was reloaded since Launch) it
   * still opens by name when a window of that output is known to exist, so the old window does not
   * keep the revoked token and freeze (item 29).
   */
  async reopen(o: Output): Promise<void> {
    const had = this.windows.has(o.id);
    if (!had) {
      const h = useLive.getState().health[o.id];
      const exists = !!h?.connected || launchedEarlier() || this.reacquire() > 0;
      if (!exists) return;
      if (!this.windows.has(o.id)) log('warn', `reopen ${o.name}: no window handle; opening by name`);
    }
    const screens = await this.screens();
    const plan = planLaunch([{ ...o, enabled: true }], screens)[0];
    this.closeOne(o.id);
    await sleep(500);
    if (plan) this.openOne(o, plan.screen);
  }

  closeOne(id: string): void {
    const w = this.windows.get(id);
    try {
      w?.close();
    } catch {
      /* gone */
    }
    this.windows.delete(id);
    this.ctl.core.detachWindow(id);
  }

  closeAll(): void {
    for (const id of [...this.windows.keys()]) this.closeOne(id);
    markLaunched(false);
    // Windows opened by a previous operator page are reachable by name only through window.open.
    this.refreshOpen();
  }

  /**
   * After an operator reload the WindowProxy handles are gone. Opening the stable window name with an
   * empty URL returns an existing output window without navigating it; a fresh blank window is closed.
   */
  reacquire(): number {
    let n = 0;
    for (const o of settings().outputs) {
      if (!o.enabled || this.windows.has(o.id)) continue;
      const url = this.urlFor(o);
      if (!url) continue;
      let w: Window | null = null;
      try {
        w = window.open('', windowName(o.id));
      } catch {
        w = null;
      }
      if (!w) continue;
      let blank = false;
      try {
        blank = w.location.href === 'about:blank';
      } catch {
        blank = false; // cross-origin: an existing output window
      }
      if (blank) {
        // Closed after this task, not inside the open: closing a popup synchronously right after creating it
        // can leave the renderer waiting on the browser process (the page then hangs).
        setTimeout(() => w.close(), 0);
        continue;
      }
      this.windows.set(o.id, w);
      this.ctl.core.attachWindow(o.id, w, originOf(url));
      n++;
    }
    this.refreshOpen();
    return n;
  }

  isOpen(id: string): boolean {
    const w = this.windows.get(id);
    return !!w && !w.closed;
  }

  private refreshOpen(): void {
    const open: Record<string, boolean> = {};
    for (const [id, w] of this.windows) open[id] = !w.closed;
    const prev = useLaunch.getState().open;
    const same =
      Object.keys(open).length === Object.keys(prev).length &&
      Object.entries(open).every(([k, v]) => prev[k] === v);
    if (!same) useLaunch.setState({ open });
  }
}

let current: OutputWindows | undefined;
export function outputWindows(): OutputWindows | undefined {
  return current;
}
export function installOutputWindows(ctl: Controller): OutputWindows {
  current?.dispose();
  current = new OutputWindows(ctl);
  ctl.hooks.launch = () => void current?.launch();
  ctl.hooks.relaunch = () => void current?.relaunch();
  return current;
}
