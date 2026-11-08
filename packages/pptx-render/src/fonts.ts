import { spawn } from 'node:child_process';

/**
 * The installed family fontconfig substitutes for each typeface that is not installed, as LibreOffice
 * does. Chromium instead falls back to its default (serif) font for an unknown family, so the page names
 * the substitute explicitly. Typefaces that are installed, and every typeface when `fc-match` is missing,
 * are left out (the page then falls back to the generic sans-serif family). `signal` stops the lookups
 * (the one running is killed) and rejects with its reason.
 */
export async function fontFallbacks(
  families: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  // No prototype: a typeface may be called anything, "__proto__" included.
  const out: Record<string, string> = Object.create(null);
  for (const f of families.slice(0, 200)) {
    signal?.throwIfAborted();
    const got = await fcMatch(f, Math.min(timeoutMs, 10_000), signal);
    if (got && got.toLowerCase() !== f.toLowerCase()) out[f] = got;
  }
  signal?.throwIfAborted();
  return out;
}

function fcMatch(family: string, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    // The pattern is one argv element (no shell); fontconfig parses `-`, `:` and `,` in it, so escape them.
    const pattern = family.replace(/[\\\-:,]/g, (c) => `\\${c}`);
    let out = '';
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve(v);
    };
    const p = spawn('fc-match', ['-f', '%{family[0]}', pattern], { stdio: ['ignore', 'pipe', 'ignore'] });
    const kill = () => {
      p.kill('SIGKILL');
      finish(undefined);
    };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    p.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    p.on('error', () => finish(undefined));
    p.on('close', (code) => finish(code === 0 && out.trim() ? out.trim() : undefined));
  });
}
