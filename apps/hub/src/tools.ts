/**
 * The server tools the hub may use and what they allow (design/27 M9 "LibreOffice optional"; lo-dependencies
 * §4.2). LibreOffice is optional: ordo draws PowerPoint slides itself, and LibreOffice only adds 'Pictures
 * (LibreOffice)', LibreOffice reference pictures and the art of what ordo cannot draw (`pptx-lo`). pdftoppm
 * (poppler-utils) draws PDF pages: the PDF import and reference pictures from PowerPoint's own PDF export.
 *
 * - `findOnPath` looks for an executable regular file on the PATH (absolute entries only, never the working
 *   directory) without starting a process.
 * - `HubTools` (one per library process, owned by `ImportService`, given to every pptx job as
 *   `PptxDeps.tools`): at start it looks each tool up, then asks its version in the background (LibreOffice
 *   through the same hardened command as its conversions, `sofficeCommand`, 30 s). `ready` settles once both
 *   answered; jobs and routes that need a tool await it. `ORDO_LIBREOFFICE=off` probes nothing and no office
 *   code ever runs. A run that finds a tool gone (`ToolError.missing`) marks it absent (`markMissing`), so the
 *   capabilities change without a restart. A probe that times out (a slow cold start) or fails leaves
 *   LibreOffice 'broken', which is not 'absent': the jobs that need it probe again (`recheck`, at most once
 *   per `RECHECK_MS`) and defer while it stays broken, and the routes answer 503 with a retry hint, as they
 *   do while it is still 'checking'. Only 'absent' and 'off' mean no LibreOffice.
 * - Nothing here ever runs soffice unless its state is 'available' (the jobs check `has`), the probes aside.
 *
 * One log line per tool at start: `libreoffice: available (LibreOffice 24.2.7.2)`, or `libreoffice: absent: ordo
 * draws PowerPoint slides itself; …`.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { HubCapabilities } from '@ordo/protocol';
import type { HubConfig } from './config.ts';
import { errorMessage } from './errors.ts';
import { run, ToolError } from './media/tools.ts';
import { SOFFICE_ADDRESS_SPACE_MB, sofficeCommand } from './pptx/fallback.ts';
import { logSafe } from './pptx/report.ts';

export type ToolName = 'libreoffice' | 'pdftoppm';
export type ToolState = 'checking' | 'available' | 'absent' | 'off' | 'broken';
export type ToolInfo = {
  state: ToolState;
  /** The command that runs it (an absolute path once found). */
  exe?: string;
  /** Its version ('24.2.7.2'), when it said. */
  version?: string;
  /** Why it is not available (one line, sanitised). */
  reason?: string;
};

/**
 * Tests only (`HubConfig.toolProbe`): a tool's state, decided without the PATH or a process. `pdfinfo` (with
 * pdftoppm) defaults to the pdftoppm state.
 */
export type ToolProbe = (tool: ToolName | 'pdfinfo') => ToolInfo | Promise<ToolInfo>;

/** How long a version command may take (LibreOffice starts in about 2 s here, minutes on a slow NAS never). */
export const TOOL_PROBE_MS = 30_000;
/** The least time between two probes of a broken LibreOffice (`HubTools.recheck`). */
export const RECHECK_MS = 60_000;

/** What the start-up line says LibreOffice's absence turns off. */
const WITHOUT_LIBREOFFICE =
  "ordo draws PowerPoint slides itself; 'Pictures (LibreOffice)' and LibreOffice reference pictures are off";
const WITHOUT_PDFTOPPM = 'PDF import and PDF reference pictures are off (install poppler-utils)';

/** An executable regular file of that name on `path` (or the absolute path itself); no process is started. */
export function findOnPath(cmd: string, path = process.env.PATH ?? ''): string | undefined {
  if (!cmd || cmd.includes('\0') || cmd.length > 4096) return undefined;
  if (cmd.includes('/')) return isAbsolute(cmd) && executableFile(cmd) ? cmd : undefined;
  for (const dir of path.split(delimiter)) {
    // An empty or relative entry would be the working directory: never searched.
    if (!dir || !isAbsolute(dir)) continue;
    const p = join(dir, cmd);
    if (executableFile(p)) return p;
  }
  return undefined;
}

function executableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The last lines of a tool's stderr, as one sanitised line. */
function tail(stderr: string): string {
  return logSafe(stderr.trim().split('\n').slice(-3).join(' | '), 300);
}

type Log = { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };

export class HubTools {
  /** Settles once every probe answered (each within `TOOL_PROBE_MS`); never rejects. */
  readonly ready: Promise<void>;
  private lo: ToolInfo;
  private pdf: ToolInfo;
  private pdfinfo = false;
  /** Tools whose loss a run already logged (`markMissing`). */
  private readonly lost = new Set<ToolName>();
  /** The probe `recheck` runs, while it runs. */
  private rechecking: Promise<void> | undefined;
  /** When `recheck` last probed (ms since the epoch). */
  private recheckedAt = 0;

