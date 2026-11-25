import { dismissToast, useToasts } from '../state/toasts.ts';
import { useCoarsePointer } from './pointer.ts';

export function Toasts() {
  const list = useToasts((s) => s.list);
  const coarse = useCoarsePointer();
  // On desktop (fine pointer), routine ok/info confirmations render inline in StatusBar;
  // floating HUD alerts are reserved for warnings, errors, and sticky notices.
  const visible = coarse ? list : list.filter((t) => t.kind === 'warn' || t.kind === 'error' || t.sticky);
  if (visible.length === 0) return null;
  return (
    <div className="toasts no-print">
      {visible.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="grow" style={{ whiteSpace: 'pre-line' }}>
            {t.text}
          </span>
          <button type="button" className="ghost small" onClick={() => dismissToast(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
