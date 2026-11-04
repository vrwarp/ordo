import { useState } from 'react';
import { degradedKey, summarizeDegraded } from '../../lib/degraded.ts';
import { useLive } from '../../state/live.ts';

/**
 * Shows what the hub quarantined when the service went live (design/25): a playlist taken from a cached copy
 * because the library did not answer, and slides replaced by empty ones because their data was invalid.
 * The service runs either way; the operator must know. Dismissable for the current service.
 */
export function DegradedBanner() {
  const resolved = useLive((s) => s.state.resolved);
  const cues = useLive((s) => s.state.cues);
  const key = degradedKey(resolved);
  const [dismissed, setDismissed] = useState('');
  if (!key || dismissed === key) return null;
  const sum = summarizeDegraded(resolved, cues);
  if (!sum.service.length && !sum.cues.length) return null;
  return (
    <div
      className="banner"
      data-degraded
      style={{ margin: '6px 12px', display: 'flex', gap: 12, alignItems: 'flex-start' }}
    >
      <div style={{ flex: 1 }}>
        {sum.service.map((r) => (
          <div key={r}>
            <b>Live with a warning:</b> {r}
          </div>
        ))}
        {sum.cues.length > 0 && (
          <div>
            <b>
              {sum.cues.length === 1 ? 'One slide' : `${sum.cues.length} slides`} could not be shown and{' '}
              {sum.cues.length === 1 ? 'was' : 'were'} replaced with an empty slide:
            </b>{' '}
            {sum.cues.map((c) => c.label).join('; ')}. Fix them in the editor after the service.
          </div>
        )}
      </div>
      <button type="button" onClick={() => setDismissed(key)}>
        Dismiss
      </button>
    </div>
  );
}
