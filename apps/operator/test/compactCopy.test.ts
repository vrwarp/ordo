/**
 * What a phone reads in the moments around its session and its media (review of P0, design/28 §2.12 and §6):
 * the sign-in over an ended session, the waits before the shell, More's line and a held video, in the phone's
 * words and the owner's (no "operating", no "outputs", no "hub"), in the catalog rather than inline.
 */
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en.ts';
import { enCompact } from '../src/i18n/enCompact.ts';
import { mediaStateKey } from '../src/views/compact/mediaState.ts';

describe('the compact strings around a session', () => {
  it('say what happened in the phone’s words, never the venue PC’s', () => {
    const phone = [
      enCompact['signin.endedPhone'],
      enCompact['signin.ended'],
      en['shell.connecting'],
      en['shell.unreachable'],
      en['shell.retry'],
      enCompact['more.signedInPhone'],
      enCompact['more.signedInDevice'],
      enCompact['media.state.waiting'],
    ];
    for (const s of phone) {
      expect(s, s).not.toMatch(/operat|outputs|\bhub\b/i);
      expect(s.length, s).toBeLessThan(140);
    }
    expect(enCompact['signin.endedPhone']).toBe(
      'Signed out. A phone signs in for an hour at a time, and a PIN change signs it out. Enter the PIN to keep looking.',
    );
    expect(en['shell.unreachable']).toBe("Can't reach ordo. Trying again…");
    expect(enCompact['media.state.waiting']).toBe('Waiting for the service to end');
    // More names the device it is on: an iPad in a narrow Split View is not a phone.
    expect(enCompact['more.signedInPhone']).toBe('Signed in on this phone');
    expect(enCompact['more.signedInDevice']).toBe('Signed in on this device');
  });
});

describe('mediaStateKey', () => {
  const video = { state: 'uploaded' as const, kind: 'video' as const };
  const live = { live: true, phonesOn: true };
  it('a video or animated GIF still uploaded while a service runs with Phones on waits for it to end', () => {
    expect(mediaStateKey(video, live)).toBe('media.state.waiting');
    expect(mediaStateKey({ state: 'uploaded', kind: 'image', original: { mime: 'image/gif' } }, live)).toBe(
      'media.state.waiting',
    );
  });
  it('everything else reads its own state (the hub holds nothing then)', () => {
    expect(mediaStateKey(video, { live: false, phonesOn: true })).toBe('media.state.uploaded');
    expect(mediaStateKey(video, { live: true, phonesOn: false })).toBe('media.state.uploaded');
    expect(mediaStateKey({ state: 'uploaded', kind: 'image', original: { mime: 'image/png' } }, live)).toBe(
      'media.state.uploaded',
    );
    expect(mediaStateKey({ ...video, state: 'processing' }, live)).toBe('media.state.processing');
    expect(mediaStateKey({ ...video, state: 'ready' }, live)).toBe('media.state.ready');
    expect(mediaStateKey({ ...video, state: 'failed' }, live)).toBe('media.state.failed');
  });
});
