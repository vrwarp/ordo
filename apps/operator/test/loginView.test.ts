/**
 * The sign-in on a phone (design/28 §2.2 "Sign-in", §3.2; views/auth): a phone gets no Remember, its line, the
 * venue's host and no autofocus; every other device today's form byte for byte (no autofocus on the compact
 * layout); the request carries cap 'light' only to a hub that grants it, never remember, and is asked again
 * without cap once when an older hub refuses the field; a lockout says when it ends and which bucket it is.
 */
import { ApiFailure } from '@ordo/client';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyLayout, resetLayoutForTests } from '../src/lib/layout.ts';
import { RESIGN_KEY } from '../src/state/session.ts';
import { LoginView } from '../src/views/auth/LoginView.tsx';
import { type PinCall, phoneSignIn, safariNotInstalled, signInError } from '../src/views/auth/phoneSignIn.ts';

const TODAY =
  '<div class="center"><form class="card col" style="align-items:center;gap:14px;padding:28px"><h2>ordo</h2><span class="muted">Enter the operate or edit PIN</span><input class="pin" type="password" inputMode="numeric" autoComplete="current-password" autofocus="" value=""/><div class="keypad"><button type="button">1</button><button type="button">2</button><button type="button">3</button><button type="button">4</button><button type="button">5</button><button type="button">6</button><button type="button">7</button><button type="button">8</button><button type="button">9</button><button type="button">⌫</button><button type="button">0</button><button type="submit" class="primary" disabled="">OK</button></div><label class="check"><input type="checkbox" checked=""/>Remember this device (12 hours)</label></form></div>';
const TODAY_NO_FOCUS = TODAY.replace(' autofocus=""', '');

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  const g = globalThis as Record<string, unknown>;
  g.location = { host: 'op.church.example' };
  g.sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
});
afterEach(() => {
  resetLayoutForTests();
  const g = globalThis as Record<string, unknown>;
  delete g.location;
  delete g.sessionStorage;
});

type Props = { autoFocus?: boolean; phone?: boolean };
const render = (props: Props) =>
  renderToStaticMarkup(createElement(LoginView as FunctionComponent<Props>, props));

describe('LoginView', () => {
  it('not a phone: today’s form, byte for byte (the venue PC, an iPad, an Android tablet)', () => {
    expect(render({ phone: false })).toBe(TODAY);
    expect(render({ phone: false, autoFocus: false })).toBe(TODAY_NO_FOCUS);
  });

  it('not a phone on the compact layout (an iPad in a narrow Split View): today’s form, nothing focused', () => {
    applyLayout('compact', undefined);
    expect(render({ phone: false })).toBe(TODAY_NO_FOCUS);
  });

  it('a phone: no Remember, the venue, the line, nothing focused', () => {
    const html = render({ phone: true });
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Remember');
    expect(html).not.toContain('autofocus');
    expect(html).toContain('ordo at op.church.example');
    expect(html).toContain(
      'On a phone you can look at everything and make small changes. Services run from the venue PC.',
    );
    expect(html).toContain('class="keypad"');
    expect(html).not.toContain('Phones now sign in');
  });

  it('a phone signed out once from its pre-upgrade session says why', () => {
    store.set(RESIGN_KEY, 'signed-out');
    expect(render({ phone: true })).toContain(
      'Phones now sign in for an hour at a time. Enter the PIN again.',
    );
    store.set(RESIGN_KEY, 'done');
    expect(render({ phone: true })).not.toContain('Phones now sign in');
  });
});

/** A fake api: records each body and answers from the queue. */
function fakeCall(answers: (() => unknown)[]) {
  const bodies: Record<string, unknown>[] = [];
  const call: PinCall = async <T>(_path: string, init: { json: Record<string, unknown> }) => {
    bodies.push(init.json);
    const next = answers.shift();
    if (!next) throw new Error('no answer');
    return next() as T;
  };
  return { call, bodies };
}

