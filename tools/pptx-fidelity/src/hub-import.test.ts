import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type DeckRecord,
  hubImportGates,
  type HubImportReport,
  hubLibreOffice,
  officeSpawn,
  parseHubImportArgs,
  runHubImport,
  toolsOnlyPath,
} from './hub-import.ts';

const dir = mkdtempSync(join(tmpdir(), 'ordo-hub-import-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('hub-import', () => {
  it('--dry-run lists E and skips dangling links as unreadable', async () => {
    const e = join(dir, 'shard');
    mkdirSync(join(e, 'sub'), { recursive: true });
    for (const f of ['a.pptx', 'sub/b.ppsx', 'c.potx', 'd.pptm']) writeFileSync(join(e, f), 'PK');
    writeFileSync(join(e, 'notes.txt'), 'not a deck');
    symlinkSync(join(dir, 'gone.pptx'), join(e, 'gone.pptx'));
    const sermons = join(dir, 'sermons');
    mkdirSync(sermons);
    writeFileSync(join(sermons, 'Private Sermon Name.pptx'), 'PK');
    const out = join(dir, 'out');
    const r = await runHubImport(['--dry-run', '--out', out, '--sermons', sermons, e]);
    expect(r.dryRun).toBe(true);
    expect(r.decks.map((d) => [d.name, d.ext])).toEqual([
      ['a.pptx', 'pptx'],
      ['c.potx', 'potx'],
      ['d.pptm', 'pptm'],
      ['sub__b.ppsx', 'ppsx'],
      ['sermon-1', 'pptx'],
    ]);
    expect(r.decks.at(-1)!.sermon).toBe(true);
    expect(r.unreadable).toEqual([{ name: 'gone.pptx', why: 'missing target' }]);
    // No hub was started, and a private deck's name is in no file the run wrote.
    expect(r.hub).toBeUndefined();
    for (const f of readdirSync(out))
      expect(readFileSync(join(out, f), 'utf8')).not.toContain('Private Sermon');
    expect(JSON.parse(readFileSync(join(out, 'hub-import.json'), 'utf8')).decks).toHaveLength(5);
  });

  it("gives the hub a PATH of links to the lite tools only, never LibreOffice's", async () => {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    for (const t of ['ffmpeg', 'soffice', 'libreoffice', 'pdftoppm'])
      writeFileSync(join(bin, t), '#!/bin/sh\n', { mode: 0o755 });
    const p = await toolsOnlyPath(join(dir, 'path'), undefined, bin);
    expect(readdirSync(p.path).sort()).toEqual(['ffmpeg', 'node', 'pdftoppm']);
    expect(readlinkSync(join(p.path, 'ffmpeg'))).toBe(join(bin, 'ffmpeg'));
    expect(readlinkSync(join(p.path, 'node'))).toBe(process.execPath);
    expect(p.missing).toEqual(['ffprobe', 'pdfinfo', 'prlimit']);
  });

  it('parses its options and refuses unknown ones', () => {
    expect(parseHubImportArgs(['--libreoffice', '--timeout-s', '30', 'x'])).toMatchObject({
      libreoffice: true,
      timeoutMs: 30_000,
      decks: ['x'],
    });
    expect(parseHubImportArgs(['--client-scene', 'x'])).toMatchObject({ clientScene: true, equivalence: false });
    expect(parseHubImportArgs(['--equivalence', 'x'])).toMatchObject({ clientScene: true, equivalence: true });
    expect(hubLibreOffice({ libreoffice: { state: 'absent' } })).toBe(false);
    expect(hubLibreOffice({ libreoffice: { state: 'available' } })).toBe(true);
    expect(hubLibreOffice(undefined)).toBe(true);
    expect(() => parseHubImportArgs(['--hub', 'docker'])).toThrow(/dist or source/);
    expect(() => parseHubImportArgs(['--frobnicate'])).toThrow(/unknown option/);
  });

  it('finds LibreOffice runs in the log and holds the run to the §6.3 gates', () => {
    expect(officeSpawn('{"msg":"soffice: spawn soffice ENOENT"}')).toBe(true);
    expect(officeSpawn('unshare: failed to execute soffice: No such file or directory')).toBe(true);
    expect(officeSpawn('{"msg":"LibreOffice: absent","tool":"libreoffice"}')).toBe(false);
    const deck = (over: Partial<DeckRecord>): DeckRecord => ({
      name: 'd',
      ext: 'pptx',
      bytes: 1,
      state: 'done',
      v1Ms: 100,
      classes: { native: 3, hybrid: 1, picture: 0 },
      pending: 0,
      slidesOver64k: 0,
      presentationBytes: 1000,
      manifest: { files: 2, unresolved: 0, degraded: 0 },
      ...over,
    });
    const report = (
      decks: DeckRecord[],
      caps: unknown = { libreoffice: { state: 'absent' } },
    ): HubImportReport => ({
      createdAt: '',
      dryRun: false,
      libreoffice: 'hidden',
      capabilities: caps,
      decks,
      unreadable: [],
      rssMaxMb: 900,
      officeLines: [],
    });
    expect(
      hubImportGates(report([deck({}), deck({ sermon: true, v1Ms: 4000 })]), 4096).every((g) => g.pass),
    ).toBe(true);
    const failed = hubImportGates(
      report(
        [
          deck({ pending: 2, classes: { native: 1, hybrid: 0, picture: 1 } }),
          deck({ sermon: true, v1Ms: 6000 }),
        ],
        null,
      ),
      4096,
    )
      .filter((g) => !g.pass)
      .map((g) => g.name);
    expect(failed).toEqual([
      'GET /capabilities reports LibreOffice absent',
      'pending is 0',
      'no picture slide',
      'sermon decks reach version 1 within 5 s',
    ]);
  });
});
