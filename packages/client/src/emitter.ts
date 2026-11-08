export class Emitter<E extends Record<string, unknown>> {
  private handlers: { [K in keyof E]?: Set<(v: E[K]) => void> } = {};
  on<K extends keyof E>(k: K, fn: (v: E[K]) => void): () => void {
    let set = this.handlers[k];
    if (!set) {
      set = new Set();
      this.handlers[k] = set;
    }
    set.add(fn);
    return () => set!.delete(fn);
  }
  emit<K extends keyof E>(k: K, v: E[K]): void {
    const set = this.handlers[k];
    if (!set) return;
    for (const fn of set) {
      try {
        fn(v);
      } catch (err) {
        console.error('[ordo] handler error', err);
      }
    }
  }
}
