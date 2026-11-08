import { dismissToast, useToasts } from '../state/toasts.ts';

export function Toasts() {
  const list = useToasts((s) => s.list);
  return (
    <div className="toasts no-print">
      {list.map((t) => (
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
