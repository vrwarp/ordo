import type { LiveEvent, LiveState } from '@ordo/domain';
import { initialState, reduce } from '@ordo/live-state';
import type { LiveDeltaMsg } from '@ordo/protocol';
import { Emitter } from './emitter.ts';

/**
 * A read-only replica of the live state for outputs and stage. Applies full states and deltas from
 * whichever bus is active, and reports sequence gaps so the caller can resync.
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

  applyState(state: LiveState): void {
    this.state = state;
    this.hasState = true;
    this.emit('change', { state });
  }

  applyDelta(m: Pick<LiveDeltaMsg, 'fromSeq' | 'event' | 'seq'>): boolean {
    if (!this.hasState) return false;
    if (m.seq <= this.state.seq) return true; // duplicate (both buses) — already applied
    if (m.fromSeq !== this.state.seq) {
      this.emit('gap', { have: this.state.seq, got: m.fromSeq });
      return false;
    }
    this.state = reduce(this.state, m.event);
    this.emit('change', { state: this.state, event: m.event });
    return true;
  }
}
