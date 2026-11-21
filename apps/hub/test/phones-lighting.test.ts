/**
 * Per-field caps on the lighting triggers main's PR #37 added (design/28 §3.2), through the routes: a slide's
 * `midi`, a section's `midi`, a plan item's `midi` and a media item's `midi` are show control as a slide's `midiCues`
 * are. A phone's whole-document save that adds, changes or removes one is refused with 403 `cap` (field `midiCues`
 * for a slide, `midi` for the others); one that leaves them alone is saved and the trigger stays; the same bodies from
 * the iPad (an uncapped edit session) are saved. `capfields.test.ts` covers the pure comparison; this file covers that
 * `presentationRefusal`, `playlistRefusal` and `mediaPatchRefusal` are called with the stored document on every route.
 */
import { readFileSync } from 'node:fs';
import type { Media, Playlist, Presentation } from '@ordo/domain';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtures } from './fixtures.ts';
import { type Client, EDIT_PIN, login, song, startHub, type TestHub } from './helpers.ts';
import { phone, refusal } from './phones-helpers.ts';

const cue = { id: 'c1', channel: 2, type: 'programChange' as const, number: 5, value: 127 };
const preset = { kind: 'preset' as const, presetId: 'p-full' };
const cues = { kind: 'cues' as const, cues: [cue] };

describe('phone caps on lighting triggers', () => {
  let hub: TestHub;
  let ipad: Client;
  let ph: Client;
  let p: Presentation;
  beforeEach(async () => {
    hub = await startHub();
    ipad = await login(hub.url, EDIT_PIN);
    ph = await phone(hub.url);
    const s = song('Lit');
    s.sections[0]!.slides[0]!.midi = preset;
    s.sections[0]!.midi = cues;
    p = await ipad.json<Presentation>('/presentations', { method: 'POST', json: s });
  });
  afterEach(async () => {
    await hub.cleanup();
  });

  const edited = (f: (n: Presentation) => void): Presentation => {
    const n = structuredClone(p);
    f(n);
    return n;
  };

  it('the triggers are stored as written', () => {
    expect(p.sections[0]!.slides[0]!.midi).toEqual(preset);
    expect(p.sections[0]!.midi).toEqual(cues);
  });

  it('a phone that changes, removes or adds a slide trigger, or removes the slide, is refused as for MIDI cues', async () => {
    for (const next of [
      edited((n) => {
        n.sections[0]!.slides[0]!.midi = cues;
      }),
      edited((n) => {
        n.sections[0]!.slides[0]!.midi = undefined;
      }),
      edited((n) => {
        n.sections[0]!.slides[1]!.midi = preset;
      }),
      edited((n) => {
        n.sections[0]!.slides = n.sections[0]!.slides.slice(1);
      }),
    ]) {
      const res = await ph.fetch(`/presentations/${p.id}`, { method: 'PUT', json: next });
      expect(res.status).toBe(403);
      expect(await refusal(res)).toMatchObject({ code: 'cap', field: 'midiCues' });
    }
    expect(hub.lib.presentations.get(p.id)!.rev).toBe(p.rev);
  });

  it('a phone that changes or removes a section trigger is refused with field midi', async () => {
    for (const next of [
      edited((n) => {
        n.sections[0]!.midi = preset;
      }),
      edited((n) => {
        n.sections[0]!.midi = undefined;
      }),
    ]) {
      const res = await ph.fetch(`/presentations/${p.id}`, { method: 'PUT', json: next });
      expect(res.status).toBe(403);
      expect(await refusal(res)).toMatchObject({ code: 'cap', field: 'midi' });
    }
  });

  it('a phone that leaves the triggers alone saves and they stay; the iPad may change them', async () => {
    const fixed = edited((n) => {
      n.title = 'Lit (typo fixed)';
    });
    const saved = await ph.json<Presentation>(`/presentations/${p.id}`, { method: 'PUT', json: fixed });
    expect(saved.title).toBe('Lit (typo fixed)');
    expect(saved.sections[0]!.slides[0]!.midi).toEqual(preset);
    expect(saved.sections[0]!.midi).toEqual(cues);
    const changed = structuredClone(saved);
    changed.sections[0]!.midi = preset;
    expect((await ipad.fetch(`/presentations/${p.id}`, { method: 'PUT', json: changed })).status).toBe(200);
  });

  it('a new presentation from a phone carries no trigger', async () => {
    const withSlide = song('N1');
    withSlide.sections[0]!.slides[0]!.midi = preset;
    expect(
      await refusal(await ph.fetch('/presentations', { method: 'POST', json: withSlide })),
    ).toMatchObject({
      code: 'cap',
      field: 'midiCues',
    });
    const withSection = song('N2');
    withSection.sections[0]!.midi = cues;
    expect(
      await refusal(await ph.fetch('/presentations', { method: 'POST', json: withSection })),
    ).toMatchObject({
      code: 'cap',
      field: 'midi',
    });
  });

  it("a phone may not drop a plan item's trigger", async () => {
    const pl = await ipad.json<Playlist>('/playlists', {
      method: 'POST',
      json: {
        name: 'Sunday',
        items: [{ id: 'i1', kind: 'presentation', presentationId: p.id, midi: preset }],
      },
    });
    expect((pl.items[0] as { midi?: unknown }).midi).toEqual(preset);
    const drop = { ...pl, items: [{ id: 'i1', kind: 'presentation', presentationId: p.id }] };
    const res = await ph.fetch(`/playlists/${pl.id}`, { method: 'PUT', json: drop });
    expect(res.status).toBe(403);
    expect(await refusal(res)).toMatchObject({ code: 'cap', field: 'midi', itemId: 'i1' });
  });

  it("a phone may not change or clear a media item's trigger, and a rename keeps it", async () => {
    const fd = new FormData();
    fd.append('file', new Blob([readFileSync(fixtures.png(hub.dir))]), 'still.png');
    const m = await ipad.json<Media>('/media', { method: 'POST', body: fd });
    expect((await ipad.fetch(`/media/${m.id}`, { method: 'PUT', json: { midi: preset } })).status).toBe(200);
    for (const midi of [null, cues]) {
      const res = await ph.fetch(`/media/${m.id}`, { method: 'PUT', json: { midi } });
      expect(res.status).toBe(403);
      expect(await refusal(res)).toMatchObject({ code: 'cap', field: 'midi' });
    }
    const rename = await ph.fetch(`/media/${m.id}`, { method: 'PUT', json: { name: 'Clip', tags: ['x'] } });
    expect(rename.status).toBe(200);
    expect(hub.lib.media.get(m.id)!.midi).toEqual(preset);
  });
});
