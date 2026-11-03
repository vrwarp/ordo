import { api, ApiFailure } from '@ordo/client';
import { type AuthPinRes, ROUTES } from '@ordo/protocol';
import { useState } from 'react';
import { refreshSession } from '../../state/session.ts';

/** PIN login with a large keypad and "remember this device" (prd/09). */
export function LoginView() {
  const [pin, setPin] = useState('');
  const [remember, setRemember] = useState(true);
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (pin.length < 6 || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api<AuthPinRes>(ROUTES.pin, { method: 'POST', json: { pin, remember } });
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
          autoFocus
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
        />
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
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this device (12 hours)
        </label>
        {err && <div className="banner red">{err}</div>}
      </form>
    </div>
  );
}
