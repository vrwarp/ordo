/**
 * The hub's server tools (design/27 M9 "LibreOffice optional", `tools.ts`): finding them on the PATH without
 * starting anything, `ORDO_LIBREOFFICE`, the version probe through the hardened soffice command, and the
 * `ToolError.missing` that turns a vanished tool into 'absent'. Fake tools are tiny shell scripts in a temp dir.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { libreofficeConfig, loadConfig } from '../src/config.ts';
import { run, ToolError } from '../src/media/tools.ts';
import { sofficeCommand, sofficeToPdf } from '../src/pptx/fallback.ts';
import { findOnPath, HubTools } from '../src/tools.ts';
import { tempDir } from './helpers.ts';

let dir: string;
beforeAll(() => {
  dir = tempDir('ordo-tools-');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A shell script at `<dir>/<sub>/<name>`, executable unless `mode` says otherwise. */
function script(sub: string, name: string, body: string, mode = 0o755): string {
  const d = join(dir, sub);
  mkdirSync(d, { recursive: true });
  const p = join(d, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, mode);
  return p;
}

/** A logger that keeps its lines. */
function lines() {
  const out: { level: 'info' | 'warn'; obj: object; msg: string }[] = [];
  return {
    out,
    log: {
      info: (obj: object, msg: string) => out.push({ level: 'info', obj, msg }),
      warn: (obj: object, msg: string) => out.push({ level: 'warn', obj, msg }),
    },
  };
}

