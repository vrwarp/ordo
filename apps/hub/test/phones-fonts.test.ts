/**
 * Fonts the live copy uses are locked (design/28 §3.4, §5.1): DELETE /fonts/:id of a face the frozen live
 * playlist draws with answers 423, as a live medium does; after End service it is deleted. In two processes the
 * library refuses through the locks the live process reports.
 */
import { readFileSync } from 'node:fs';
import { type Font, newId, type Playlist, type Presentation, type TextObject } from '@ordo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { type Client, login, OPERATE_PIN, song, startHub, type TestHub } from './helpers.ts';
import { refusal, type TwoProcesses, twoProcesses } from './phones-helpers.ts';

const DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

/** A face named 'Venue Sans', a song drawn with it, a plan of that song. */
async function setup(op: Client): Promise<{ font: Font; pl: Playlist; other: Font }> {
  const up = async (family: string) => {
    const fd = new FormData();
    fd.append('family', family);
    fd.append('file', new Blob([readFileSync(DEJAVU)]), 'DejaVuSans.ttf');
    return (await op.json<Font[]>('/fonts/upload', { method: 'POST', body: fd }))[0]!;
  };
  const font = await up('Venue Sans');
  const other = await up('Unused Sans');
  const s = song();
  for (const sl of s.sections[0]!.slides)
    for (const o of sl.objects) if (o.type === 'text') (o as TextObject).style.fontFamily = 'Venue Sans';
  const p = await op.json<Presentation>('/presentations', { method: 'POST', json: s });
  const pl = await op.json<Playlist>('/playlists', {
    method: 'POST',
    json: { name: 'Sunday', items: [{ id: newId(), kind: 'presentation', presentationId: p.id }] },
  });
  return { font, pl, other };
}

describe('fonts the live copy uses', () => {
  let hub: TestHub | undefined;
  let two: TwoProcesses | undefined;
  afterEach(async () => {
    await hub?.cleanup();
    await two?.close();
    hub = undefined;
    two = undefined;
  });

  async function run(base: string) {
    const op = await login(base, OPERATE_PIN);
    const { font, pl, other } = await setup(op);
    await op.json('/live/events', { method: 'POST', json: { k: 'goLive', playlistId: pl.id } });
    // Before P0: 204, the face gone from under the running service.
    const res = await op.fetch(`/fonts/${font.id}`, { method: 'DELETE' });
    expect(res.status).toBe(423);
    expect(await refusal(res)).toMatchObject({
      code: 'locked',
      message: 'This font is used by the live playlist',
    });
    // A face the service does not use is deleted as before.
    expect((await op.fetch(`/fonts/${other.id}`, { method: 'DELETE' })).status).toBe(204);
    await op.json('/live/events', { method: 'POST', json: { k: 'endService', at: Date.now() } });
    await expect
      .poll(async () => (await op.fetch(`/fonts/${font.id}`, { method: 'DELETE' })).status)
      .toBe(204);
  }

  it('DELETE /fonts/:id of a live face is 423 until End service (one process)', async () => {
    hub = await startHub();
    await run(hub.url);
    expect(hub.live.locks().fonts.size).toBe(0);
  });

  it('the library process refuses it through the locks the live process reports (two processes)', async () => {
    two = await twoProcesses();
    await run(two.base);
  });
});
