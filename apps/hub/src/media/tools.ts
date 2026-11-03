import { spawn } from 'node:child_process';

export type RunResult = { code: number; stdout: string; stderr: string };

export class ToolError extends Error {
  constructor(
    message: string,
    public stderr: string,
  ) {
    super(message);
  }
}

/**
 * Run an external tool without a shell, with a timeout (SIGKILL) and an optional abort signal.
 * Only the last 64 KB of stderr is kept. `onStdout` receives stdout chunks (ffmpeg -progress).
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
  },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let killedFor: string | undefined;
    const kill = (why: string) => {
      if (killedFor) return;
      killedFor = why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => kill(`timed out after ${Math.round(opts.timeoutMs / 1000)} s`), opts.timeoutMs);
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
