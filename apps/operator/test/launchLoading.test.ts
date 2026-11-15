/**
 * Launch outputs pressed before the library has loaded (services/outputs.ts; design/15 "Launching outputs"):
 * the outputs are not known yet, so it says the library is still loading and to press again, never "No
 * outputs configured" (seen on a loaded machine when Launch was pressed as the live view appeared: the PR #27
 * fallback-leave verify). When the hub did not answer and there is no saved copy, it says that instead (the
 * review of the merge). Once the library has loaded with no outputs, it still says none are configured; with
 * one, it opens its window.
 */
import type { Output } from '@ordo/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installOutputWindows,
  LAUNCH_LOADING_TEXT,
  LAUNCH_UNLOADED_TEXT,
  type OutputWindows,
} from '../src/services/outputs.ts';
import { useLibrary } from '../src/state/library.ts';
import { useToasts } from '../src/state/toasts.ts';

const OUTPUT: Output = {
  id: 'out-a',
  name: 'Audience',
  kind: 'output',
  hostIndex: 1,
  lookId: 'look-main',
  enabled: true,
  audioMaster: false,
  token: 'tok-a',
};

function controller() {
  return {
    role: 'operate',
    hooks: {},
    core: { attachBroadcast: vi.fn(), attachWindow: vi.fn(), detachWindow: vi.fn() },
  };
}

const texts = () => useToasts.getState().list.map((t) => t.text);

describe('Launch outputs before the library has loaded', () => {
  const store = new Map<string, string>();
  const origWindow = (globalThis as unknown as { window?: unknown }).window;
  const origSessionStorage = (globalThis as unknown as { sessionStorage?: unknown }).sessionStorage;
  const library = useLibrary.getState();
  let ow: OutputWindows | undefined;
  let open: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store.clear();
    useToasts.setState({ list: [] });
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
    open = vi.fn().mockReturnValue({ closed: false, close: vi.fn(), focus: vi.fn() });
    (globalThis as unknown as { window: unknown }).window = {
      open,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      screen: { width: 1920, height: 1080 },
    };
    vi.stubGlobal('location', new URL('http://127.0.0.1:8090/'));
    ow = installOutputWindows(controller() as never);
  });

  afterEach(() => {
    ow?.dispose();
    ow = undefined;
    useLibrary.setState(library, true);
    useToasts.setState({ list: [] });
    vi.unstubAllGlobals();
    (globalThis as unknown as { window: unknown }).window = origWindow;
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = origSessionStorage;
  });

  it('says the library is still loading, opens nothing, and does not claim no outputs are configured', async () => {
    useLibrary.setState({ loaded: false, attempted: false, source: 'none' });
    expect(useLibrary.getState().data.settings.outputs).toEqual([]);
    await ow?.launch();
    expect(texts()).toEqual([LAUNCH_LOADING_TEXT]);
    expect(LAUNCH_LOADING_TEXT).toContain('still loading');
    expect(texts().join()).not.toContain('No outputs configured');
    expect(open).not.toHaveBeenCalled();
  });

  it('when the hub did not answer and there is no saved copy, it says so, not that the library is loading', async () => {
    // The core tried its saved copy and the hub, and has neither (state/library.ts `attempted`): "press again in
    // a moment" would never come true. It loads again when the hub connects (core/engine.ts, on welcome).
    useLibrary.setState({ loaded: false, attempted: true, source: 'none', error: 'Failed to fetch' });
    await ow?.launch();
    expect(texts()).toEqual([LAUNCH_UNLOADED_TEXT]);
    expect(LAUNCH_UNLOADED_TEXT).toContain('no saved copy');
    expect(texts()).not.toContain(LAUNCH_LOADING_TEXT);
    expect(texts().join()).not.toContain('No outputs configured');
    expect(open).not.toHaveBeenCalled();
  });

  it('once loaded with no outputs it says none are configured', async () => {
    useLibrary.setState({ loaded: true, attempted: true, source: 'hub' });
    await ow?.launch();
    expect(texts()).toEqual(['No outputs configured. Add outputs in Settings → Outputs.']);
    expect(open).not.toHaveBeenCalled();
  });

  it('once loaded with an output, Launch opens its window and says nothing of loading', async () => {
    useLibrary.setState({
      loaded: true,
      attempted: true,
      source: 'hub',
      data: { ...library.data, settings: { ...library.data.settings, outputs: [OUTPUT] } },
    });
    await ow?.launch();
    expect(open).toHaveBeenCalledTimes(1);
    expect(texts()).not.toContain(LAUNCH_LOADING_TEXT);
    expect(texts().join()).not.toContain('No outputs configured');
  });
});
