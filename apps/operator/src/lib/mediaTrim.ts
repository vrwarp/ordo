import type { Media } from '@ordo/domain';

/** Whether a media item supports non-destructive Hub trimming. */
export function canTrimMedia(m: Pick<Media, 'kind' | 'original'>): boolean {
  return (m.kind === 'video' || m.kind === 'audio') && m.original.mime !== 'image/gif';
}

/** Format milliseconds as `m:ss.s` (or `h:mm:ss.s` when >= 1 hour). */
export function formatTrimMs(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const tenths = Math.floor((clamped % 1000) / 100);
  const totalS = Math.floor(clamped / 1000);
  const s = totalS % 60;
  const m = Math.floor(totalS / 60) % 60;
  const h = Math.floor(totalS / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}.${tenths}`;
  return `${m}:${ss}.${tenths}`;
}

/** Parse `ss`, `ss.s`, `mm:ss`, `mm:ss.s`, or `hh:mm:ss.s` into whole milliseconds. */
export function parseTrimMs(raw: string): number | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const parts = s.split(':');
  if (parts.length > 3) return undefined;
  let totalSec = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!.trim();
    if (!/^\d+(?:\.\d+)?$/.test(p)) return undefined;
    const n = Number(p);
    if (!Number.isFinite(n)) return undefined;
    if (i > 0 && n >= 60) return undefined;
    totalSec = totalSec * 60 + n;
  }
  return Math.round(totalSec * 1000);
}
