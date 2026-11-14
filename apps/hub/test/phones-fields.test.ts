/**
 * Per-field caps on whole-document saves (design/28 §3.2, §8 "Live boundary"): a phone's save that adds,
 * changes or removes a slide's MIDI cues, sets PowerPoint data, or changes a plan item's show-control fields is
 * refused with 403 `cap` naming the field; one that leaves them alone is saved; a stale rev answers 409 as
 * before; the same bodies from the iPad (an uncapped edit session) are saved.
 */
import { readFileSync } from 'node:fs';
import type { Media, Playlist, Presentation } from '@ordo/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, song, startHub, type TestHub } from './helpers.ts';
import { phone, refusal } from './phones-helpers.ts';

const cue = { id: 'c1', channel: 2, type: 'programChange' as const, number: 5, value: 127 };

describe('per-field caps', () => {
  let hub: TestHub;
  let ipad: Client;
  let ph: Client;
  let p: Presentation;
  beforeEach(async () => {
    hub = await startHub();
    ipad = await login(hub.url, EDIT_PIN);
    ph = await phone(hub.url);
    const s = song('Cued');
    s.sections[0]!.slides[0]!.midiCues = [cue];
    p = await ipad.json<Presentation>('/presentations', { method: 'POST', json: s });
  });
  afterEach(async () => {
    await hub.cleanup();
  });

  const withCues = (q: Presentation, cues: (typeof cue)[] | undefined): Presentation => {
    const n = structuredClone(q);
    n.sections[0]!.slides[0]!.midiCues = cues;
    return n;
  };

  it('a phone that changes, removes or adds MIDI cues is refused, naming the field and the slide', async () => {
    const slideId = p.sections[0]!.slides[0]!.id;
    for (const next of [
      withCues(p, [{ ...cue, value: 1 }]),
      withCues(p, undefined),
      { ...p, sections: [{ ...p.sections[0]!, slides: p.sections[0]!.slides.slice(1) }] },
    ]) {
      const res = await ph.fetch(`/presentations/${p.id}`, { method: 'PUT', json: next });
      expect(res.status).toBe(403);
      const body = await refusal(res);
      expect(body).toMatchObject({ code: 'cap', field: 'midiCues', message: expect.stringMatching(/MIDI/) });
      expect([slideId, undefined]).toContain(body.slideId);
    }
    expect(hub.lib.presentations.get(p.id)!.rev).toBe(p.rev);
  });

  it('a phone that leaves the cues alone saves; the iPad saves the refused bodies', async () => {
    const fixed = structuredClone(p);
    fixed.title = 'Cued (typo fixed)';
    const saved = await ph.json<Presentation>(`/presentations/${p.id}`, { method: 'PUT', json: fixed });
    expect(saved.title).toBe('Cued (typo fixed)');
    expect(saved.sections[0]!.slides[0]!.midiCues).toEqual([cue]);
    const ipadSave = await ipad.fetch(`/presentations/${p.id}`, {
      method: 'PUT',
      json: withCues(saved, [{ ...cue, value: 9 }]),
    });
    expect(ipadSave.status).toBe(200);
  });

  it('a phone may not set PowerPoint data (no LibreOffice follow-up from a phone)', async () => {
    const n = structuredClone(p);
    n.sections[0]!.slides[1]!.pptx = {
      fileId: 'f'.repeat(64),
      index: 1,
      class: 'native',
      version: 1,
      pending: true,
    };
    const res = await ph.fetch(`/presentations/${p.id}`, { method: 'PUT', json: n });
    expect(res.status).toBe(403);
    expect(await refusal(res)).toMatchObject({
      code: 'cap',
      field: 'pptx',
      slideId: n.sections[0]!.slides[1]!.id,
    });
    const created = await ph.fetch('/presentations', {
      method: 'POST',
      json: { ...song('New'), id: undefined },
    });
    expect(created.status).toBe(201);
    const withCue = song('New with cue');
    withCue.sections[0]!.slides[0]!.midiCues = [cue];
    const refused = await ph.fetch('/presentations', { method: 'POST', json: withCue });
    expect(await refusal(refused)).toMatchObject({ code: 'cap', field: 'midiCues' });
  });

  it('a stale rev answers 409 (not 403); the phone merges and is checked on its next save', async () => {
    const newer = await ipad.json<Presentation>(`/presentations/${p.id}`, {
      method: 'PUT',
      json: { ...structuredClone(p), title: 'Newer' },
    });
    expect(newer.rev).toBe(p.rev + 1);
    const stale = await ph.fetch(`/presentations/${p.id}`, { method: 'PUT', json: withCues(p, undefined) });
    expect(stale.status).toBe(409);
  });

  it('a restore that would change the cues is refused', async () => {
    // Revision 1 had cues; the iPad clears them (revision 2). Restoring revision 1 would add them back.
    const cleared = await ipad.json<Presentation>(`/presentations/${p.id}`, {
      method: 'PUT',
      json: withCues(p, undefined),
    });
    const res = await ph.fetch(`/presentations/${p.id}/restore/${p.rev}`, { method: 'POST' });
    expect(res.status).toBe(403);
    expect(await refusal(res)).toMatchObject({ code: 'cap', field: 'midiCues' });
    expect(hub.lib.presentations.get(p.id)!.rev).toBe(cleared.rev);
    expect((await ipad.fetch(`/presentations/${p.id}/restore/${p.rev}`, { method: 'POST' })).status).toBe(
      200,
    );
  });

  it("a plan item's countdown, music and keepBackground are refused; a stale plan rev is 409", async () => {
    const pl = await ipad.json<Playlist>('/playlists', {
      method: 'POST',
      json: { name: 'Sunday', items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }] },
    });
    const timer = { kind: 'countdownTo' as const, timeOfDay: '10:00' };
    const add = (extra: Record<string, unknown>) => ({
      ...pl,
      items: [{ id: 'i1', kind: 'presentation', presentationId: p.id, ...extra }],
    });
    for (const [extra, field] of [
      [{ countdownTimer: timer }, 'countdownTimer'],
      [{ audioMediaId: 'm1' }, 'audioMediaId'],
      [{ keepBackground: true }, 'keepBackground'],
    ] as const) {
      const res = await ph.fetch(`/playlists/${pl.id}`, { method: 'PUT', json: add(extra) });
      expect(res.status).toBe(403);
      expect(await refusal(res)).toMatchObject({ code: 'cap', field, itemId: 'i1' });
    }
    const newPlan = await ph.fetch('/playlists', {
      method: 'POST',
      json: { name: 'Timer', items: [{ id: 't', kind: 'timer', timer }] },
    });
    expect(await refusal(newPlan)).toMatchObject({ code: 'cap', field: 'item.timer' });
    // Reorder and add a song: allowed.
    const ok = await ph.fetch(`/playlists/${pl.id}`, {
      method: 'PUT',
      json: { ...pl, items: [...pl.items, { id: 'i2', kind: 'presentation', presentationId: p.id }] },
    });
    expect(ok.status).toBe(200);
    const stale = await ph.fetch(`/playlists/${pl.id}`, {
      method: 'PUT',
      json: add({ countdownTimer: timer }),
    });
    expect(stale.status).toBe(409);
    expect(
      (
        await ipad.fetch(`/playlists/${pl.id}`, {
          method: 'PUT',
          json: { ...add({ countdownTimer: timer }), rev: pl.rev + 1 },
        })
      ).status,
    ).toBe(200);
  });

  it('PUT /media/:id from a phone: name and tags, never the playback fields', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(fixtures.png(hub.dir))]), 'still.png');
    const m = await ipad.json<Media>('/media', { method: 'POST', body: fd });
    expect(
      (await ph.fetch(`/media/${m.id}`, { method: 'PUT', json: { name: 'Clip', tags: ['x'] } })).status,
    ).toBe(200);
    for (const [json, field] of [
      [{ loop: true }, 'loop'],
      [{ isBackground: true }, 'isBackground'],
      [{ audio: { gainDb: -6 } }, 'audio'],
    ] as const) {
      const res = await ph.fetch(`/media/${m.id}`, { method: 'PUT', json });
      expect(await refusal(res)).toMatchObject({ code: 'cap', field });
    }
    expect((await ipad.fetch(`/media/${m.id}`, { method: 'PUT', json: { loop: true } })).status).toBe(200);
  });
});
