import type { DegradedKind } from '@ordo/domain';
import { useState } from 'react';
import { degradedKey, summarizeDegraded } from '../../lib/degraded.ts';
import { useLive } from '../../state/live.ts';

const slides = (n: number) => (n === 1 ? 'One slide' : `${n} slides`);

/**
 * The cue rows by what their slides show (`degradedKind`): only a quarantined slide is empty; a slide whose
 * clip, sound, background or PowerPoint picture is not ready shows its poster or goes without it, and going
 * live again once it is ready brings it back; a PowerPoint slide LibreOffice is drawing shows what it has.
 */
const groups: { kind: DegradedKind; title: (n: number) => string; after?: string }[] = [
  {
    kind: 'empty',
    title: (n) =>
      `${slides(n)} could not be shown and ${n === 1 ? 'was' : 'were'} replaced with an empty slide:`,
    after: 'Fix them in the editor after the service.',
  },
  {
    kind: 'media',
    title: (n) => `${slides(n)} went live without media that is not ready:`,
    after: 'A clip still processing plays once you go live again after it is ready.',
  },
  {
    kind: 'drawing',
    title: (n) => `${slides(n)} from PowerPoint ${n === 1 ? 'is' : 'are'} not fully drawn yet:`,
  },
  { kind: 'other', title: (n) => `${slides(n)} went live with a warning:` },
];

/**
 * Shows what the hub quarantined when the service went live (design/25): a playlist taken from a cached copy
 * because the library did not answer, slides replaced by empty ones because their data was invalid, and
 * slides that went live without media that is not ready or before LibreOffice drew them (design/27 §5, §8),
 * each with its reason. The service runs either way; the operator must know. Dismissable for the current
 * service.
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
        {groups.map((g) => {
          const rows = sum.cues.filter((c) => c.kind === g.kind);
          if (!rows.length) return null;
          return (
            <div key={g.kind} data-degraded-kind={g.kind}>
              <b>{g.title(rows.length)}</b>
              <ul style={{ margin: '2px 0 4px', paddingLeft: 18 }}>
                {rows.map((c) => (
                  <li key={`${c.cueIndex}:${c.reason}`}>
                    {c.label}
                    {g.kind === 'empty' ? '' : ` — ${c.reason}`}
                  </li>
                ))}
              </ul>
              {g.after}
            </div>
          );
        })}
      </div>
      <button type="button" onClick={() => setDismissed(key)}>
        Dismiss
      </button>
    </div>
  );
}
