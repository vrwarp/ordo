import { create } from 'zustand';
import { Dialog } from './Dialog.tsx';

type Ask = {
  title: string;
  text: string;
  ok: string;
  danger?: boolean;
  resolve: (v: boolean) => void;
};
const useConfirm = create<{ ask?: Ask }>(() => ({}));

/** Promise-based confirm dialog. */
export function confirmDialog(title: string, text: string, ok = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ ask: { title, text, ok, danger, resolve } }));
}

export function ConfirmHost() {
  const ask = useConfirm((s) => s.ask);
  if (!ask) return null;
  const done = (v: boolean) => {
    useConfirm.setState({ ask: undefined });
    ask.resolve(v);
  };
  return (
    <Dialog
      title={ask.title}
      onClose={() => done(false)}
      footer={
        <>
          <button type="button" onClick={() => done(false)}>
            Cancel
          </button>
          <button type="button" className={ask.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>
            {ask.ok}
          </button>
        </>
      }
    >
      <p style={{ whiteSpace: 'pre-line', margin: 0 }}>{ask.text}</p>
    </Dialog>
  );
}
