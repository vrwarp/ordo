import { DEMO } from '@ordo/client';
import { useEffect, useRef } from 'react';
import { dotTitle, outputDot } from '../../lib/health.ts';
import { useProgram } from '../../services/programView.ts';
import { useLibrary } from '../../state/library.ts';
import { useLive } from '../../state/live.ts';

function PvVideo({ stream }: { stream?: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== (stream ?? null)) v.srcObject = stream ?? null;
    if (stream) void v.play().catch(() => undefined);
  }, [stream]);
  return <video ref={ref} muted playsInline autoPlay width={320} height={180} />;
}

/** Live pixels from every output over WebRTC with a health overlay (prd/02 Program view). */
export function ProgramView() {
  const outputs = useLibrary((s) => s.data.settings.outputs);
  const health = useLive((s) => s.health);
  const program = useProgram();
  const fallback = useLive((s) => s.authority === 'fallback');
  const list = outputs.filter((o) => o.enabled);
  return (
    <div className="program">
      <h4 style={{ margin: 0 }}>Program</h4>
      {fallback && (
        <span className="muted small">
          {DEMO
            ? 'The demo has no program view: Launch outputs opens the screens as windows.'
            : 'Program view pauses while the hub is unreachable.'}
        </span>
      )}
      {list.map((o) => {
        const h = health[o.id];
        const p = program[o.id];
        return (
          <div key={o.id} className="pv" title={dotTitle(h, o.name)}>
            <PvVideo stream={p?.stream} />
            {!p?.stream && (
              <div className="center muted small" style={{ position: 'absolute', inset: 0 }}>
                {h?.connected
                  ? p?.state === 'failed'
                    ? 'No picture (retrying)'
                    : 'Connecting…'
                  : 'Output not open'}
              </div>
            )}
            <div className="ov">
              <span className={`dot sm ${outputDot(h)}`} />
              <b>{o.name}</b>
              <span className="spacer" />
              {h && (
                <span className="muted">
                  {h.fps !== undefined ? `${h.fps.toFixed(0)} fps · ` : ''}missed {h.missed}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {list.length === 0 && <span className="muted small">No outputs configured.</span>}
    </div>
  );
}
