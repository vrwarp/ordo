/**
 * The page of menuDialog.browser.test.ts: a Menu inside a Dialog, as the operator mounts them, with the live
 * KeyboardDriver attached and blocked while a modal is open (services/surfaces.ts). Since #26 the Menu's list is
 * portalled to the body, outside the dialog's box. `window.__mount(variant)` renders it: 'footer' puts an OK
 * after the menu's trigger, 'last' makes the trigger the dialog's last control, 'colour' adds a colour pill
 * (its picker is portalled to the body too), and 'page' starts with the dialog closed and puts a Menu and a colour
 * pill of the page behind it, for `window.__openDialog()` to open the dialog over them (a key or the hub can open
 * one with no click first). `window.__log` collects what was picked, the dialog closing and any live action.
 */
import { DEFAULT_KEYMAP } from '@ordo/domain';
import { KeyboardDriver } from '@ordo/surfaces';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ColorPill } from '../src/components/ColorPicker.tsx';
import { Dialog } from '../src/components/Dialog.tsx';
import { modalOpen } from '../src/components/dialogEscape.ts';
import { Menu } from '../src/components/Menu.tsx';

type Variant = 'footer' | 'last' | 'colour' | 'page';

declare global {
  interface Window {
    __log: string[];
    __mount: (variant: Variant) => void;
    __openDialog: () => void;
  }
}

window.__log = [];
const log = (s: string) => window.__log.push(s);

const keys = new KeyboardDriver(DEFAULT_KEYMAP, (a) => log(`live:${a.id}`), { blocked: modalOpen });
keys.attach(window);

function Page({ variant }: { variant: Variant }) {
  const [open, setOpen] = useState(variant !== 'page');
  window.__openDialog = () => setOpen(true);
  const [colour, setColour] = useState({ r: 0x33, g: 0x66, b: 0x99, a: 1 });
  const pick = (name: string) => () => log(`pick:${name}`);
  return (
    <>
      <button type="button" onClick={() => log('pressed:Clear all')}>
        Clear all
      </button>
      {variant === 'page' && (
        <>
          <Menu
            label="Page menu"
            items={[
              { label: 'Page one', onSelect: pick('Page one') },
              { label: 'Page two', onSelect: pick('Page two') },
            ]}
          />
          <ColorPill value={colour} onChange={setColour} />
        </>
      )}
      {open && (
        <Dialog
          title="Arrange"
          onClose={() => {
            log('dialog closed');
            setOpen(false);
          }}
          footer={
            variant === 'footer' ? (
              <button type="button" onClick={() => log('pressed:OK')}>
                OK
              </button>
            ) : undefined
          }
        >
          <button type="button" onClick={() => log('pressed:Before')}>
            Before
          </button>
          <Menu
            label="Layer"
            items={[
              { label: 'Bring to front', onSelect: pick('Bring to front') },
              { label: 'Locked', disabled: true, onSelect: pick('Locked') },
              { label: 'Send backward', onSelect: pick('Send backward') },
              { label: 'Send to back', onSelect: pick('Send to back') },
            ]}
          />
          {variant === 'colour' && <ColorPill value={colour} onChange={setColour} />}
        </Dialog>
      )}
    </>
  );
}

let root: ReturnType<typeof createRoot> | undefined;
window.__mount = (variant) => {
  root?.unmount();
  window.__log = [];
  const el = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
  el.id = 'app';
  root = createRoot(el);
  root.render(<Page variant={variant} />);
};
