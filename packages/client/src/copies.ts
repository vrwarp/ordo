import type { LiveState, ResolvedPlaylist } from '@ordo/domain';
import type { LiveStateMsg } from '@ordo/protocol';

/**
 * The resolved copy of the running service a window holds, and the join of a by-name live state to it
 * (design/29 §2.3 M2, live-by-ref).
 *
 * A window holds ONE copy: the one the hub gave this connection (a whole `live.state`, or a goLive delta, each
 * with its `resolvedId`: the SHA-256 of the copy's bytes), or one it saved itself under that id and loaded again
 * (`seed`). A resolved object that came from anywhere else (the fallback bus, the operator's own offline
 * resolve) is never held: the hello would then name a copy the hub never gave it.
 *
 * Identity is the point: a by-name state is joined to the held OBJECT, so `state.resolved` keeps its identity
 * across a reconnect, a resync and a restart from the saved record, and everything keyed by it (the units, the
 * warm-up, the files) is not made again.
 */
export class HeldCopy {
  id?: string;
  value?: ResolvedPlaylist;

  /** The hub gave the connection this copy under this id (a whole state or a goLive delta). */
  hold(id: string, resolved: ResolvedPlaylist): void {
    this.id = id;
    this.value = resolved;
  }

  /** The window's own saved record of a copy the hub gave it (loaded before the link starts). */
  seed(id: string, resolved: ResolvedPlaylist): void {
    this.hold(id, resolved);
  }

  /** The held copy, if it is the one named `id`. */
  get(id: string): ResolvedPlaylist | undefined {
    return this.id !== undefined && this.id === id ? this.value : undefined;
  }

  clear(): void {
    this.id = undefined;
    this.value = undefined;
  }
}

/**
 * A `live.state` message, ready to apply: a state that carries its copy, an idle state, and a message of an
 * older shape (no `resolvedId`) come back as they are; a live state without its copy gets the held copy of that
 * id (the same object every time), and `"need"` when the id is not the one held (the caller asks the hub for the
 * whole state and applies nothing).
 */
export function joinState(m: LiveStateMsg, held: HeldCopy): { state: LiveState } | 'need' {
  const s = m.state;
  if (s.resolved || s.mode !== 'live') return { state: s };
  // A live state that names no copy and carries none is an older shape: applied as it came (as before).
  if (m.resolvedId === undefined) return { state: s };
  const value = held.get(m.resolvedId);
  if (!value) return 'need';
  return { state: { ...s, resolved: value } };
}
