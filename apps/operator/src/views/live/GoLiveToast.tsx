import type { GoLivePrepare } from '../../core/protocol.ts';
import { controller } from '../../services/controller.ts';
import { useLive } from '../../state/live.ts';

/**
 * W41's text (design/29 §3) while the hub prepares a Go live beside the running service (M8). The second
 * sentence only while a service is live: otherwise there is no current service for the screens to keep.
 */
export function goLivePrepareText(p: GoLivePrepare): string {
  // W41
  const first = `Getting '${p.title}' ready to go live (${p.pct} %).`;
  return p.live ? `${first} The screens keep showing the current service until then.` : first;
}

/** W41's progress toast while the hub prepares a Go live (mounted in the toasts). */
export function GoLivePrepareToast() {
  const p = useLive((s) => s.goLivePrepare);
  return p ? <GoLivePrepareView p={p} /> : null;
}

/** The toast itself, and after 5 s while live its button "Go live from the copy saved 3 days ago". */
export function GoLivePrepareView({ p }: { p: GoLivePrepare }) {
  return (
    <div className="toast info" role="status" data-golive-prepare={p.pct}>
      <span className="grow">{goLivePrepareText(p)}</span>
      {p.savedAgo && (
        <button
          type="button"
          className="small"
          data-golive-saved
          onClick={() => controller()?.goLiveFromSaved(p.playlistId)}
        >
          {`Go live from the copy saved ${p.savedAgo}`}
        </button>
      )}
    </div>
  );
}