  private readonly cfg: Pick<HubConfig, 'libreoffice' | 'toolProbe'>;
  private readonly log: Log;
  private readonly opts: { tmpDir?: () => Promise<string>; probeMs?: number; recheckMs?: number };

  constructor(
    cfg: Pick<HubConfig, 'libreoffice' | 'toolProbe'>,
    log: Log,
    opts: { tmpDir?: () => Promise<string>; probeMs?: number; recheckMs?: number } = {},
  ) {
    this.cfg = cfg;
    this.log = log;
    this.opts = opts;
    const off = cfg.libreoffice.mode === 'off';
    this.lo = off ? { state: 'off', reason: 'ORDO_LIBREOFFICE=off' } : { state: 'checking' };
    this.pdf = { state: 'checking' };
    if (cfg.libreoffice.warning) log.warn({}, logSafe(cfg.libreoffice.warning, 300));
    this.ready = Promise.all([
      off ? Promise.resolve() : this.settle('libreoffice', () => this.probeLibreOffice()),
      this.settle('pdftoppm', () => this.probePdftoppm()),
    ]).then(() => {
      this.announce('libreoffice', this.lo);
      this.announce('pdftoppm', this.pdf);
    });
  }

  /** A detector with these states and no probing (tests that build `PptxDeps` by hand). */
  static fixed(
    states: { libreoffice?: ToolState; pdftoppm?: ToolState; pdfinfo?: boolean; exe?: string } = {},
  ): HubTools {
    const t = new HubTools(
      {
        libreoffice: { mode: states.libreoffice === 'off' ? 'off' : 'auto', exe: states.exe ?? 'soffice' },
        toolProbe: (tool) =>
          tool === 'libreoffice'
            ? { state: states.libreoffice ?? 'available', exe: states.exe ?? 'soffice' }
            : tool === 'pdfinfo'
              ? { state: (states.pdfinfo ?? true) ? 'available' : 'absent' }
              : { state: states.pdftoppm ?? 'available', exe: 'pdftoppm' },
      },
      { info: () => undefined, warn: () => undefined },
    );
    return t;
  }

