import { API_PREFIX } from '@ordo/protocol';
import { downloadOperatorLog, HealthTable, OperatorLog } from '../live/DiagnosticsPanel.tsx';

export function DiagnosticsPage() {
  return (
    <div className="col" style={{ gap: 12 }}>
      <h2>Diagnostics</h2>
      <HealthTable />
      <h4>Operator log</h4>
      <OperatorLog limit={200} />
      <div className="row">
        <a className="btn primary" href={`${API_PREFIX}/diagnostics/export`} download>
          Export hub diagnostics (zip)
        </a>
        <button type="button" onClick={downloadOperatorLog}>
          Download operator log
        </button>
      </div>
      <span className="muted small">Exports contain no PINs, tokens or cookies.</span>
    </div>
  );
}
