/**
 * The hub console (docs/design/26-pages-demo.md, "Diagnostics"): a terminal on a root shell inside the demo's Linux
 * machine, for debugging the in-browser hub. Loaded only when someone opens it (vm-host.ts `showConsole`), so the
 * terminal (xterm.js) never weighs on the demo's start.
 */
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import css from '@xterm/xterm/css/xterm.css?inline';
import type { WorkerKernel } from 'unkernel/web';
import { VM_GUEST } from './vm-config.ts';

let styled = false;

/** Open the console over the page; resolves once it shows. Closing it ends the shell. */
export async function openConsole(kernel: WorkerKernel): Promise<void> {
  if (document.querySelector('[data-vm-console]')) return;
  if (!styled) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    styled = true;
  }
  const box = document.createElement('div');
  box.setAttribute('data-vm-console', '');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Hub console');
  box.style.cssText =
    'position: fixed; inset: 4vh 4vw; z-index: 2147483646; display: flex; flex-direction: column; background: #0d0f14; border: 1px solid #2a2e38; border-radius: 8px; box-shadow: 0 12px 48px rgba(0,0,0,0.6); font: 13px/1.4 system-ui, sans-serif; color: #e8e9ed;';
  const head = document.createElement('div');
  head.style.cssText =
    'display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #2a2e38;';
  const title = document.createElement('div');
  title.style.cssText = 'flex: 1;';
  title.innerHTML =
    '<b>Hub console</b> <span style="opacity: 0.6">· root shell in the Linux machine running the hub · logs in ' +
    `${VM_GUEST.dataDir}/hub.log</span>`;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Close';
  close.setAttribute('data-vm-console-close', '');
  close.style.cssText =
    'background: #2a2e38; color: inherit; border: 0; border-radius: 4px; padding: 4px 12px; cursor: pointer;';
  head.append(title, close);
  const screen = document.createElement('div');
  screen.style.cssText = 'flex: 1; min-height: 0; padding: 6px 8px;';
  box.append(head, screen);
  document.body.append(box);

  const term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0d0f14' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(screen);
  fit.fit();
  term.focus();

  const pty = await kernel.spawn(undefined, undefined, {
    user: 'root',
    cwd: VM_GUEST.dataDir,
    cols: term.cols,
    rows: term.rows,
  });
  const sub = term.onData((d) => void pty.write(d).catch(() => undefined));
  const reader = pty.output.getReader();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !value) break;
      term.write(value);
    }
  })();
  void pty.ended.then(() => term.write('\r\n\x1b[2m[the shell ended: close the console]\x1b[0m\r\n'));

  const onResize = () => {
    fit.fit();
    pty.resize(term.cols, term.rows);
  };
  addEventListener('resize', onResize);
  close.onclick = () => {
    removeEventListener('resize', onResize);
    sub.dispose();
    void pty.close().catch(() => undefined);
    term.dispose();
    box.remove();
  };
}