describe('the server tools (design/27 M9)', () => {
  it('findOnPath finds an executable file and skips folders and non-executables', () => {
    // A folder of that name first, then a file that is not executable, then the real one.
    mkdirSync(join(dir, 'a', 'soffice'), { recursive: true });
    script('b', 'soffice', 'exit 0', 0o644);
    const real = script('c', 'soffice', 'exit 0');
    const path = ['', 'relative/bin', join(dir, 'a'), join(dir, 'b'), join(dir, 'c')].join(':');
    expect(findOnPath('soffice', path)).toBe(real);
    // Only absolute PATH entries: an empty or relative one (the working directory) is never searched.
    expect(findOnPath('soffice', ['', '.', 'c'].join(':'))).toBeUndefined();
    expect(findOnPath('soffice', join(dir, 'b'))).toBeUndefined();
    expect(findOnPath('soffice', join(dir, 'a'))).toBeUndefined();
    // An absolute command is checked as it is; a relative one with a slash never.
    expect(findOnPath(real, '')).toBe(real);
    expect(findOnPath(join(dir, 'b', 'soffice'), '')).toBeUndefined();
    expect(findOnPath('c/soffice', dir)).toBeUndefined();
    expect(findOnPath('', path)).toBeUndefined();
    expect(findOnPath('sof\0fice', path)).toBeUndefined();
  });

  it('ORDO_LIBREOFFICE=off reports off and starts no process', async () => {
    for (const v of ['off', 'OFF', '0', 'false', 'no'])
      expect(libreofficeConfig(v)).toEqual({ mode: 'off', exe: '' });
    expect(libreofficeConfig(undefined)).toEqual({ mode: 'auto', exe: 'soffice' });
    expect(libreofficeConfig(' auto ')).toEqual({ mode: 'auto', exe: 'soffice' });
    expect(libreofficeConfig('/opt/libreoffice/program/soffice')).toEqual({
      mode: 'auto',
      exe: '/opt/libreoffice/program/soffice',
    });
    const odd = libreofficeConfig('soffice --headless');
    expect(odd).toMatchObject({ mode: 'auto', exe: 'soffice' });
    expect(odd.warning).toMatch(/neither auto, off nor an absolute path/);
    expect(loadConfig({ ORDO_LIBREOFFICE: 'off' }).libreoffice).toEqual({ mode: 'off', exe: '' });

    // A soffice that records it ran, first on the PATH: never started.
    const marker = join(dir, 'off-ran');
    const bin = join(dir, 'off-bin');
    script('off-bin', 'soffice', `echo ran >> '${marker}'\necho 'LibreOffice 7.4.7.2'`);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const l = lines();
      const tools = new HubTools(loadConfig({ ORDO_LIBREOFFICE: 'off' }), l.log);
      expect(tools.libreoffice().state).toBe('off');
      await tools.ready;
      expect(tools.libreoffice()).toMatchObject({ state: 'off' });
      expect(tools.has('libreoffice')).toBe(false);
      expect(tools.capabilities()).toMatchObject({
        libreoffice: { state: 'off' },
        pptx: { pictures: false, reference: false, art: false },
      });
      expect(l.out.some((x) => /^libreoffice: off .*ordo draws PowerPoint slides itself/.test(x.msg))).toBe(
        true,
      );
      // A run that would need it refuses without starting anything.
      await expect(
        sofficeToPdf(join(dir, 'x.pptx'), dir, {
          timeoutMs: 5_000,
          signal: new AbortController().signal,
          exe: tools.has('libreoffice') ? (tools.libreoffice().exe ?? '') : '',
        }),
      ).rejects.toMatchObject({ missing: true });
      expect(existsSync(marker)).toBe(false);
    } finally {
      process.env.PATH = path;
    }
  });

  it('an absolute ORDO_LIBREOFFICE path is the command sofficeCommand runs', async () => {
    // A soffice outside the PATH that answers --version and "converts" by writing the PDF it was asked for.
    const record = join(dir, 'abs-args');
    const exe = script(
      'opt/libreoffice/program',
      'soffice',
      [
        `echo "$@" >> '${record}'`,
        'if [ "$1" = "--version" ]; then echo "LibreOffice 7.6.4.1 60(Build:1)"; exit 0; fi',
        'out=""; prev=""; last=""',
        'for a in "$@"; do if [ "$prev" = "--outdir" ]; then out="$a"; fi; prev="$a"; last="$a"; done',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell parameter expansion, not a template
        'b=$(basename "$last"); b="${b%.*}"; printf "%%PDF-1.4" > "$out/$b.pdf"',
      ].join('\n'),
    );
    const cfg = loadConfig({ ORDO_LIBREOFFICE: exe });
    expect(cfg.libreoffice).toEqual({ mode: 'auto', exe });
    const tools = new HubTools(cfg, lines().log);
    await tools.ready;
    expect(tools.libreoffice()).toMatchObject({ state: 'available', exe, version: '7.6.4.1' });
    const c = await sofficeCommand(['--version'], dir, 1024, tools.libreoffice().exe);
    expect([c.cmd, ...c.args]).toContain(exe);
    expect([c.cmd, ...c.args]).not.toContain('soffice');
    // The conversion runs that same command.
    const out = join(dir, 'abs-out');
    mkdirSync(out, { recursive: true });
    const pdf = await sofficeToPdf(join(dir, 'Deck.pptx'), out, {
      timeoutMs: 30_000,
      signal: new AbortController().signal,
      exe: tools.libreoffice().exe!,
    });
    expect(pdf).toBe(join(out, 'Deck.pdf'));
    const ran = readFileSync(record, 'utf8');
    expect(ran).toMatch(/^--version$/m);
    expect(ran).toMatch(/--convert-to pdf --outdir/);
  });

  it('a fake soffice printing a version is available with that version', async () => {
    script('ver-bin', 'soffice', 'echo "LibreOffice 7.4.7.2 40(Build:2)"');
    const path = process.env.PATH;
    process.env.PATH = `${join(dir, 'ver-bin')}:${path}`;
    try {
      const l = lines();
      const tools = new HubTools(loadConfig({}), l.log);
      expect(tools.libreoffice().state).toBe('checking');
      expect(tools.has('libreoffice')).toBe(false);
      await tools.ready;
      expect(tools.libreoffice()).toMatchObject({
        state: 'available',
        exe: join(dir, 'ver-bin', 'soffice'),
        version: '7.4.7.2',
      });
      expect(tools.has('libreoffice')).toBe(true);
      expect(tools.capabilities()).toMatchObject({
        libreoffice: { state: 'available', version: '7.4.7.2' },
        pptx: { pictures: true, reference: true, art: true },
      });
      expect(l.out.map((x) => x.msg)).toContain('libreoffice: available (LibreOffice 7.4.7.2)');
      // A run that finds it gone marks it absent, once.
      tools.markMissing('libreoffice', 'soffice: spawn soffice ENOENT');
      tools.markMissing('libreoffice', 'again');
      expect(tools.libreoffice().state).toBe('absent');
      expect(tools.capabilities().pptx.art).toBe(false);
      expect(l.out.filter((x) => /^libreoffice: gone/.test(x.msg))).toHaveLength(1);
    } finally {
      process.env.PATH = path;
    }
  });

  it('a soffice that exits 1 is broken', async () => {
    const exe = script('broken', 'soffice', 'echo "javaldx: could not find a Java Runtime" >&2\nexit 1');
    const l = lines();
    const tools = new HubTools({ libreoffice: { mode: 'auto', exe } }, l.log);
    await tools.ready;
    const lo = tools.libreoffice();
    expect(lo.state).toBe('broken');
    expect(lo.reason).toMatch(/exited with 1/);
    expect(lo.reason).toMatch(/could not find a Java Runtime/);
    expect(tools.has('libreoffice')).toBe(false);
    expect(l.out.find((x) => x.msg.startsWith('libreoffice: broken'))?.level).toBe('warn');
    // Not installed at all (auto, nothing on the PATH by that name): absent.
    const none = new HubTools({ libreoffice: { mode: 'auto', exe: join(dir, 'nowhere', 'soffice') } }, l.log);
    await none.ready;
    expect(none.libreoffice()).toMatchObject({ state: 'absent' });
    expect(none.capabilities().libreoffice).toEqual({ state: 'absent' });
  });

  it("spawn ENOENT and prlimit's exit 127 are ToolError.missing", async () => {
    const gone = join(dir, 'nowhere', 'soffice');
    const e1 = await run(gone, ['--version'], { timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ToolError);
    expect((e1 as ToolError).missing).toBe(true);
    // Not executable: EACCES.
    const flat = script('flat', 'soffice', 'exit 0', 0o644);
    expect(await run(flat, [], { timeoutMs: 5_000 }).catch((e: ToolError) => e.missing)).toBe(true);
    // A launcher that cannot execute its program (the hardened soffice command: prlimit, unshare).
    if (findOnPath('prlimit')) {
      const e2 = await run('prlimit', ['--as=2147483648', '--', gone], { timeoutMs: 5_000 }).catch(
        (e: unknown) => e,
      );
      expect(e2).toBeInstanceOf(ToolError);
      expect((e2 as ToolError).message).toMatch(/exited with 12[67]/);
      expect((e2 as ToolError).missing).toBe(true);
    }
    const c = await sofficeCommand(['--version'], dir, 1024, gone);
    const e3 = await run(c.cmd, c.args, { timeoutMs: 10_000, env: c.env }).catch((e: unknown) => e);
    expect((e3 as ToolError).missing).toBe(true);
    // An ordinary failure is not.
    const e4 = await run('sh', ['-c', 'echo boom >&2; exit 127'], { timeoutMs: 5_000 }).catch(
      (e: unknown) => e,
    );
    expect((e4 as ToolError).missing).toBe(false);
    const e5 = await run('sh', ['-c', 'exit 1'], { timeoutMs: 5_000 }).catch((e: unknown) => e);
    expect((e5 as ToolError).missing).toBe(false);
  });
});

