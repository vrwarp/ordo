import type { ActionId, StreamDeckKey, StreamDeckPage as DeckPage } from '@ordo/domain';
import { defaultDeckPages, PAGE_KEY_PREFIX } from '@ordo/surfaces';
import { useState } from 'react';
import { keyed } from '../../lib/keys.ts';
import { Select } from '../../components/fields.tsx';
import { surfaces, useSurfaces } from '../../services/surfaces.ts';
import { errorText, toast } from '../../state/toasts.ts';
import { ACTION_OPTIONS, ACTIONS_WITH_ARG, actionText, parseArg } from './actions.ts';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

type KeyMode = 'none' | 'action' | 'section' | 'nextItem' | 'page';

function modeOf(k: StreamDeckKey | undefined): KeyMode {
  if (!k) return 'none';
  if (k.dynamic) return k.dynamic;
  if (k.action) return 'action';
  if (k.label?.startsWith(PAGE_KEY_PREFIX)) return 'page';
  return 'none';
}

function keyText(k: StreamDeckKey | undefined): string {
  if (!k) return '';
  if (k.label) return k.label;
  if (k.dynamic === 'section') return `Section ${(k.dynamicIndex ?? 0) + 1}`;
  if (k.dynamic === 'nextItem') return `Next item ${(k.dynamicIndex ?? 0) + 1}`;
  return actionText(k.action);
}

