/**
 * Soak test (docs/design/23-testing.md): goes live with a playlist, opens every enabled output window on
 * this machine, presses GO every N seconds for M minutes, samples each output's telemetry every second,
 * and writes soak-<date>.json and .md. Exit code 1 on failure.
 *
 *   pnpm soak --hub http://localhost:8080 --pin 123456 --playlist "Sunday" --minutes 60
 *
 * Run it on the presentation PC with a real GPU (headed, the default). --headless is for smoke runs.
 */
import { writeFileSync } from 'node:fs';
import { chromium, type Page } from 'playwright';
import { type Sample, type SoakReport, summarize, toMarkdown } from './report.ts';

type Args = {
  hub: string;
  pin: string;
  playlist: string;
  minutes: number;
  interval: number;
  headless: boolean;
  out: string;
};

function parseArgs(argv: string[]): Args {
  const get = (k: string, d?: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const hub = get('hub', process.env.ORDO_HUB ?? 'http://localhost:8080')!;
  return {
    hub: hub.replace(/\/$/, ''),
    pin: get('pin', process.env.ORDO_PIN ?? '')!,
    playlist: get('playlist', '')!,
    minutes: Number(get('minutes', '60')),
    interval: Number(get('interval', '10')),
    headless: argv.includes('--headless'),
    out: get('out', '.')!,
  };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.pin || !a.playlist) {
    console.error(
      'usage: soak --hub <origin> --pin <operate pin> --playlist <id or name> [--minutes 60] [--interval 10] [--headless]',
    );
    process.exit(2);
  }
  const browser = await chromium.launch({
    headless: a.headless,
    args: [
      '--enable-unsafe-webgpu',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const op = await ctx.newPage();
  await op.goto(a.hub + '/');
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await op.request.fetch(`${a.hub}/api/v1${path}`, {
      method,
      data: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    });
    if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${await r.text()}`);
    const ct = r.headers()['content-type'] ?? '';
    return (ct.includes('json') ? await r.json() : undefined) as T;
  };

  await api('POST', '/auth/pin', { pin: a.pin });
  const me = await api<{ domain: string }>('GET', '/auth/me');
  const snapshot = await api<{
    playlists: { id: string; name: string }[];
    settings: {
      outputs: {
        id: string;
        name: string;
        kind: string;
        hostIndex: number;
        enabled: boolean;
        token?: string;
      }[];
    };
  }>('GET', '/library/snapshot');
  const pl = snapshot.playlists.find((p) => p.id === a.playlist || p.name === a.playlist);
  if (!pl) throw new Error(`playlist ${a.playlist} not found`);

  const live = await api<{ state: { mode: string } }>('GET', '/live');
  if (live.state.mode === 'live')
    await api('POST', '/live/events', { id: 'soak-end', event: { k: 'endService', at: Date.now() } });
  await api('POST', '/live/events', { id: 'soak-golive', event: { k: 'goLive', playlistId: pl.id } });

  const hubUrl = new URL(a.hub);
  const outputs = snapshot.settings.outputs.filter((o) => o.enabled && o.kind !== 'stage' && o.token);
  const names = Object.fromEntries(outputs.map((o) => [o.id, o.name]));
  const pages: { id: string; page: Page }[] = [];
  for (const o of outputs) {
    const q = `output=${encodeURIComponent(o.id)}&token=${encodeURIComponent(o.token!)}`;
    const url = me.domain
      ? `${hubUrl.protocol}//out${o.hostIndex}.${me.domain}${hubUrl.port ? ':' + hubUrl.port : ''}/?${q}`
      : `${a.hub}/output/?${q}&out=${o.hostIndex}`;
    const page = await ctx.newPage();
    page.on('console', (m) => m.type() === 'error' && console.error(`[${o.name}] ${m.text()}`));
    await page.goto(url);
    pages.push({ id: o.id, page });
  }
  console.log(`opened ${pages.length} outputs; waiting for service cache…`);
  const deadline = Date.now() + 10 * 60_000;
  for (const { page } of pages) {
    await page.waitForFunction(
      () => {
        const o = (
          window as unknown as {
            __ordo?: { telemetry(): { cache?: { ready: number; total: number } }; state(): { mode: string } };
          }
        ).__ordo;
        const t = o?.telemetry();
        return o?.state().mode === 'live' && !!t?.cache && t.cache.ready >= t.cache.total;
      },
      undefined,
      { timeout: Math.max(1000, deadline - Date.now()), polling: 1000 },
    );
  }

  const samples: Sample[] = [];
  const startedAt = new Date().toISOString();
  const end = Date.now() + a.minutes * 60_000;
  let gos = 0;
  let nextGo = Date.now();
  console.log(`running for ${a.minutes} minutes, GO every ${a.interval} s`);
  while (Date.now() < end) {
    if (Date.now() >= nextGo) {
      const st = await api<{ state: { live?: number; cues: unknown[] } }>('GET', '/live');
      if (st.state.live !== undefined && st.state.live >= st.state.cues.length - 1)
        await api('POST', '/live/events', {
          id: `soak-wrap-${gos}`,
          event: { k: 'go', cueIndex: 0, at: Date.now() + 50 },
        });
      else await api('POST', '/actions', { id: 'next' });
      gos++;
      nextGo += a.interval * 1000;
    }
    for (const { id, page } of pages) {
      const t = await page
        .evaluate(() =>
          (window as unknown as { __ordo?: { telemetry(): Record<string, unknown> } }).__ordo?.telemetry(),
        )
        .catch(() => undefined);
      if (!t) continue;
      const n = (k: string) => Number(t[k] ?? 0);
      samples.push({
        t: Date.now(),
        outputId: id,
        presented: n('presented'),
        missed: n('missed'),
        longTasks: n('longTasks'),
        lateFlips: n('lateFlips'),
        gpuLost: n('gpuLost'),
        videoDropped: n('videoDropped'),
        error: typeof t.error === 'string' ? t.error : undefined,
      });
    }
    process.stdout.write(`\r${Math.ceil((end - Date.now()) / 1000)} s left, ${gos} GOs   `);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('');
  const summary = summarize(samples, names);
  const report: SoakReport = {
    startedAt,
    minutes: a.minutes,
    gos,
    outputs: summary,
    pass: summary.length > 0 && summary.every((o) => o.pass),
  };
  const stamp = startedAt.replace(/[:.]/g, '-');
  writeFileSync(`${a.out}/soak-${stamp}.json`, JSON.stringify({ report, samples }, null, 2));
  writeFileSync(`${a.out}/soak-${stamp}.md`, toMarkdown(report));
  console.log(toMarkdown(report));
  await api('POST', '/live/events', { id: 'soak-end', event: { k: 'endService', at: Date.now() } }).catch(
    () => undefined,
  );
  await browser.close();
  process.exit(report.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
