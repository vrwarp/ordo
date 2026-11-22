import { create } from 'zustand';
import { Dialog } from './Dialog.tsx';

export type ChoiceOption<T extends string = string> = {
  value: T;
  label: string;
  tone?: 'primary' | 'danger' | 'default';
  disabled?: boolean;
  autoFocus?: boolean;
};

type Ask = {
  title: string;
  text: string;
  choices: ChoiceOption[];
  cancelValue?: string;
  width?: number;
  resolve: (v: string) => void;
};

const useConfirm = create<{ ask?: Ask }>(() => ({}));

/** Promise-based confirm dialog. */
export function confirmDialog(title: string, text: string, ok = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) =>
    useConfirm.setState({
      ask: {
        title,
        text,
        cancelValue: 'cancel',
        choices: [
          { value: 'cancel', label: 'Cancel' },
          { value: 'ok', label: ok, tone: danger ? 'danger' : 'primary', autoFocus: true },
        ],
        resolve: (v) => resolve(v === 'ok'),
      },
    }),
  );
}

/**
 * Promise-based multi-action choice dialog (e.g. Save / Discard / Keep draft / Cancel).
 * When `cancelValue` is omitted, Escape and clicking outside do not dismiss the dialog.
 */
export function choiceDialog<T extends string>(opts: {
  title: string;
  text: string;
  choices: ChoiceOption<T>[];
  cancelValue?: T;
  width?: number;
}): Promise<T> {
  return new Promise((resolve) =>
    useConfirm.setState({
      ask: {
        title: opts.title,
        text: opts.text,
        choices: opts.choices,
        cancelValue: opts.cancelValue,
        width: opts.width,
        resolve: (v) => resolve(v as T),
      },
    }),
  );
}

export function ConfirmHost() {
  const ask = useConfirm((s) => s.ask);
  if (!ask) return null;
  const done = (v: string) => {
    useConfirm.setState({ ask: undefined });
    ask.resolve(v);
  };
  return (
    <Dialog
      title={ask.title}
      width={ask.width}
      onClose={ask.cancelValue !== undefined ? () => done(ask.cancelValue!) : undefined}
      footer={ask.choices.map((c) => (
        <button
          key={c.value}
          type="button"
          className={c.tone === 'danger' ? 'danger' : c.tone === 'primary' ? 'primary' : undefined}
          disabled={c.disabled}
          autoFocus={c.autoFocus}
          onClick={() => done(c.value)}
        >
          {c.label}
        </button>
      ))}
    >
      <p style={{ whiteSpace: 'pre-line', margin: 0 }}>{ask.text}</p>
    </Dialog>
  );
}
