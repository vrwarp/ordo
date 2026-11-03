import { Writable } from 'node:stream';
import pino, { type Logger } from 'pino';

/** Keeps the last N log lines in memory for the diagnostics export. */
export class LogRing extends Writable {
  private lines: string[] = [];
  constructor(private max = 2000) {
    super();
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: () => void): void {
    const s = chunk.toString();
    for (const line of s.split('\n')) {
      if (!line) continue;
      this.lines.push(line);
    }
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    cb();
  }
  snapshot(): string[] {
    return this.lines.slice();
  }
}

/** Strip output tokens and other secrets from a URL before it is logged. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|pin)=)[^&#]*/gi, '$1[redacted]');
}

export function createLogger(opts: { level: string; stdout: boolean; ring: LogRing }): Logger {
  const streams: pino.StreamEntry[] = [{ level: 'trace', stream: opts.ring }];
  if (opts.stdout) streams.push({ level: 'trace', stream: process.stdout });
  return pino(
    {
      level: opts.level,
      base: { svc: 'ordo-hub' },
      redact: {
        paths: [
          'req.headers.cookie',
          'req.headers["x-ordo-token"]',
          'req.headers.authorization',
          'pin',
          'token',
          '*.pin',
          '*.token',
        ],
        censor: '[redacted]',
      },
      serializers: {
        req: (req: { method?: string; url?: string; ip?: string; hostname?: string }) => ({
          method: req.method,
          url: redactUrl(req.url ?? ''),
          host: req.hostname,
          ip: req.ip,
        }),
      },
    },
    pino.multistream(streams),
  );
}
