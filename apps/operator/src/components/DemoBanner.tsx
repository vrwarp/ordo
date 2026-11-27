import { useState } from 'react';
import { toast } from '../state/toasts.ts';
import { confirmDialog } from './Confirm.tsx';
import { Dialog } from './Dialog.tsx';

/** The demo's VM hub, when this page runs it (apps/demo/src/vm-host.ts; packages/client demo.ts sets it). */
type VmHub = {
  downloadLogs(): Promise<{ name: string; blob: Blob }>;
  showConsole(): Promise<void>;
};
const vmHub = (): VmHub | undefined => (globalThis as { __ordoVm?: VmHub | null }).__ordoVm ?? undefined;

/** The hub's diagnostics for the demo's VM hub: a console into its machine, and every log in one file. */
function VmHubTools({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const vm = vmHub();
  if (!vm) return null;
  const download = async () => {
    setBusy(true);
    try {
      const { name, blob } = await vm.downloadLogs();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast(`The logs could not be collected: ${e instanceof Error ? e.message : String(e)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 8 }} data-demo-vm-tools>
      <p className="small muted" style={{ margin: 0, lineHeight: 1.5 }}>
        The hub runs here, in a Linux machine inside this tab. For debugging: a shell in that machine, or its
        logs and this page's in one file (the hub's own export is in Settings → Diagnostics).
      </p>
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="small"
          onClick={() => {
            onClose();
            void vm
              .showConsole()
              .catch((e: unknown) => toast(`The console did not open: ${String(e)}`, 'error'));
          }}
        >
          Hub console
        </button>
        <button type="button" className="small" disabled={busy} onClick={() => void download()}>
          {busy ? 'Collecting logs…' : 'Download VM logs'}
        </button>
      </div>
    </div>
  );
}

/**
 * The IndexedDB databases the demo's pages keep: the demo hub's (apps/demo/src/store.ts) and the JsonStore
 * of the operator core, the output and the stage link workers. Listed for browsers without
 * `indexedDB.databases()`, which otherwise only see the demo hub's stores cleared.
 */
const KNOWN_DATABASES = ['ordo-demo-hub', 'ordo-operator', 'ordo-output', 'ordo-stage', 'ordo-drafts'];

/** Forget everything this browser stored for the demo (the demo hub re-seeds on the next request). */
export async function resetDemo(): Promise<void> {
  if (
    !(await confirmDialog(
      'Reset the demo',
      'Remove your songs, playlists, imports and settings from this browser and start again from the sample service?',
      'Reset',
      true,
    ))
  )
    return;
  try {
    await fetch('/api/v1/demo/reset', { method: 'POST' });
  } catch {
    /* the service worker may be gone: clear below anyway */
  }
  try {
    const listed = (await indexedDB.databases?.()) ?? [];
    const names = new Set(KNOWN_DATABASES);
    for (const d of listed) if (d.name) names.add(d.name);
    await Promise.all(
      [...names].map(
        (name) =>
          new Promise<void>((done) => {
            const r = indexedDB.deleteDatabase(name);
            r.onsuccess = r.onerror = r.onblocked = () => done();
          }),
      ),
    );
    for (const k of await caches.keys()) await caches.delete(k);
    localStorage.clear();
    sessionStorage.clear();
  } finally {
    location.reload();
  }
}

/**
 * Modal dialog displaying the demo description and reset controls when clicking the "demo" badge.
 */
export function DemoDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      title={
        <span>
          <b>ordo</b> demo
        </span>
      }
      onClose={onClose}
      width={480}
      footer={
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <a
            href="https://github.com/vrwarp/ordo"
            target="_blank"
            rel="noreferrer"
            className="small"
            style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}
          >
            Source on GitHub ↗
          </a>
          <div className="row" style={{ gap: 8 }}>
            <button
              type="button"
              className="small danger"
              onClick={() => {
                onClose();
                void resetDemo();
              }}
            >
              Reset demo
            </button>
            <button type="button" className="small" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <p style={{ margin: 0, lineHeight: 1.6, color: 'var(--fg)', fontSize: 14 }}>
          Everything runs in this browser and stays in it: import a ProPresenter song or playlist, edit the
          sample service, press <b>Go live</b> and <b>Launch outputs</b>.
        </p>
        <VmHubTools onClose={onClose} />
      </div>
    </Dialog>
  );
}

/**
 * Legacy top bar (no longer rendered above Nav; preserved for backwards compatibility).
 */
export function DemoBanner() {
  return null;
}
