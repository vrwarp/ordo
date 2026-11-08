/**
 * Service-cache keep policy for an output window (design/17, review item 8). Pure: the output's main
 * thread records every manifest it filled while live and asks what to keep when it prunes.
 *
 * Rules: never prune on an idle manifest (End service leaves the cache intact for the next Go live);
 * while live, keep the union of the current manifest and the manifests filled recently, bounded by an
 * age and a byte budget (newest first), so a relaunch or the next service re-downloads nothing.
 */

export type CacheFile = { hash: string; bytes: number };

export type RecentManifest = {
  /** Manifest signature (sorted hashes), to recognise the same playlist again. */
  sig: string;
  /** When it was last filled (ms since epoch). */
  at: number;
  files: CacheFile[];
};

export type KeepPolicy = {
  /** Manifests older than this drop out of the keep set. Default 14 days. */
  maxAgeMs?: number;
  /** Stop keeping older manifests once the unique bytes kept exceed this. Default 6 GiB. */
  budgetBytes?: number;
  /** Upper bound on remembered manifests. Default 12. */
  maxEntries?: number;
};

const DEFAULTS = { maxAgeMs: 14 * 86_400_000, budgetBytes: 6 * 1024 ** 3, maxEntries: 12 };

/** Whether a fill result may prune: only while a playlist is live and every file arrived. */
export function mayPrune(live: boolean, failed: number): boolean {
  return live && failed === 0;
}

/**
 * Record a live manifest as filled at `now`: newest first, one entry per signature, trimmed by age,
 * entry count and byte budget (the newest always stays).
 */
export function rememberManifest(
  recent: readonly RecentManifest[],
  sig: string,
  files: readonly CacheFile[],
  now: number,
  policy: KeepPolicy = {},
): RecentManifest[] {
  const p = { ...DEFAULTS, ...policy };
  const entry: RecentManifest = { sig, at: now, files: files.map((f) => ({ hash: f.hash, bytes: f.bytes })) };
  const rest = recent.filter((r) => r.sig !== sig && now - r.at <= p.maxAgeMs).sort((a, b) => b.at - a.at);
  const out: RecentManifest[] = [entry];
  const seen = new Set(entry.files.map((f) => f.hash));
  let bytes = entry.files.reduce((a, f) => a + f.bytes, 0);
  for (const r of rest) {
    if (out.length >= p.maxEntries) break;
    let extra = 0;
    for (const f of r.files) if (!seen.has(f.hash)) extra += f.bytes;
    if (bytes + extra > p.budgetBytes) break;
    bytes += extra;
    for (const f of r.files) seen.add(f.hash);
    out.push(r);
  }
  return out;
}

/** Hashes to keep when pruning: the current manifest plus every remembered manifest. */
export function keepSet(current: readonly CacheFile[], recent: readonly RecentManifest[]): Set<string> {
  const keep = new Set<string>();
  for (const f of current) keep.add(f.hash);
  for (const r of recent) for (const f of r.files) keep.add(f.hash);
  return keep;
}

/** Unique bytes a keep set pins, for diagnostics. */
export function keptBytes(recent: readonly RecentManifest[], current: readonly CacheFile[] = []): number {
  const seen = new Map<string, number>();
  for (const f of current) seen.set(f.hash, f.bytes);
  for (const r of recent) for (const f of r.files) seen.set(f.hash, f.bytes);
  let total = 0;
  for (const b of seen.values()) total += b;
  return total;
}
