import { HUB_REASON_TEXT, type HubReason, useImportParse } from '../../services/pptxParse.ts';

const REASONS: HubReason[] = ['live', 'timeout', 'failed', 'unavailable'];

/**
 * What this browser did with the PowerPoint files it imported since the page loaded (design/27 §2 "Where the
 * deck is parsed"): how many it parsed itself, and how many it left to the hub and why. Each of those is in the
 * operator log too.
 */
export function ImportParsePanel() {
  const s = useImportParse();
  const left = REASONS.reduce((n, r) => n + s.hub[r], 0);
  return (
    <div className="col" style={{ gap: 4 }} data-import-parse>
      <span className="small">
        Parsed in this browser: <b data-import-parsed>{s.parsed}</b> · Left to the hub:{' '}
        <b data-import-hub>{left}</b>
      </span>
      {left > 0 && (
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          {REASONS.filter((r) => s.hub[r] > 0).map((r) => (
            <li key={r} data-import-reason={r}>
              {s.hub[r]} × {HUB_REASON_TEXT[r]}
            </li>
          ))}
        </ul>
      )}
      {s.last && (
        <span className="small muted">
          Last: {s.last.outcome === 'parsed' ? 'parsed here' : `hub (${HUB_REASON_TEXT[s.last.outcome]})`}
          {s.last.ms !== undefined ? `, ${s.last.ms} ms` : ''}
        </span>
      )}
    </div>
  );
}
