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
  bundledFontsSettled,
  type DeckRecord,
  equivalenceOf,
  hubEntry,
  hubImportGates,
  hubImportMarkdown,
  type HubImportReport,
  hubLibreOffice,
  officeSpawn,
  parseHubImportArgs,
  runHubImport,
  SCRIPT_FACE_REASON,
  sceneNeedsScripts,
  sceneRefusalOf,
  systemOnlyScriptsOf,
  toolsOnlyPath,
  waitForBundledFonts,
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

  it('starts the sources unless the bundle is asked for, even where a built bundle exists (sub-wave 1c)', () => {
    const at = join(dir, 'checkout');
    mkdirSync(join(at, 'apps/hub/dist'), { recursive: true });
    mkdirSync(join(at, 'apps/hub/src'), { recursive: true });
    writeFileSync(join(at, 'apps/hub/dist/main.js'), '// a stale build\n');
    writeFileSync(join(at, 'apps/hub/src/main.ts'), '// the sources\n');
    expect(hubEntry(undefined, at)).toBe(join(at, 'apps/hub/src/main.ts'));
    expect(hubEntry('source', at)).toBe(join(at, 'apps/hub/src/main.ts'));
    expect(hubEntry('dist', at)).toBe(join(at, 'apps/hub/dist/main.js'));
  });

  it("applies the hub's script-face rule (sub-wave 1c): a deck whose tables need it is parsed on the hub, not a difference", () => {
    const start = JSON.stringify({
      level: 30,
      faces: ['Hani wqy-zenhei.ttc', 'Hira wqy-zenhei.ttc', 'Kana wqy-zenhei.ttc', 'Hang wqy-zenhei.ttc'],
      msg: 'system faces: Han wqy-zenhei.ttc, ... (table cells ...)',
    });
    expect(systemOnlyScriptsOf(['other line', start], ['Inter'])).toEqual(['Hani', 'Hira', 'Kana', 'Hang']);
    // The library's Noto Sans KR serves Han and Hangul; its Noto Sans JP Han, Hiragana and Katakana.
    expect(systemOnlyScriptsOf([start], ['Inter', 'Noto Sans KR'])).toEqual(['Hira', 'Kana']);
    expect(systemOnlyScriptsOf([start], ['Noto Sans JP', 'Noto Sans KR'])).toEqual([]);
    const none = JSON.stringify({ level: 30, faces: [], msg: 'system faces: none (...)' });
    expect(systemOnlyScriptsOf([none], ['Inter'])).toEqual([]);
    expect(systemOnlyScriptsOf(['no start line'], ['Inter'])).toEqual([]);
    const cell = (text: string) => ({ type: 'shape', table: { cells: [{ text }] } });
    const scene = (objects: unknown[]) => ({ slides: [{ slide: { objects } }] });
    expect(sceneNeedsScripts(scene([cell('이야기')]), ['Hang'])).toBe(true);
    expect(sceneNeedsScripts(scene([{ type: 'text', text: '이야기' }]), ['Hang'])).toBe(false);
    expect(sceneNeedsScripts(scene([{ type: 'group', objects: [cell('漢字')] }]), ['Hani'])).toBe(true);
    expect(sceneNeedsScripts(scene([cell('Amazing grace')]), ['Hang'])).toBe(false);
    expect(sceneNeedsScripts({ slides: 'x' }, ['Hang'])).toBe(false);
    expect(
      sceneRefusalOf([`the scene parsed in the browser was not used (${SCRIPT_FACE_REASON}): parsed here`]),
    ).toBe(SCRIPT_FACE_REASON);
    expect(sceneRefusalOf(['parsed in the browser: the hub checked its scene'])).toBeUndefined();
    const refused = { scene: 'refused' as const, sceneWhy: SCRIPT_FACE_REASON, differences: 0 };
    expect(equivalenceOf({ ...refused, scriptFace: true })).toBe('parsed on the hub (script face)');
    // A refusal the rule does not explain, or a scene the rule says the hub should have refused: differs.
    expect(equivalenceOf(refused)).toBe('differs');
    expect(equivalenceOf({ scene: 'used', differences: 0, scriptFace: true })).toBe('differs');
    expect(equivalenceOf({ scene: 'used', differences: 0 })).toBe('equal');
    expect(equivalenceOf({ scene: 'used', differences: 3 })).toBe('differs');
    const md = hubImportMarkdown({
      createdAt: 't',
      dryRun: false,
      libreoffice: 'present',
      unreadable: [],
      decks: [
        { name: 'a.pptx', ext: 'pptx', bytes: 1, state: 'done', scene: 'used', differences: 0 },
        { name: 'ko.pptx', ext: 'pptx', bytes: 1, state: 'done', ...refused, scriptFace: true },
      ],
    });
    expect(md).toMatch(
      /equivalence: 1 of 2 deck\(s\) equal; 1 parsed on the hub \(script face\): ko\.pptx; 0 differ/,
    );
  });

  it('waits for the hub to register its bundled fonts before a browser parse (sub-wave 1c integration)', async () => {
    // Until the hub's start-up registration of its bundled fonts settles, its library lists only some faces, so a
    // scene parsed then (the first deck of a --client-scene or --equivalence run) measured text with fewer faces
    // than the hub's own parse a moment later: the Biblical Mary deck's Hebrew and Greek table at the 1c head.
    const done = JSON.stringify({ level: 30, dir: '/usr/share/fonts', registered: 24, msg: 'bundled fonts' });
    const failed = JSON.stringify({
      level: 50,
      dir: '/x',
      err: 'EACCES',
      msg: 'bundled fonts not registered',
    });
    const missing = JSON.stringify({
      level: 40,
      missing: ['Noto Sans Hebrew 400'],
      msg: 'bundled fonts not installed',
    });
    expect(bundledFontsSettled([])).toBe(false);
    expect(bundledFontsSettled(['{"level":30,"msg":"ordo hub listening"}', 'not json', missing])).toBe(false);
    expect(bundledFontsSettled(['x', done])).toBe(true);
    expect(bundledFontsSettled([failed])).toBe(true);
    const lines: string[] = [];
    setTimeout(() => lines.push(done), 150);
    const t0 = Date.now();
    expect(await waitForBundledFonts(() => lines, 5000, 10)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    // Bounded: a hub that never says so is waited for at most the timeout.
    expect(await waitForBundledFonts(() => [], 50, 10)).toBe(false);
  });

  it('parses its options and refuses unknown ones', () => {
    expect(parseHubImportArgs(['--libreoffice', '--timeout-s', '30', 'x'])).toMatchObject({
      libreoffice: true,
      timeoutMs: 30_000,
      decks: ['x'],
    });
    expect(parseHubImportArgs(['--client-scene', 'x'])).toMatchObject({
      clientScene: true,
      equivalence: false,
    });
    expect(parseHubImportArgs(['--equivalence', 'x'])).toMatchObject({
      clientScene: true,
      equivalence: true,
    });
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
