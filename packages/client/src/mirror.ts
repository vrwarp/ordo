import type { LiveEvent, LiveState } from '@ordo/domain';
import { initialState, isLiveStateShape, safeReduce } from '@ordo/live-state';
import type { LiveDeltaMsg } from '@ordo/protocol';
import { Emitter } from './emitter.ts';

/**
 * A read-only replica of the live state for outputs and stage. Applies full states and deltas from
 * whichever bus is active, and reports sequence gaps so the caller can resync. Malformed input from the
 * wire never throws: the previous state is kept and a `gap` is emitted so the caller asks for a full
 * state.
 */
export class LiveMirror extends Emitter<{
  change: { state: LiveState; event?: LiveEvent };
  gap: { have: number; got: number };
}> {
  state: LiveState = initialState();
  private hasState = false;

  get ready(): boolean {
    return this.hasState;
  }

  /** Returns false (state kept, gap emitted) when the state is malformed. */
  applyState(state: LiveState): boolean {
    if (!isLiveStateShape(state)) {
      console.error('[ordo] malformed live state ignored');
      this.emit('gap', { have: this.state.seq, got: (state as { seq?: number } | undefined)?.seq ?? -1 });
      return false;
    }
    this.state = state;
    this.hasState = true;
    this.emit('change', { state });
    return true;
  }

  applyDelta(m: Pick<LiveDeltaMsg, 'fromSeq' | 'event' | 'seq'>): boolean {
    if (!this.hasState) return false;
    if (m.seq <= this.state.seq) return true; // duplicate (both buses) — already applied
    if (m.fromSeq !== this.state.seq) {
      this.emit('gap', { have: this.state.seq, got: m.fromSeq });
      return false;
    }
    let failed = false;
    const next = safeReduce(this.state, m.event, (err) => {
      failed = true;
      console.error('[ordo] live delta could not be applied', err);
    });
    if (failed) {
      this.emit('gap', { have: this.state.seq, got: m.fromSeq });
      return false;
    }
    this.state = next;
    this.emit('change', { state: this.state, event: m.event });
    return true;
  }
}
