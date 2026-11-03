import { cpSync, existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreBackup } from '../src/backup.ts';
import { fixtures } from './fixtures.ts';
import { EDIT_PIN, login, OPERATE_PIN, song, startHub, type TestHub, tempDir } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

describe('backups', () => {
  it('writes VACUUM INTO + media manifest, lists, prunes after 30 days and restores with verification', async () => {
    hub = await startHub({ dataDir: tempDir() });
    const op = await login(hub.url, OPERATE_PIN);
    const ed = await login(hub.url, EDIT_PIN);
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(fixtures.png(tempDir()))]), 'logo.png');
    await ed.fetch('/media', { method: 'POST', body: fd });
    await hub.jobs.idle();
    hub.lib.savePresentation(song('Before backup'), { create: true });
    expect((await ed.fetch('/backup/run', { method: 'POST' })).status).toBe(403);
    const { file } = await op.json<{ file: string }>('/backup/run', { method: 'POST' });
    expect(file).toMatch(/^ordo-\d{4}-\d{2}-\d{2}-\d{6}\.db$/);
    const dir = join(hub.dir, 'backups');
    const stamp = file.slice(5, -3);
    const manifest = JSON.parse(readFileSync(join(dir, `media-manifest-${stamp}.json`), 'utf8')) as {
      files: { hash: string; path: string }[];
    };
    expect(manifest.files.length).toBe(1);
    const nightly = await hub.backups.run({ nightly: true });
    expect(nightly.file).toMatch(/^ordo-\d{4}-\d{2}-\d{2}\.db$/);
    expect((await op.json<{ files: string[] }>('/backup/list')).files.length).toBe(2);
    const snap = new Database(join(dir, file), { readonly: true });
    expect((snap.prepare(`SELECT COUNT(*) n FROM presentations`).get() as { n: number }).n).toBe(1);
    snap.close();

    // Retention: anything older than 30 days goes.
    const old = new Date(Date.now() - 31 * 86400_000);
    writeFileSync(join(dir, 'ordo-2000-01-01.db'), 'x');
    writeFileSync(join(dir, 'media-manifest-2000-01-01.json'), '{}');
    utimesSync(join(dir, 'ordo-2000-01-01.db'), old, old);
    utimesSync(join(dir, 'media-manifest-2000-01-01.json'), old, old);
    expect((await hub.backups.prune()).sort()).toEqual([
      'media-manifest-2000-01-01.json',
      'ordo-2000-01-01.db',
    ]);

    // Next nightly run is at 03:00 venue time.
    const next = hub.backups.schedule(Date.UTC(2026, 0, 1, 12, 0));
    expect(new Date(next).toISOString()).toBe('2026-01-02T03:00:00.000Z');
    hub.backups.stop();

    // Restore into a copy of the data directory after more edits.
    hub.lib.savePresentation(song('After backup'), { create: true });
    await hub.cleanup();
    const copy = tempDir();
    cpSync(hub.dir, copy, { recursive: true });
    const lines: string[] = [];
    const r = await restoreBackup(copy, stamp, { print: (s) => lines.push(s) });
    expect(r.verified).toBe(1);
    expect(lines.join('\n')).toMatch(/previous database saved/);
    const restored = new Database(join(copy, 'ordo.db'), { readonly: true });
    const titles = (restored.prepare(`SELECT title FROM presentations`).all() as { title: string }[]).map(
      (t) => t.title,
    );
    restored.close();
    expect(titles).toEqual(['Before backup']);
    expect(readdirSync(join(copy, 'backups')).some((f) => f.startsWith('ordo-pre-restore-'))).toBe(true);

    // Tampered media fails verification unless forced.
    const f = manifest.files[0]!;
    writeFileSync(join(copy, f.path), 'tampered');
    await expect(restoreBackup(copy, file, { print: () => {} })).rejects.toThrow(/verification failed/);
    await expect(restoreBackup(copy, file, { force: true, print: () => {} })).resolves.toMatchObject({
      mismatched: [f.path],
    });
    expect(existsSync(join(copy, 'ordo.db'))).toBe(true);
  });

  it('exports diagnostics without secrets', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    hub.log.warn({ url: '/x?token=SECRET123' }, 'something');
    const res = await op.fetch('/diagnostics/export');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(Object.keys(zip.files).sort()).toEqual([
      'health.json',
      'hub.json',
      'journal.json',
      'logs.ndjson',
      'settings.json',
    ]);
    const settings = await zip.file('settings.json')!.async('string');
    for (const o of hub.lib.getSetting('outputs')) expect(settings).not.toContain(o.token);
    expect(settings).not.toContain('argon2');
    const logs = await zip.file('logs.ndjson')!.async('string');
    expect(logs).toContain('something');
    expect(logs).not.toContain('SECRET123');
  });
});
