import { api, ApiFailure } from '@ordo/client';
import { type AuthPinReq, type AuthPinRes, ROUTES } from '@ordo/protocol';
import { useState } from 'react';
import { t } from '../../i18n/index.ts';
import { thisIsPhone, useCurrentLayout } from '../../lib/layout.ts';
import {
  hubGrants,
  readResignFlag,
  refreshSession,
  useSession,
  writeResignFlag,
} from '../../state/session.ts';
import { phoneSignIn, safariNotInstalled, signInError } from './phoneSignIn.ts';

/**
 * PIN login with a large keypad and "remember this device" (prd/09). `autoFocus` is off when the card sits
 * beside a running service (design/15 "Session expiry"): a focused PIN field would take the GO key. A phone
 * gets its own form (design/28 §2.2 "Sign-in"); every other device today's, nothing autofocused on the compact
 * layout (an iPad in a narrow Split View).
 */
export function LoginView({
  autoFocus = true,
  phone = thisIsPhone(),
}: {
  autoFocus?: boolean;
  /**
   * This device is a phone (design/28 §3.2: from the screen, so Request Desktop Website still is one). The
   * default is the page's one decision (lib/layout.ts thisIsPhone), so the sign-in and the page agree: an iPad
   * whose `screen` follows a window shrunk by the keyboard never signs in capped (review of P0). Tests set it.
   */
  phone?: boolean;
} = {}) {
  const compact = useCurrentLayout() === 'compact';
  if (phone) return <PhoneLoginView />;
  return <RegularLoginView autoFocus={autoFocus && !compact} />;
}

function RegularLoginView({ autoFocus }: { autoFocus: boolean }) {
  const [pin, setPin] = useState('');
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (pin.length < 6 || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      const req: AuthPinReq = { pin, remember };
      await api<AuthPinRes>(ROUTES.pin, { method: 'POST', json: req });
      await refreshSession();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 429)
        setErr(e.message || 'Too many attempts. Try again in 15 minutes.');
      else if (e instanceof ApiFailure && e.status === 401) setErr('Wrong PIN.');
      else setErr(e instanceof Error ? e.message : String(e));
      setPin('');
    } finally {
      setBusy(false);
    }
  };
  const press = (d: string) => setPin((p) => (p.length < 12 ? p + d : p));
  return (
    <div className="center">
      <form
        className="card col"
        style={{ alignItems: 'center', gap: 14, padding: 28 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>ordo</h2>
        <span className="muted">Enter the operate or edit PIN</span>
        <input
          className="pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          autoFocus={autoFocus}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
        />
        <Keypad pin={pin} busy={busy} setPin={setPin} press={press} />
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this device (12 hours)
        </label>
        {err && <div className="banner red">{err}</div>}
      </form>
    </div>
  );
}

function Keypad(props: {
  pin: string;
  busy: boolean;
  setPin: (f: (p: string) => string) => void;
  press: (d: string) => void;
}) {
  const { pin, busy, setPin, press } = props;
  return (
    <div className="keypad">
      {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
        <button key={d} type="button" onClick={() => press(d)}>
          {d}
        </button>
      ))}
      <button type="button" onClick={() => setPin((p) => p.slice(0, -1))}>
        ⌫
      </button>
      <button type="button" onClick={() => press('0')}>
        0
      </button>
      <button type="submit" className="primary" disabled={pin.length < 6 || busy}>
        OK
      </button>
    </div>
  );
}

/** The phone's notes under the keypad: as wide as the keypad, centred. */
const NOTE = { maxWidth: 260, margin: 0, textAlign: 'center' } as const;

/**
 * A phone's sign-in (design/28 §2.2 "Sign-in", §3.2): the keypad as today, never remembered (no checkbox), the
 * cap asked for when the hub grants it, the venue it signs in to, one line on what a phone may do, Safari's
 * home-screen note, nothing focused on open, and a lockout's end in the phone's own time. After the one
 * sign-out of a pre-upgrade session it says why (state/session.ts).
 */
function PhoneLoginView() {
  const me = useSession((s) => s.me);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [resigned] = useState(() => readResignFlag() === 'signed-out');
  const host = typeof location === 'undefined' ? '' : location.host;
  const submit = async () => {
    if (pin.length < 6 || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      await phoneSignIn(pin, hubGrants(me, 'light'));
      if (resigned) writeResignFlag('done');
      await refreshSession();
    } catch (e) {
      setErr(signInError(e, Date.now()));
      setPin('');
    } finally {
      setBusy(false);
    }
  };
  const press = (d: string) => setPin((p) => (p.length < 12 ? p + d : p));
  return (
    <div className="center">
      <form
        className="card col"
        style={{ alignItems: 'center', gap: 14, padding: 28 }}
        data-phone-signin
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>ordo</h2>
        <span className="muted" data-signin-host>
          {t('signin.host', { host })}
        </span>
        {resigned && (
          <div className="banner" data-signin-again>
            {t('signin.reSignIn')}
          </div>
        )}
        <span className="muted">{t('signin.prompt')}</span>
        <input
          className="pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          aria-label={t('signin.prompt')}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
        />
        <Keypad pin={pin} busy={busy} setPin={setPin} press={press} />
        {err && (
          <div className="banner red" role="alert" data-signin-error>
            {err}
          </div>
        )}
        <p className="muted small" style={NOTE} data-signin-phone>
          {t('signin.phoneLine')}
        </p>
        {safariNotInstalled() && (
          <p className="muted small" style={NOTE} data-signin-home>
            {t('signin.homeScreen')}
          </p>
        )}
      </form>
    </div>
  );
}
