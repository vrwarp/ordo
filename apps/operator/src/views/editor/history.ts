/**
 * Undo/redo stack of immutable snapshots. `push` records the state before a change; consecutive pushes
 * with the same coalesce key within `coalesceMs` (nudges, typing) collapse into one undo step.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey?: string;
  private lastAt = 0;
  private limit: number;
  private coalesceMs: number;
  constructor(limit = 200, coalesceMs = 800) {
    this.limit = limit;
    this.coalesceMs = coalesceMs;
  }

  push(before: T, key?: string, now = Date.now()): void {
    if (key && key === this.lastKey && now - this.lastAt < this.coalesceMs) {
      this.lastAt = now;
      this.future = [];
      return;
    }
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.lastKey = key;
    this.lastAt = now;
  }

  undo(current: T): T | undefined {
    const prev = this.past.pop();
    if (prev === undefined) return undefined;
    this.future.push(current);
    this.lastKey = undefined;
    return prev;
  }

  redo(current: T): T | undefined {
    const next = this.future.pop();
    if (next === undefined) return undefined;
    this.past.push(current);
    this.lastKey = undefined;
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  clear(): void {
    this.past = [];
    this.future = [];
    this.lastKey = undefined;
  }

  /**
   * Move every snapshot with `fn` (the editor's draft was merged onto someone else's save, so its undo and
   * redo steps move with it and never take their work back out). A snapshot `fn` cannot move (undefined)
   * ends its stack: it and every step past it are dropped. The next push starts a new step.
   */
  rebase(fn: (snapshot: T) => T | undefined): void {
    const move = (stack: T[]) => {
      const out: T[] = [];
      // Nearest step first (the end of each stack), so a step that cannot move cuts off only those beyond it.
      for (let i = stack.length - 1; i >= 0; i--) {
        const moved = fn(stack[i]!);
        if (moved === undefined) break;
        out.push(moved);
      }
      return out.reverse();
    };
    this.past = move(this.past);
    this.future = move(this.future);
    this.lastKey = undefined;
  }
}
