import { describe, expect, it } from 'vitest';
import { type HubStatusInput, hubStatus, sessionEndedMessage } from '../src/lib/hubStatus.ts';

function l(p: Partial<HubStatusInput> = {}): HubStatusInput {
  return { authority: 'hub', reconcile: null, hubConnected: true, everConnected: true, ...p };
}

describe('hub status line', () => {
  it('reads the hub link in hub mode', () => {
    expect(hubStatus(l())).toMatchObject({ text: 'Hub', dot: 'green', fallback: false, refused: false });
    expect(hubStatus(l({ hubConnected: false })).text).toBe('Hub reconnecting…');
    expect(hubStatus(l({ hubConnected: false, everConnected: false })).text).toBe('Connecting…');
    expect(hubStatus(l({ hubConnected: false })).dot).toBe('red');
  });

  it('a refusal in hub mode: the outputs stay on the hub', () => {
    const s = hubStatus(l({ hubConnected: false, hubRefused: 'unauthorized' }));
    expect(s.text).toBe('Session ended: sign in again (outputs stay on the hub)');
    expect(s).toMatchObject({ dot: 'amber', refused: true, fallback: false });
    // Connected again (signed in): the refusal no longer shows even if the flag lags a tick.
    expect(hubStatus(l({ hubConnected: true, hubRefused: 'unauthorized' })).text).toBe('Hub');
  });

  it('a refusal while the operator is the fallback authority: the outputs run from this PC', () => {
    const s = hubStatus(l({ authority: 'fallback', hubConnected: false, hubRefused: 'unauthorized' }));
    expect(s.text).toBe('Running from this PC — session ended; sign in to hand back to the hub');
    expect(s.text).not.toMatch(/stay on the hub/);
    expect(s).toMatchObject({ dot: 'amber', refused: true, fallback: true });
    expect(hubStatus(l({ authority: 'fallback', hubConnected: false })).text).toBe(
      'Hub lost: running from this PC',
    );
  });

  it('the hand-back phases win over the refusal once the hub accepts the new sign-in', () => {
    const base = l({ authority: 'fallback', hubRefused: 'unauthorized' });
    expect(hubStatus({ ...base, hubConnected: true }).text).toBe('Hub back: handing over…');
    expect(hubStatus({ ...base, hubConnected: false, reconcile: 'awaitState' }).text).toBe(
      'Hub back: handing over…',
    );
    expect(hubStatus({ ...base, hubConnected: true, reconcile: 'adopting' }).text).toBe(
      'Hub back: handing over…',
    );
    expect(hubStatus({ ...base, hubConnected: true, reconcile: 'conflict' }).text).toBe(
      'Hub back: choose which service to keep',
    );
  });

  it('the sign-in overlay says where the outputs run', () => {
    expect(sessionEndedMessage(false)).toMatch(/from the hub/);
    expect(sessionEndedMessage(false)).not.toMatch(/this PC/);
    expect(sessionEndedMessage(true)).toMatch(/running from this PC/);
    expect(sessionEndedMessage(true)).toMatch(/hand the service back to the hub/);
    expect(sessionEndedMessage(true)).not.toMatch(/from the hub\./);
  });
});
