import { useState } from 'react';
import { SaveBar, useSettingsDraft } from './useSettingsDraft.tsx';

export function MessagesPage() {
  const { draft, setDraft, save, revert, saving, dirty } = useSettingsDraft('surfaces');
  const [text, setText] = useState('');
  const list = draft.messagePresets;
  const set = (messagePresets: string[]) => setDraft({ ...draft, messagePresets });
  return (
    <div className="col" style={{ gap: 12, maxWidth: 600 }}>
      <h2>Stage message presets</h2>
      <p className="muted" style={{ margin: 0 }}>
        One-click messages in the operator view; Stream Deck and MIDI send them by index (1 = first).
      </p>
      {list.map((m, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: positional list
        <div key={i} className="row">
          <span className="muted" style={{ width: 20 }}>
            {i + 1}
          </span>
          <input
            className="grow"
            value={m}
            onChange={(e) => set(list.map((x, k) => (k === i ? e.target.value : x)))}
          />
          <button
            type="button"
            className="small ghost"
            disabled={i === 0}
            onClick={() => set(list.map((x, k) => (k === i - 1 ? m : k === i ? list[i - 1]! : x)))}
          >
            ↑
          </button>
          <button type="button" className="small ghost" onClick={() => set(list.filter((_, k) => k !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="row">
        <input
          className="grow"
          placeholder="New preset"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          disabled={!text.trim()}
          onClick={() => {
            set([...list, text.trim()]);
            setText('');
          }}
        >
          Add
        </button>
      </div>
      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onRevert={revert} />
    </div>
  );
}
