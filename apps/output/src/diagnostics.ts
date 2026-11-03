/**
 * Diagnostics overlay (Ctrl+Shift+D): a DOM text layer over the canvas showing the output's counters,
 * arm state and recent log lines. Also the plain diagnostic page shown when no frame was ever presented.
 */
export class Diagnostics {
  private el: HTMLDivElement;
  private pre: HTMLPreElement;
  private timer?: ReturnType<typeof setInterval>;
  private lines: string[] = [];
  visible = false;

  constructor(private snapshot: () => Record<string, unknown>) {
    this.el = document.createElement('div');
    this.el.className = 'diag';
    this.el.hidden = true;
    this.pre = document.createElement('pre');
    this.el.appendChild(this.pre);
    document.body.appendChild(this.el);
  }

  log(line: string): void {
    const t = new Date().toISOString().slice(11, 23);
    this.lines.push(`${t} ${line}`);
    if (this.lines.length > 50) this.lines.shift();
  }

  get recent(): string[] {
    return [...this.lines];
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.hidden = !this.visible;
    clearInterval(this.timer);
    if (this.visible) {
      this.render();
      this.timer = setInterval(() => this.render(), 500);
    }
  }

  /** The page shown instead of the canvas when nothing could ever be presented. */
  showFatal(title: string, detail: string): void {
    this.el.hidden = false;
    this.el.classList.add('fatal');
    this.pre.textContent = `${title}\n\n${detail}\n\n${this.lines.slice(-20).join('\n')}`;
  }

  private render(): void {
    const s = this.snapshot();
    const rows = Object.entries(s).map(([k, v]) => `${k.padEnd(18)} ${typeof v === 'string' ? v : JSON.stringify(v)}`);
    this.pre.textContent = `ordo output — Ctrl+Shift+D to hide, Ctrl+Shift+Q to close\n\n${rows.join('\n')}\n\nlog:\n${this.lines.slice(-15).join('\n')}`;
  }
}
