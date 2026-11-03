import type { Presentation } from '@ordo/domain';
import { useState } from 'react';
import { useMediaLookup } from '../../hooks.ts';
import { previewBlockedReason, previewMedia, previewTargets } from '../../lib/preview.ts';
import { controller } from '../../services/controller.ts';
import { log } from '../../services/log.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';
import { toast } from '../../state/toasts.ts';

/**
 * "Send to preview" (prd/03): render the selected slide of the draft on one idle output. The hub relays
 * the `preview` message to that output; the output honours it only while no playlist is live and clears
 * it on the next live state. Disabled while a playlist is live.
 */
export function PreviewControl({ p, slideId }: { p: Presentation; slideId?: string }) {
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const health = useLive((s) => s.health);
  const state = useLive((s) => s.state);
  const [target, setTarget] = useState<string>('');
  const media = useMediaLookup();
  const ctl = controller();
  if (ctl?.role !== 'operate') return null;
  const targets = previewTargets(outputs, health, state);
  const blocked = previewBlockedReason(state, targets);
  const chosen = targets.find((t) => t.id === target) ?? targets[0];
  const send = (clear: boolean) => {
    if (!chosen) return;
    const ok = ctl.hub.send({
      t: 'preview',
      to: chosen.id,
      ...(clear
        ? { clear: true }
        : { presentation: { ...p, media: previewMedia(p, slideId, media) }, slideId }),
    } as never);
    if (!ok) {
      toast('Not connected to the hub; preview needs the hub.', 'warn');
      return;
    }
    log('info', `preview ${clear ? 'cleared' : 'sent'}: ${chosen.name}`);
  };
  return (
    <span className="row" style={{ gap: 4 }} title={blocked ?? 'Show the selected slide on an idle output'}>
      <select
        aria-label="Preview output"
        value={chosen?.id ?? ''}
        disabled={!!blocked}
        onChange={(e) => setTarget(e.target.value)}
        style={{ minHeight: 36 }}
      >
        {targets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
            {t.connected ? '' : ' (not open)'}
          </option>
        ))}
        {!targets.length && <option value="">No idle output</option>}
      </select>
      <button type="button" disabled={!!blocked || !slideId} onClick={() => send(false)}>
        Send to preview
      </button>
      <button type="button" disabled={!!blocked} onClick={() => send(true)}>
        Clear preview
      </button>
    </span>
  );
}
