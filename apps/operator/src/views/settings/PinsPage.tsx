import { api } from '@ordo/client';
import { useState } from 'react';
import { Check } from '../../components/fields.tsx';
import { useLibrary } from '../../state/library.ts';
import { errorText, toast } from '../../state/toasts.ts';

/** What the Phones switch says it does (design/28 §9, owner question 5: off by default). */
export const PHONES_HELP =
  'When this is on, videos and other slow jobs uploaded during a service wait until it ends, and the hub accepts changes only from ordo pages that are up to date: reload any ordo tab left open. Phones can sign in either way: they look at everything and make small changes, and never run a service.';

/**
 * What changing a PIN does (design/28 §3.2, §4): the operate PIN signs out the sessions and phones that signed in
 * with it; the edit PIN signs out the sessions that signed in with it and every phone.
 */
export function pinChangedText(which: 'operatePin' | 'editPin'): string {
  return which === 'operatePin'
    ? 'Operate PIN changed. Sessions that signed in with it, phones included, are signed out.'
    : 'Edit PIN changed. Sessions that signed in with it and every phone are signed out.';
}

/** The switch as drawn: the hub's value, or the one being saved. */
export function PhonesSwitch(props: { enabled: boolean; saving?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="col" style={{ gap: 8 }} data-section="phones">
      <h2>Phones</h2>
      <Check
        label="Phones are used during services"
        value={props.enabled}
        disabled={props.saving}
        onChange={props.onChange}
      />
      <span className="muted small">{PHONES_HELP}</span>
    </div>
  );
}

/**
 * The Phones switch (`settings.phones.enabled`, design/24 "Feature flags are settings"): read from the library
 * store, saved with PUT /settings/phones like the PIN form saves. The store follows the hub's settings delta.
 */
export function PhonesSection() {
  const enabled = useLibrary((s) => s.data.settings.phones?.enabled === true);
  const [pending, setPending] = useState<boolean | undefined>(undefined);
  const save = async (next: boolean) => {
    setPending(next);
    try {
      await api('/settings/phones', { method: 'PUT', json: { enabled: next } });
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      setPending(undefined);
    }
  };
  return (
    <PhonesSwitch
      enabled={pending ?? enabled}
      saving={pending !== undefined}
      onChange={(v) => void save(v)}
    />
  );
}

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
      toast(pinChangedText(which), 'ok', 8000);
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
      <PhonesSection />
    </div>
  );
}
