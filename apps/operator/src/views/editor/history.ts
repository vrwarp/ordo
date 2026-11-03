/**
 * Undo/redo stack of immutable snapshots. `push` records the state before a change; consecutive pushes
 * with the same coalesce key within `coalesceMs` (nudges, typing) collapse into one undo step.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];
  private lastKey?: string;
  private lastAt = 0;
  constructor(
    private limit = 200,
    private coalesceMs = 800,
  ) {}

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
}