describe('phoneSignIn', () => {
  it('asks for cap light from a hub that grants it, never remember', async () => {
    const f = fakeCall([() => ({ role: 'edit', cap: 'light' })]);
    expect(await phoneSignIn('246810', true, f.call)).toEqual({ role: 'edit', cap: 'light' });
    expect(f.bodies).toEqual([{ pin: '246810', cap: 'light' }]);
  });

  it('sends the PIN alone to a hub that grants no cap', async () => {
    const f = fakeCall([() => ({ role: 'operate' })]);
    await phoneSignIn('246810', false, f.call);
    expect(f.bodies).toEqual([{ pin: '246810' }]);
  });

  it('an older hub behind a stale /auth/me refuses the field: asked once more without cap', async () => {
    const refuse = () => {
      throw new ApiFailure(400, 'invalid', 'Invalid body: Unrecognized key: "cap"');
    };
    const f = fakeCall([refuse, () => ({ role: 'edit' })]);
    expect(await phoneSignIn('246810', true, f.call)).toEqual({ role: 'edit' });
    expect(f.bodies).toEqual([{ pin: '246810', cap: 'light' }, { pin: '246810' }]);
  });

  it('never retries any other refusal', async () => {
    for (const e of [
      new ApiFailure(400, 'invalid', 'Invalid body: pin too long'),
      new ApiFailure(401, 'unauthorized', 'Wrong PIN'),
      new ApiFailure(429, 'locked_out', 'Too many wrong PINs.', { retryAfterS: 600 }),
    ]) {
      const f = fakeCall([
        () => {
          throw e;
        },
      ]);
      await expect(phoneSignIn('246810', true, f.call)).rejects.toBe(e);
      expect(f.bodies).toHaveLength(1);
    }
  });
});

describe('signInError', () => {
  // 21:30 in London; the lockout ends ten minutes later.
  const now = Date.UTC(2026, 10, 19, 21, 30);
  const fmt = { locale: 'en-GB', timeZone: 'Europe/London' };
  const locked = (details: Record<string, unknown>) =>
    new ApiFailure(429, 'locked_out', 'Too many wrong PINs. Try again in 10 minutes.', details);

  it('a lockout of everyone, and of this network (or an older hub that does not say)', () => {
    expect(signInError(locked({ retryAfterS: 600, scope: 'everyone' }), now, fmt)).toBe(
      'Too many wrong PINs were tried on ordo. Try again at 21:40.',
    );
    const network =
      'Too many wrong PINs from this network. Try again at 21:40. Everyone on the same Wi-Fi may share this wait.';
    expect(signInError(locked({ retryAfterS: 600, scope: 'network' }), now, fmt)).toBe(network);
    expect(signInError(locked({ retryAfterS: 600 }), now, fmt)).toBe(network);
  });

  it('a lockout without a usable time, a wrong PIN, anything else', () => {
    expect(signInError(locked({}), now, fmt)).toBe('Too many wrong PINs. Try again in a few minutes.');
    expect(signInError(locked({ retryAfterS: 'soon' }), now, fmt)).toBe(
      'Too many wrong PINs. Try again in a few minutes.',
    );
    expect(signInError(new ApiFailure(401, 'unauthorized', 'x'), now, fmt)).toBe('Wrong PIN.');
    expect(
      signInError(
        new ApiFailure(403, 'cap', 'Phones cannot do this. Use the venue PC or an iPad.'),
        now,
        fmt,
      ),
    ).toBe('Phones cannot do this. Use the venue PC or an iPad.');
  });
});

describe('safariNotInstalled', () => {
  it('Safari in the browser only (WebKit has navigator.standalone; Chrome does not)', () => {
    expect(safariNotInstalled({ standalone: false })).toBe(true);
    expect(safariNotInstalled({ standalone: true })).toBe(false);
    expect(safariNotInstalled({})).toBe(false);
    expect(safariNotInstalled(undefined)).toBe(false);
  });
});
