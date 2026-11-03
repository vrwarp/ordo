import { join } from 'node:path';
import { newId, type Playlist, type Presentation } from '@ordo/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, migrate } from '../src/db.ts';
import { byType, connectWs, EDIT_PIN, login, OPERATE_PIN, startHub, type TestHub, tempDir } from './helpers.ts';
import { song } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});


describe('migrations', () => {
  it('are numbered, idempotent and re-runnable', () => {
    const db = new Database(join(tempDir(), 'm.db'));
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    expect(migrate(db)).toBe(MIGRATIONS.at(-1)!.version);
    // Re-applying every migration's SQL on an up-to-date schema is a no-op.
    for (const m of MIGRATIONS) db.exec(m.sql);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    for (const t of ['presentations', 'presentation_revisions', 'playlists', 'media', 'files', 'fonts', 'themes', 'folders', 'settings', 'sessions', 'auth_attempts', 'jobs', 'live_journal', 'live_snapshot'])
      expect(tables).toContain(t);
    db.close();
  });
});

describe('library', () => {
  it('creates, updates with rev check, keeps revisions and restores', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const ws = await connectWs(hub.url, { cookie: ed.cookie, hello: { role: 'edit' } });
    await ws.next(byType('welcome'));
    const p = await ed.json<Presentation>('/presentations', { method: 'POST', json: song() });
    expect(p.rev).toBe(1);
    expect(p.createdAt).toBeTruthy();
    const delta = await ws.next((m) => m.t === 'library.delta' && (m.changes as { kind: string }[])[0]?.kind === 'presentation');
    expect((delta.changes as { id: string }[])[0]!.id).toBe(p.id);

    const p2 = await ed.json<Presentation>(`/presentations/${p.id}`, { method: 'PUT', json: { ...p, title: 'Amazing Grace (My Chains)' } });
    expect(p2.rev).toBe(2);
    const stale = await ed.fetch(`/presentations/${p.id}`, { method: 'PUT', json: { ...p, title: 'Lost update' } });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { error: { code: string; rev: number } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.rev).toBe(2);
    expect((await ed.fetch(`/presentations/${p.id}`, { method: 'PUT', json: { ...p, rev: undefined } })).status).toBe(400);

    const revs = await ed.json<{ rev: number; title: string }[]>(`/presentations/${p.id}/revisions`);
    expect(revs.map((r) => r.rev)).toEqual([2, 1]);
    const restored = await ed.json<Presentation>(`/presentations/${p.id}/restore/1`, { method: 'POST' });
    expect(restored.rev).toBe(3);
    expect(restored.title).toBe('Amazing Grace');
    expect((await ed.json<unknown[]>(`/presentations/${p.id}/revisions`)).length).toBe(3);

    const bad = await ed.fetch('/presentations', { method: 'POST', json: { title: 'x', kind: 'nope' } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('invalid');

    expect((await ed.fetch(`/presentations/${p.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await ed.fetch(`/presentations/${p.id}`)).status).toBe(404);
    ws.close();
  });

  it('prunes revisions to 50 (or 30 days)', async () => {
    hub = await startHub();
    const p = hub.lib.savePresentation(song(), { create: true });
    let cur = p;
    for (let i = 0; i < 59; i++) cur = hub.lib.savePresentation({ ...cur, title: `t${i}` }, { expectedRev: cur.rev });
    expect(hub.lib.revisions(p.id).length).toBe(60); // all recent: kept for 30 days
    hub.lib.db.prepare(`UPDATE presentation_revisions SET saved_at = '2000-01-01T00:00:00.000Z'`).run();
    hub.lib.pruneRevisions(p.id);
    const revs = hub.lib.revisions(p.id);
    expect(revs.length).toBe(50);
    expect(revs[0]!.rev).toBe(60);
  });

  it('CRUDs playlists, themes and folders and serves a snapshot', async () => {
    hub = await startHub();
    const ed = await login(hub.url, EDIT_PIN);
    const p = await ed.json<Presentation>('/presentations', { method: 'POST', json: song() });
    const pl = await ed.json<Playlist>('/playlists', {
      method: 'POST',
      json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
    const pl2 = await ed.json<Playlist>(`/playlists/${pl.id}`, { method: 'PUT', json: { ...pl, name: 'Sunday AM' } });
    expect(pl2.rev).toBe(2);
    expect((await ed.fetch(`/playlists/${pl.id}`, { method: 'PUT', json: { ...pl, name: 'x' } })).status).toBe(409);
    const folder = await ed.json<{ id: string }>('/folders', { method: 'POST', json: { name: 'Hymns' } });
    const theme = await ed.json<{ id: string }>('/themes', {
      method: 'POST',
      json: { ...hub.lib.themes.get('theme-default'), id: undefined, name: 'Big' },
    });
    const snap = await ed.json<{ presentations: unknown[]; playlists: unknown[]; themes: unknown[]; folders: unknown[]; settings: { looks: unknown[] }; seq: number }>(
      '/library/snapshot',
    );
    expect(snap.presentations.length).toBe(1);
    expect(snap.playlists.length).toBe(1);
    expect(snap.themes.length).toBe(2);
    expect(snap.folders.length).toBe(1);
    expect(snap.settings.looks.length).toBe(4);
    expect(snap.seq).toBeGreaterThan(0);
    expect((await ed.fetch('/themes/theme-default', { method: 'DELETE' })).status).toBe(409);
    expect((await ed.fetch(`/themes/${theme.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await ed.fetch(`/folders/${folder.id}`, { method: 'DELETE' })).status).toBe(204);
  });

  it('locks the live playlist and its presentations (423)', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const ed = await login(hub.url, EDIT_PIN);
    const p = await ed.json<Presentation>('/presentations', { method: 'POST', json: song() });
    const other = await ed.json<Presentation>('/presentations', { method: 'POST', json: song('Other') });
    const pl = await ed.json<Playlist>('/playlists', {
      method: 'POST',
      json: { name: 'Live', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
    });
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    expect((await ed.fetch(`/presentations/${p.id}`, { method: 'PUT', json: { ...p, title: 'x' } })).status).toBe(423);
    expect((await ed.fetch(`/presentations/${p.id}`, { method: 'DELETE' })).status).toBe(423);
    expect((await ed.fetch(`/playlists/${pl.id}`, { method: 'PUT', json: { ...pl, name: 'x' } })).status).toBe(423);
    expect((await ed.fetch(`/playlists/${pl.id}`, { method: 'DELETE' })).status).toBe(423);
    expect((await ed.fetch(`/presentations/${other.id}`, { method: 'PUT', json: { ...other, title: 'fine' } })).status).toBe(200);
    await op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
    expect((await ed.fetch(`/presentations/${p.id}`, { method: 'PUT', json: { ...p, title: 'x' } })).status).toBe(200);
  });

  it('validates settings, keeps output tokens and broadcasts settings to outputs', async () => {
    hub = await startHub();
    const op = await login(hub.url, OPERATE_PIN);
    const outputs = await op.json<{ id: string; token: string; name: string }[]>('/settings/outputs');
    const outWs = await connectWs(hub.url, { token: outputs[1]!.token, hello: { role: 'output', outputId: outputs[1]!.id } });
    await outWs.next(byType('live.state'));
    expect((await op.fetch('/settings/general', { method: 'PUT', json: { venueName: 5 } })).status).toBe(400);
    expect((await op.fetch('/settings/nope', { method: 'PUT', json: {} })).status).toBe(404);
    const g = await op.json<{ venueName: string; defaultLinesPerSlide: number }>('/settings/general', {
      method: 'PUT',
      json: { venueName: 'Grace Church' },
    });
    expect(g.venueName).toBe('Grace Church');
    expect(g.defaultLinesPerSlide).toBe(2);
    const d = await outWs.next(byType('library.delta'));
    expect(d.changes).toEqual([{ kind: 'settings', id: 'general', rev: undefined }]);
    // Tokens cannot be overwritten through PUT; new outputs get one.
    const next = [
      ...outputs.map((o) => ({ ...o, token: 'hacked', name: `${o.name}!` })),
      { id: '', name: 'Out 5', hostIndex: 5, lookId: 'look-main' },
    ];
    const saved = await op.json<{ id: string; token: string; name: string }[]>('/settings/outputs', { method: 'PUT', json: next });
    expect(saved[0]!.token).toBe(outputs[0]!.token);
    expect(saved[0]!.name).toBe('Audience 1!');
    expect(saved[5]!.token).toMatch(/^[\w-]{40,}$/);
    outWs.close();
  });
});
