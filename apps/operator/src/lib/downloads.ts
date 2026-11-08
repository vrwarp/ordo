/**
 * Downloads in flight, shared across cache fills (the rule the output got in review 2026-11-04 item 11):
 * a manifest change cancels only the downloads whose hash left the manifest; a file still wanted keeps
 * downloading and the next fill joins it instead of starting over. Generic over the download's result.
 */
export class SharedDownloads<T> {
  private map = new Map<string, { ac: AbortController; p: Promise<T> }>();

  get size(): number {
    return this.map.size;
  }

  has(hash: string): boolean {
    return this.map.has(hash);
  }

  /** The download of `hash` in flight, else a new one running `fn` with its own abort signal. */
  run(hash: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const have = this.map.get(hash);
    if (have) return have.p;
    const ac = new AbortController();
    const p = fn(ac.signal).finally(() => {
      if (this.map.get(hash)?.p === p) this.map.delete(hash);
    });
    this.map.set(hash, { ac, p });
    return p;
  }

  /** Abort every download whose hash is not in `keep`; returns how many were aborted. */
  retain(keep: ReadonlySet<string>): number {
    let n = 0;
    for (const [h, d] of this.map)
      if (!keep.has(h)) {
        d.ac.abort();
        this.map.delete(h);
        n++;
      }
    return n;
  }

  /** Abort everything (the fill is given up, not replaced). */
  abortAll(): number {
    return this.retain(new Set());
  }
}
