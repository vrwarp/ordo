import { api } from '@ordo/client';
import type { GoogleFontFamily, Job } from '@ordo/protocol';
import { useEffect, useState } from 'react';
import { fontFamilies } from '../services/fonts.ts';
import { useLibrary } from '../state/library.ts';
import { errorText, toast } from '../state/toasts.ts';
import { Dialog } from './Dialog.tsx';

/** The value of the placeholder option a mixed selection shows (never a family: families are not empty). */
const MIXED = '';

/** The select's accessible name: its label, with "(mixed)" while the selection mixes fonts (design/15). */
export function fontLabel(label: string, mixed: boolean | undefined): string {
  return mixed ? `${label} (mixed)` : label;
}

/**
 * Family picker: library fonts plus system fallbacks, with Google Fonts search and add (prd/05).
 * `label` names the select (aria-label; default "Font"). `mixed`: the selected text has more than one font,
 * shown as "Mixed" (not one of them) and named "Font (mixed)"; picking a family applies it to all of it.
 */
export function FontPicker(props: {
  value: string;
  onChange: (family: string) => void;
  compact?: boolean;
  label?: string;
  mixed?: boolean;
}) {
  const fonts = useLibrary((s) => s.data.fonts);
  const [search, setSearch] = useState(false);
  const families = fontFamilies(fonts);
  if (props.value && !families.includes(props.value)) families.unshift(props.value);
  const missing = !props.mixed && props.value && !fonts.some((f) => f.family === props.value);
  return (
    <span className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
      <select
        aria-label={fontLabel(props.label ?? 'Font', props.mixed)}
        value={props.mixed ? MIXED : props.value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === '__google') setSearch(true);
          else if (v !== MIXED) props.onChange(v);
        }}
        style={{ fontFamily: props.mixed ? undefined : props.value, maxWidth: props.compact ? 104 : 180 }}
      >
        {props.mixed && (
          <option value={MIXED} disabled>
            Mixed
          </option>
        )}
        {families.map((f) => (
          <option key={f} value={f} style={{ fontFamily: f }}>
            {f}
          </option>
        ))}
        <option value="__google">+ Add from Google Fonts…</option>
      </select>
      {missing &&
        (props.compact ? (
          <span
            className="tag amber"
            style={{ padding: '1px 5px', fontSize: 10 }}
            title="Not on the hub: outputs fall back to a system font"
            aria-label="Not on the hub: outputs fall back to a system font"
          >
            ⚠
          </span>
        ) : (
          <span className="tag amber" title="Not on the hub: outputs fall back to a system font">
            not on hub
          </span>
        ))}
      {search && (
        <GoogleFontsDialog
          onClose={() => setSearch(false)}
          onAdded={(family) => {
            props.onChange(family);
            setSearch(false);
          }}
        />
      )}
    </span>
  );
}

export function GoogleFontsDialog(props: { onClose: () => void; onAdded?: (family: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GoogleFontFamily[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [err, setErr] = useState<string>();
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await api<GoogleFontFamily[] | { families: GoogleFontFamily[] }>(
          `/fonts/google/search?q=${encodeURIComponent(q.trim())}`,
        );
        setResults(Array.isArray(r) ? r : r.families);
        setErr(undefined);
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const add = async (family: string) => {
    setAdding(family);
    try {
      const job = await api<Job | unknown>('/fonts/google', { method: 'POST', json: { family } });
      toast(`Adding ${family}: the hub is downloading it.`, 'info');
      if (job && typeof job === 'object' && 'id' in job) void waitJob((job as Job).id);
      props.onAdded?.(family);
    } catch (e) {
      toast(`Could not add ${family}: ${errorText(e)}`, 'error');
    } finally {
      setAdding(null);
    }
  };
  return (
    <Dialog title="Add a Google font" onClose={props.onClose} width={520}>
      <div className="col">
        <input
          autoFocus
          placeholder="Search Google Fonts (e.g. Montserrat)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="muted small">
          The hub downloads the font once and serves it locally; services never depend on Google.
        </span>
        {busy && <span className="muted">Searching…</span>}
        {err && <div className="banner red">{err}</div>}
        <div className="col" style={{ maxHeight: 360, overflow: 'auto' }}>
          {results.map((r) => (
            <div key={r.family} className="row">
              <span className="grow">
                {r.family} <span className="muted small">{r.category}</span>
              </span>
              <button
                type="button"
                className="small"
                disabled={adding !== null}
                onClick={() => add(r.family)}
              >
                {adding === r.family ? 'Adding…' : 'Add'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

async function waitJob(id: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const j = await api<Job>(`/jobs/${id}`);
      if (j.state === 'done') {
        toast('Font added.', 'ok');
        return;
      }
      if (j.state === 'failed') {
        toast(`Font download failed: ${j.error ?? 'unknown error'}`, 'error');
        return;
      }
    } catch {
      return;
    }
  }
}
