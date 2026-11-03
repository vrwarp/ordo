/** Stable React keys for lists that may contain duplicates: `<value>#<occurrence>`. */
export function keyed<T>(list: T[], id: (x: T) => string): { key: string; value: T }[] {
  const seen = new Map<string, number>();
  return list.map((value) => {
    const base = id(value);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { key: `${base}#${n}`, value };
  });
}
