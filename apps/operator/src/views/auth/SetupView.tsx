import { api } from '@ordo/client';
import { ROUTES } from '@ordo/protocol';
import { useState } from 'react';
import { refreshSession } from '../../state/session.ts';

/** First run: set both PINs (prd/09). */
export function SetupView() {
  const [operatePin, setOperate] = useState('');
  const [operate2, setOperate2] = useState('');
  const [editPin, setEdit] = useState('');
  const [edit2, setEdit2] = useState('');
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const valid = (p: string) => /^\d{6,12}$/.test(p);
  const problem = !valid(operatePin)
    ? 'The operate PIN must be 6 to 12 digits.'
    : operatePin !== operate2
      ? 'The operate PINs do not match.'
      : !valid(editPin)
        ? 'The edit PIN must be 6 to 12 digits.'
        : editPin !== edit2
          ? 'The edit PINs do not match.'
          : editPin === operatePin
            ? 'Use different PINs for operate and edit.'
            : undefined;
  const submit = async () => {
    if (problem) return;
    setBusy(true);
    try {
      await api(ROUTES.setup, { method: 'POST', json: { operatePin, editPin } });
      await api(ROUTES.pin, { method: 'POST', json: { pin: operatePin, remember: true } }).catch(() => undefined);
      await refreshSession();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pinInput = (v: string, set: (s: string) => void, label: string) => (
    <label className="field">
      <span>{label}</span>
      <input
        type="password"
        inputMode="numeric"
        value={v}
        onChange={(e) => set(e.target.value.replace(/\D/g, '').slice(0, 12))}
      />
    </label>
  );
  return (
    <div className="center">
      <form
        className="card col"
        style={{ width: 440, gap: 12, padding: 24 }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>Welcome to ordo</h2>
        <p className="muted" style={{ margin: 0 }}>
          Set two PINs. The <b>operate</b> PIN runs services and changes settings. The <b>edit</b> PIN prepares
          songs and playlists, including from home, but cannot control the live service.
        </p>
        <div className="grid2">
          {pinInput(operatePin, setOperate, 'Operate PIN')}
          {pinInput(operate2, setOperate2, 'Repeat operate PIN')}
          {pinInput(editPin, setEdit, 'Edit PIN')}
          {pinInput(edit2, setEdit2, 'Repeat edit PIN')}
        </div>
        {problem && (operatePin || editPin) && <span className="muted small">{problem}</span>}
        {err && <div className="banner red">{err}</div>}
        <button type="submit" className="primary big" disabled={!!problem || busy}>
          Save PINs and sign in
        </button>
      </form>
    </div>
  );
}
