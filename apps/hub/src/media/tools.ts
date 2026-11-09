import { spawn } from 'node:child_process';

export type RunResult = { code: number; stdout: string; stderr: string };

export class ToolError extends Error {
  stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

/**
 * Run an external tool without a shell, with a timeout (SIGKILL) and an optional abort signal.
 * Only the last 64 KB of stderr is kept. `onStdout` receives stdout chunks (ffmpeg -progress).
 * With `group`, the tool runs in its own process group and the timeout or abort kills the whole group: a
 * launcher that starts the real process as its child (soffice → oosplash → soffice.bin) leaves nothing
 * behind.
 */
export function run(
  cmd: string,
  args: string[],
  opts: {
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
    keepStdout?: boolean;
    allowFail?: boolean;
    group?: boolean;
  },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...(opts.group ? { detached: true } : {}),
    });
    let stdout = '';
    let stderr = '';
    let killedFor: string | undefined;
    const kill = (why: string) => {
      if (killedFor) return;
      killedFor = why;
      if (opts.group && child.pid !== undefined)
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // the group is gone already: kill the child itself
        }
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => kill(`timed out after ${Math.round(opts.timeoutMs / 1000)} s`),
      opts.timeoutMs,
    );
    const onAbort = () => kill('cancelled');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      opts.onStdout?.(d);
      if (opts.keepStdout !== false) {
        stdout += d;
        if (stdout.length > 16 * 1024 * 1024) stdout = stdout.slice(-8 * 1024 * 1024);
      }
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
      if (stderr.length > 128 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(new ToolError(`${cmd}: ${e.message}`, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      // A helper the tool left running in its group goes with it.
      if (opts.group && child.pid !== undefined)
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // nothing left
        }
      if (killedFor) return reject(new ToolError(`${cmd} ${killedFor}`, stderr));
      const r = { code: code ?? -1, stdout, stderr };
      if (code !== 0 && !opts.allowFail) {
        const tail = stderr.trim().split('\n').slice(-3).join(' | ');
        return reject(new ToolError(`${cmd} exited with ${code}: ${tail}`, stderr));
      }
      resolve(r);
    });
  });
}
