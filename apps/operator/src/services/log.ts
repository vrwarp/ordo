/** Ring buffer of the operator window's own log lines, for the diagnostics panel and export. */
export type LogLine = { at: number; level: 'info' | 'warn' | 'error'; text: string };

const lines: LogLine[] = [];
const listeners = new Set<() => void>();

export function log(level: LogLine['level'], text: string): void {
  lines.push({ at: Date.now(), level, text: text.slice(0, 500) });
  if (lines.length > 500) lines.splice(0, lines.length - 500);
  for (const l of listeners) l();
}

export function logLines(): LogLine[] {
  return lines;
}

export function onLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function installGlobalErrorLog(): void {
  window.addEventListener('error', (e) => log('error', `${e.message} at ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log('error', `unhandled: ${String(e.reason)}`));
}