describe('pdftoppm and the capabilities (design/27 M9)', () => {
  it('reports PDF import and PDF reference pictures by poppler-utils', async () => {
    const t = HubTools.fixed({ libreoffice: 'absent', pdftoppm: 'available', pdfinfo: true });
    await t.ready;
    expect(t.capabilities()).toEqual({
      libreoffice: { state: 'absent' },
      pdf: true,
      documents: ['pptx', 'ppsx', 'potx', 'pptm', 'pdf'],
      pptx: { pictures: false, reference: false, referencePdf: true, art: false },
    });
    const none = HubTools.fixed({ libreoffice: 'available', pdftoppm: 'absent' });
    await none.ready;
    expect(none.capabilities()).toMatchObject({
      pdf: false,
      documents: ['pptx', 'ppsx', 'potx', 'pptm'],
      pptx: { pictures: true, referencePdf: false, art: true },
    });
    none.markMissing('pdftoppm', 'gone');
    expect(none.has('pdftoppm')).toBe(false);
    if (findOnPath('pdftoppm')) {
      const real = new HubTools({ libreoffice: { mode: 'off', exe: '' } }, lines().log);
      await real.ready;
      expect(real.pdftoppm()).toMatchObject({ state: 'available' });
      expect(real.pdftoppm().version).toMatch(/^\d+\.\d+/);
    }
  });
});
