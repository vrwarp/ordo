import { writeFile } from 'node:fs/promises';

export type SlideScore = {
  n: number;
  ssim: number;
  raw?: number;
  libreoffice: string;
  ppv?: string;
  rawPpv?: string;
};

export type DeckScore = {
  name: string;
  slides: number;
  ppvSlides: number;
  ssim: number;
  rawSsim?: number;
  ms: number;
  styled: number;
  notes: string[];
  perSlide: SlideScore[];
};

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** A static HTML report: decks worst first, each deck's slides worst first, pictures side by side. */
export async function writeReport(
  file: string,
  s: { createdAt: string; mean: number; decks: DeckScore[] },
): Promise<void> {
  const decks = [...s.decks].sort((a, b) => a.ssim - b.ssim);
  const img = (src: string | undefined, label: string) =>
    src
      ? `<figure><img loading="lazy" src="${esc(src)}" alt="${esc(label)}"><figcaption>${esc(label)}</figcaption></figure>`
      : `<figure class="missing"><div>not drawn</div><figcaption>${esc(label)}</figcaption></figure>`;
  const body = decks
    .map((d) => {
      const rows = [...d.perSlide]
        .sort((a, b) => a.ssim - b.ssim)
        .map(
          (p) =>
            `<section class="slide"><h3>Slide ${p.n} · ssim ${p.ssim.toFixed(3)}${p.raw !== undefined ? ` · unmodified ${p.raw.toFixed(3)}` : ''}</h3><div class="row">` +
            img(p.libreoffice, 'LibreOffice (ground truth)') +
            img(p.ppv, 'pptx-preview + ordo') +
            (p.raw !== undefined ? img(p.rawPpv, 'pptx-preview unmodified') : '') +
            '</div></section>',
        )
        .join('');
      const notes = d.notes.length
        ? `<ul class="notes">${d.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
        : '';
      return `<details${d === decks[0] ? ' open' : ''}><summary><b>${esc(d.name)}</b> · ${d.slides} slides · ssim ${d.ssim.toFixed(3)}${d.rawSsim !== undefined ? ` (unmodified ${d.rawSsim.toFixed(3)})` : ''} · ${d.styled} runs corrected · ${d.ms} ms</summary>${notes}${rows}</details>`;
    })
    .join('');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PowerPoint fidelity</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d}}
body{margin:0;padding:16px;font:14px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
details{border:1px solid var(--line);border-radius:8px;margin:0 0 12px;padding:8px 12px}
summary{cursor:pointer}.notes{color:var(--muted)}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px}
figure{margin:0}img{width:100%;border:1px solid var(--line)}figcaption{color:var(--muted);font-size:12px}
.missing div{aspect-ratio:16/9;display:grid;place-items:center;border:1px dashed var(--line)}
h3{font-size:14px;margin:16px 0 6px}
</style>
<h1>PowerPoint fidelity</h1>
<p>pptx-preview (with ordo's corrections) scored against LibreOffice, slide by slide: SSIM of greyscale pictures at 960×540, 1 = identical. Mean ${s.mean.toFixed(3)} · ${esc(s.createdAt)}</p>
${body}</html>`;
  await writeFile(file, html);
}