/** Stream Deck connect and page/key mapping editor (prd/07, design/19). */
export function StreamDeckPage() {
  const { draft, setDraft, save, revert, saving, dirty } = useSettingsDraft('surfaces');
  const deck = useSurfaces((s) => s.deck);
  const keys = deck?.keys ?? 15;
  const cols = deck?.columns ?? 5;
  const pages: DeckPage[] = draft.streamDeckPages.length ? draft.streamDeckPages : [];
  const [pi, setPi] = useState(0);
  const [ki, setKi] = useState<number | null>(null);
  const page = pages[pi];
  const setPages = (p: DeckPage[]) => setDraft({ ...draft, streamDeckPages: p });
  const setKey = (k: StreamDeckKey | undefined) => {
    if (!page || ki === null) return;
    const keysObj = { ...page.keys };
    if (k) keysObj[String(ki)] = k;
    else delete keysObj[String(ki)];
    setPages(pages.map((p, i) => (i === pi ? { ...p, keys: keysObj } : p)));
  };
  const cur = page && ki !== null ? page.keys[String(ki)] : undefined;
  const mode = modeOf(cur);
  return (
    <div className="col" style={{ gap: 12 }}>
      <h2>Stream Deck</h2>
      <div className="row">
        <button
          type="button"
          className="primary"
          onClick={async () => {
            try {
              const info = await surfaces()?.connectDeck();
              if (info) toast(`Connected ${info.model}.`, 'ok');
            } catch (e) {
              toast(errorText(e), 'error');
            }
          }}
        >
          {deck ? 'Connect another' : 'Connect Stream Deck'}
        </button>
        <span className="muted">
          {deck
            ? `${deck.model}: ${deck.keys} keys, ${deck.dials} dials`
            : 'No deck connected (editing for a 15-key deck).'}
        </span>
      </div>
      <div className="row wrap">
        {keyed(pages, (p) => p.name).map(({ key, value: p }, i) => (
          <button
            key={key}
            type="button"
            className={i === pi ? 'on' : ''}
            onClick={() => {
              setPi(i);
              setKi(null);
            }}
          >
            {p.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPages([...pages, { name: `Page ${pages.length + 1}`, keys: {} }])}
        >
          + Page
        </button>
        <button
          type="button"
          onClick={() => {
            setPages(defaultDeckPages(keys));
            setPi(0);
            setKi(null);
          }}
        >
          Load defaults for this deck
        </button>
      </div>
      {!pages.length && (
        <span className="muted">Using the built-in default pages. Load the defaults to customise them.</span>
      )}
      {page && (
        <div className="row" style={{ alignItems: 'flex-start', gap: 20 }}>
          <div className="col">
            <div className="row">
              <input
                value={page.name}
                onChange={(e) =>
                  setPages(pages.map((p, i) => (i === pi ? { ...p, name: e.target.value } : p)))
                }
              />
              <button
                type="button"
                className="small danger"
                onClick={() => {
                  setPages(pages.filter((_, i) => i !== pi));
                  setPi(0);
                }}
              >
                Delete page
              </button>
            </div>
            <div className="deck-grid" style={{ gridTemplateColumns: `repeat(${cols}, 72px)` }}>
              {Array.from({ length: keys }, (_, n) => n).map((i) => {
                const k = page.keys[String(i)];
                return (
                  <div
                    key={`key-${i}`}
                    className={`deck-key ${ki === i ? 'sel' : ''}`}
                    style={{ background: k?.color ?? '#111' }}
                    onClick={() => setKi(i)}
                  >
                    {keyText(k)}
                  </div>
                );
              })}
            </div>
          </div>
          {ki !== null && (
            <div className="card col" style={{ width: 340 }}>
              <b>Key {ki + 1}</b>
              <Select
                label="Key does"
                value={mode}
                options={[
                  { value: 'none', label: 'Nothing' },
                  { value: 'action', label: 'An action' },
                  { value: 'section', label: 'Live section N (highlighted when live)' },
                  { value: 'nextItem', label: 'Upcoming playlist item N' },
                  { value: 'page', label: 'Switch page' },
                ]}
                onChange={(m) => {
                  if (m === 'none') setKey(undefined);
                  else if (m === 'action') setKey({ action: { id: 'next' }, color: cur?.color });
                  else if (m === 'page') setKey({ label: `${PAGE_KEY_PREFIX}next`, color: cur?.color });
                  else setKey({ dynamic: m, dynamicIndex: 0, color: cur?.color });
                }}
              />
              {mode === 'action' && cur?.action && (
                <>
                  <Select
                    label="Action"
                    value={cur.action.id}
                    options={ACTION_OPTIONS}
                    onChange={(id: ActionId) => setKey({ ...cur, action: { id } })}
                  />
                  {ACTIONS_WITH_ARG.has(cur.action.id) && (
                    <label className="field">
                      <span>Argument</span>
                      <input
                        defaultValue={cur.action.arg ?? ''}
                        onBlur={(e) =>
                          setKey({
                            ...cur,
                            action: { id: cur.action!.id, arg: parseArg(cur.action!.id, e.target.value) },
                          })
                        }
                      />
                    </label>
                  )}
                  <label className="field">
                    <span>Label (optional)</span>
                    <input
                      value={cur.label ?? ''}
                      onChange={(e) => setKey({ ...cur, label: e.target.value || undefined })}
                    />
                  </label>
                </>
              )}
              {(mode === 'section' || mode === 'nextItem') && cur && (
                <label className="field">
                  <span>Index (1 = first)</span>
                  <input
                    type="number"
                    min={1}
                    value={(cur.dynamicIndex ?? 0) + 1}
                    onChange={(e) =>
                      setKey({ ...cur, dynamicIndex: Math.max(0, Number(e.target.value) - 1) })
                    }
                  />
                </label>
              )}
              {mode === 'page' && cur && (
                <label className="field">
                  <span>Target page</span>
                  <select
                    value={cur.label?.slice(PAGE_KEY_PREFIX.length) ?? 'next'}
                    onChange={(e) => setKey({ ...cur, label: `${PAGE_KEY_PREFIX}${e.target.value}` })}
                  >
                    <option value="next">Next page</option>
                    {pages.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {cur && (
                <label className="field">
                  <span>Colour</span>
                  <input
                    type="color"
                    value={cur.color ?? '#222222'}
                    onChange={(e) => setKey({ ...cur, color: e.target.value })}
                  />
                </label>
              )}
            </div>
          )}
        </div>
      )}
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onRevert={revert} />
    </div>
  );
}
