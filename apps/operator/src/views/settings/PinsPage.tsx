import { api } from '@ordo/client';
import { useState } from 'react';
import { errorText, toast } from '../../state/toasts.ts';

export function PinsPage() {
  const [which, setWhich] = useState<'operatePin' | 'editPin'>('operatePin');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState(false);
  const problem = !/^\d{6,12}$/.test(a)
    ? 'PINs are 6 to 12 digits.'
    : a !== b
      ? 'The PINs do not match.'
      : undefined;
  const submit = async () => {
    setBusy(true);
    try {
      await api('/auth/pins', { method: 'PUT', json: { [which]: a } });
      toast(
        `${which === 'operatePin' ? 'Operate' : 'Edit'} PIN changed. Other sessions with that role are signed out.`,
        'ok',
        8000,
      );
      setA('');
      setB('');
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="col" style={{ gap: 12, maxWidth: 420 }}>
      <h2>PINs</h2>
      <div className="row">
        <button
          type="button"
          className={which === 'operatePin' ? 'on' : ''}
          onClick={() => setWhich('operatePin')}
        >
          Operate PIN
        </button>
        <button type="button" className={which === 'editPin' ? 'on' : ''} onClick={() => setWhich('editPin')}>
          Edit PIN
        </button>
      </div>
      <input
        type="password"
        inputMode="numeric"
        placeholder="New PIN"
        value={a}
        onChange={(e) => setA(e.target.value.replace(/\D/g, ''))}
      />
      <input
        type="password"
        inputMode="numeric"
        placeholder="Repeat new PIN"
        value={b}
        onChange={(e) => setB(e.target.value.replace(/\D/g, ''))}
      />
      {a && problem && <span className="muted small">{problem}</span>}
      <button type="button" className="primary" disabled={!!problem || busy} onClick={() => void submit()}>
        Change PIN
      </button>
    </div>
  );
}