  /**
   * `ready`, or `ms` at most (a route answers within that even while a slow LibreOffice still starts); the
   * states are then whatever is known, 'checking' for a probe still running.
   */
  async settled(ms = 5_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.ready,
      new Promise<void>((r) => {
        timer = setTimeout(r, ms);
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
  }

  libreoffice(): ToolInfo {
    return { ...this.lo };
  }

  pdftoppm(): ToolInfo {
    return { ...this.pdf };
  }

  /** Whether the tool can be used now (its state is 'available'). False while it is still being checked. */
  has(t: ToolName | 'pdfinfo'): boolean {
    if (t === 'pdfinfo') return this.pdf.state === 'available' && this.pdfinfo;
    return (t === 'libreoffice' ? this.lo : this.pdf).state === 'available';
  }

  /**
   * LibreOffice's state once `ready`, probed again first when it is 'broken' (a start-up probe that timed out
   * on a slow cold start, a version command that failed once): one probe at a time, at most once per
   * `RECHECK_MS` (callers in between share the last answer), each within `TOOL_PROBE_MS`. A probe that
   * answers makes it 'available' (logged), so a hub recovers without a restart. Any other state is returned as
   * it is: 'absent' and 'off' are not probed again (a restart finds a newly installed LibreOffice).
   */
  async recheck(): Promise<ToolState> {
    await this.ready;
    if (this.lo.state !== 'broken') return this.lo.state;
    const now = Date.now();
    if (!this.rechecking && now - this.recheckedAt >= (this.opts.recheckMs ?? RECHECK_MS)) {
      this.recheckedAt = now;
      this.rechecking = this.settle('libreoffice', () => this.probeLibreOffice()).then(() => {
        this.rechecking = undefined;
        if (this.lo.state !== 'broken') this.announce('libreoffice', this.lo);
      });
    }
    await this.rechecking;
    return this.lo.state;
  }

  /**
   * A run found the tool gone (`ToolError.missing`, an image swapped under a running hub): it is absent from
   * now on, logged once, and the capabilities say so.
   */
  markMissing(t: ToolName, reason: string): void {
    const why = logSafe(reason, 300);
    if (t === 'libreoffice') this.lo = { state: 'absent', reason: why };
    else {
      this.pdf = { state: 'absent', reason: why };
      this.pdfinfo = false;
    }
    if (this.lost.has(t)) return;
    this.lost.add(t);
    this.log.warn(
      { tool: t, reason: why },
      `${t}: gone (${why}): ${t === 'libreoffice' ? WITHOUT_LIBREOFFICE : WITHOUT_PDFTOPPM}`,
    );
  }

  /** What the operator may offer (`GET /capabilities`). */
  capabilities(): HubCapabilities {
    const lo = this.has('libreoffice');
    const pdf = this.has('pdftoppm');
    return {
      libreoffice: { state: this.lo.state, ...(this.lo.version ? { version: this.lo.version } : {}) },
      pdf,
      documents: ['pptx', 'ppsx', 'potx', 'pptm', ...(pdf ? ['pdf'] : [])],
      pptx: { pictures: lo, reference: lo, referencePdf: this.has('pdfinfo'), art: lo },
    };
  }

  /** Run a probe; whatever it throws is 'broken' with the message. */
  private async settle(t: ToolName, probe: () => Promise<void>): Promise<void> {
    try {
      await probe();
    } catch (e) {
      const info: ToolInfo = { state: 'broken', reason: logSafe(errorMessage(e), 300) };
      if (t === 'libreoffice') this.lo = info;
      else this.pdf = info;
    }
  }

  private announce(t: ToolName, info: ToolInfo): void {
    const what = t === 'libreoffice' ? WITHOUT_LIBREOFFICE : WITHOUT_PDFTOPPM;
    const fields = { tool: t, state: info.state, ...(info.version ? { version: info.version } : {}) };
    if (info.state === 'available') {
      const v = info.version ? ` (${t === 'libreoffice' ? 'LibreOffice ' : ''}${info.version})` : '';
      this.log.info(fields, `${t}: available${v}`);
    } else if (info.state === 'broken')
      this.log.warn(
        { ...fields, reason: info.reason },
        `${t}: broken (${info.reason ?? 'unknown'}): ${what}`,
      );
    else this.log.info(fields, `${t}: ${info.state}${info.reason ? ` (${info.reason})` : ''}: ${what}`);
  }

  private async probeLibreOffice(): Promise<void> {
    const c = this.cfg.libreoffice;
    if (this.cfg.toolProbe) {
      this.lo = { exe: c.exe, ...(await this.cfg.toolProbe('libreoffice')) };
      return;
    }
    // auto: soffice, else the Debian alias; an absolute path is used as it is.
    const exe = findOnPath(c.exe) ?? (c.exe === 'soffice' ? findOnPath('libreoffice') : undefined);
    if (!exe) {
      this.lo = { state: 'absent', reason: `${logSafe(c.exe, 200)} is not installed` };
      return;
    }
    const home = await (this.opts.tmpDir?.() ?? mkdtemp(join(tmpdir(), 'ordo-lo-probe-')));
    try {
      const cmd = await sofficeCommand(['--version'], home, SOFFICE_ADDRESS_SPACE_MB, exe);
      const r = await run(cmd.cmd, cmd.args, {
        timeoutMs: this.opts.probeMs ?? TOOL_PROBE_MS,
        env: cmd.env,
        group: true,
      });
      const version = /LibreOffice (\d+(?:\.\d+){1,5})/.exec(r.stdout)?.[1];
      this.lo = { state: 'available', exe, ...(version ? { version } : {}) };
    } catch (e) {
      if (e instanceof ToolError && e.missing)
        this.lo = { state: 'absent', reason: logSafe(errorMessage(e), 300) };
      else {
        const stderr = e instanceof ToolError ? tail(e.stderr) : '';
        this.lo = {
          state: 'broken',
          exe,
          reason:
            logSafe(errorMessage(e), 200) +
            (stderr && !errorMessage(e).includes(stderr) ? `: ${stderr}` : ''),
        };
      }
    } finally {
      await rm(home, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async probePdftoppm(): Promise<void> {
    if (this.cfg.toolProbe) {
      this.pdf = { exe: 'pdftoppm', ...(await this.cfg.toolProbe('pdftoppm')) };
      this.pdfinfo = (await this.cfg.toolProbe('pdfinfo')).state === 'available';
      return;
    }
    const exe = findOnPath('pdftoppm');
    if (!exe) {
      this.pdf = { state: 'absent', reason: 'pdftoppm is not installed' };
      return;
    }
    this.pdfinfo = !!findOnPath('pdfinfo');
    try {
      // `-v` prints the version on stderr; some builds exit 99 after it.
      const r = await run(exe, ['-v'], { timeoutMs: this.opts.probeMs ?? TOOL_PROBE_MS, allowFail: true });
      const version = /pdftoppm version (\d+(?:\.\d+){1,5})/.exec(`${r.stderr}\n${r.stdout}`)?.[1];
      this.pdf = { state: 'available', exe, ...(version ? { version } : {}) };
    } catch (e) {
      this.pdf =
        e instanceof ToolError && e.missing
          ? { state: 'absent', reason: logSafe(errorMessage(e), 300) }
          : { state: 'broken', exe, reason: logSafe(errorMessage(e), 300) };
    }
  }
}
