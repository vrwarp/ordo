/**
 * Service-safety fixes from the 2026-11-13 review, on the hub: MIDI pedals kept for venues upgraded from
 * before MIDI became opt-in, and pre-service loop music that is deleted or still processing (Go live goes
 * ahead with a warning; deleting music a playlist uses names the playlist first).
 */
import { type LiveState, type Media, newId, type Presentation } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { playlistsUsingMedia } from '../src/routes.ts';
import { EDIT_PIN, login, OPERATE_PIN, song, startHub, type TestHub } from './helpers.ts';

let hub: TestHub | undefined;
afterEach(async () => {
  await hub?.cleanup();
  hub = undefined;
});

function music(h: TestHub, state: Media['state'] = 'ready', name = 'Organ prelude'): Media {
  const hash = newId().toLowerCase().padEnd(64, '0').slice(0, 64);
  return h.lib.media.insert({
    id: newId(),
    rev: 1,
    name,
    tags: [],
    kind: 'audio',
    original: { hash, bytes: 10, mime: 'audio/mpeg', path: `media/${hash.slice(0, 2)}/${hash}.mp3` },
    ...(state === 'ready'
      ? { delivery: { hash: `d${hash.slice(1)}`, bytes: 5, mime: 'audio/mp4', path: 'x' } }
      : {}),
    state,
    loop: true,
    isBackground: false,
  });
}

/** A pre-service loop with music and a countdown, then a song. */
function service(h: TestHub, musicId: string) {
  const loop: Presentation = { ...song('Announcements'), kind: 'loop', loop: { defaultSlideMs: 1000 } };
  const lp = h.lib.savePresentation(loop, { create: true });
  const p = h.lib.savePresentation(song(), { create: true });
  return h.lib.playlists.insert({
    id: newId(),
    rev: 1,
    name: 'Sunday 10:00',
    items: [
      {
        id: newId(),
        kind: 'presentation',
        presentationId: lp.id,
        audioMediaId: musicId,
        countdownTimer: { kind: 'countdownTo', timeOfDay: '10:00', label: 'Service starts in' },
      },
      { id: newId(), kind: 'presentation', presentationId: p.id },
    ],
  });
}

describe('MIDI after an upgrade from before MIDI became opt-in', () => {
  const store = (h: TestHub, surfaces: Record<string, unknown>) =>
    h.db.prepare(`UPDATE settings SET json = ? WHERE key = 'surfaces'`).run(JSON.stringify(surfaces));

  it('reads stored settings with MIDI mappings and no midiEnabled as enabled, so the pedals keep working', async () => {
    hub = await startHub();
    const stored = hub.lib.getSetting('surfaces');
    const { midiEnabled: _, ...old } = stored;
    expect(old.midi.length).toBeGreaterThan(0);
    store(hub, old);
    expect(hub.lib.getSetting('surfaces').midiEnabled).toBe(true);
    // What the operator loads says the same.
    const op = await login(hub.url, OPERATE_PIN);
    const all = await op.json<{ surfaces: { midiEnabled: boolean } }>('/settings');
    expect(all.surfaces.midiEnabled).toBe(true);
  });

  it('leaves a venue without mappings off (no MIDI permission prompt), and a stored choice as it is', async () => {
    hub = await startHub();
    const { midiEnabled: _, ...old } = hub.lib.getSetting('surfaces');
    store(hub, { ...old, midi: [] });
    expect(hub.lib.getSetting('surfaces').midiEnabled).toBe(false);
    store(hub, { ...old, midiEnabled: false });
    expect(hub.lib.getSetting('surfaces').midiEnabled).toBe(false);
    // A new library is seeded off.
    hub.db.prepare(`DELETE FROM settings WHERE key = 'surfaces'`).run();
    expect(hub.lib.getSetting('surfaces').midiEnabled).toBe(false);
  });
});

describe('pre-service loop music that is not ready', () => {
  it('goes live with a warning when the music is still processing, and the loop plays without it', async () => {
    hub = await startHub();
    const m = music(hub, 'processing');
    const pl = service(hub, m.id);
    const op = await login(hub.url, OPERATE_PIN);
    const res = await op.fetch('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    expect(res.status).toBe(200);
    const { state } = await op.json<{ state: LiveState }>('/live');
    expect(state.mode).toBe('live');
    expect(state.resolved!.media[m.id]).toBeUndefined();
    expect(state.resolved!.degraded).toEqual([
      {
        cueIndex: -1,
        reason:
          '"Organ prelude" (the music of "Announcements") is still processing; the item plays without music; Go live again once it is ready',
      },
    ]);
    expect(state.cues.every((c) => !c.slideAudio)).toBe(true);
    // The countdown still starts with the loop.
    expect(state.cues[0]?.timerId).toBeDefined();
  });

  it('names the playlists that use media before deleting it, and goes live without music deleted anyway', async () => {
    hub = await startHub();
    const m = music(hub);
    const pl = service(hub, m.id);
    expect(playlistsUsingMedia(hub.lib, m.id)).toEqual([{ id: pl.id, name: 'Sunday 10:00' }]);
    expect(playlistsUsingMedia(hub.lib, newId())).toEqual([]);
    const ed = await login(hub.url, EDIT_PIN);
    const res = await ed.fetch(`/media/${m.id}`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; message: string; presentations: unknown[]; playlists: unknown[] };
    };
    expect(body.error.code).toBe('media_in_use');
    expect(body.error.message).toBe(
      '“Organ prelude” is used by the playlist “Sunday 10:00”. Until it is replaced they go live without it, or cannot go live.',
    );
    expect(body.error.presentations).toEqual([]);
    expect(body.error.playlists).toEqual([{ id: pl.id, name: 'Sunday 10:00' }]);
    expect(hub.lib.media.get(m.id)).toBeDefined();
    expect((await ed.fetch(`/media/${m.id}?force=1`, { method: 'DELETE' })).status).toBe(204);

    const op = await login(hub.url, OPERATE_PIN);
    const live = await op.fetch('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    expect(live.status).toBe(200);
    const { state } = await op.json<{ state: LiveState }>('/live');
    expect(state.resolved!.degraded?.map((d) => d.reason)).toEqual([
      'The music of "Announcements" is missing; the item plays without music',
    ]);
  });

  it('a media item the playlist plays itself still refuses Go live when it is not ready', async () => {
    hub = await startHub();
    const m = music(hub, 'processing', 'Walk-in');
    const p = hub.lib.savePresentation(song('Opening'), { create: true });
    const pl = hub.lib.playlists.insert({
      id: newId(),
      rev: 1,
      name: 'Sunday',
      items: [
        { id: newId(), kind: 'media', mediaId: m.id },
        { id: newId(), kind: 'presentation', presentationId: p.id, audioMediaId: m.id },
      ],
    });
    const op = await login(hub.url, OPERATE_PIN);
    const res = await op.fetch('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { message: string } }).error.message).toMatch(
      /"Walk-in" is still processing/,
    );
  });
});
