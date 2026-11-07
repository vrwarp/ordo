import type { OutputHealthEntry } from '@ordo/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

/**
 * The diagnostics view's performance and fonts table (design/27 §13, M7): figures against the budgets of each
 * output's size, an alarm shown in amber, and every issue in plain words with its figures beside it.
 */

const entry = (p: Partial<OutputHealthEntry>): OutputHealthEntry => ({
  outputId: 'o1',
  connected: true,
  lastSeen: Date.now(),
  presented: 1,
  missed: 0,
  longTasks: 0,
  lateFlips: 0,
  cache: { ready: 1, total: 1 },
  gpuLost: 0,
  videoDropped: 0,
  ...p,
});

describe('performance and fonts in the diagnostics view', () => {
  it('shows each output against its budgets, with the issues in words', async () => {
    const { useLibrary } = await import('../src/state/library.ts');
    const { useLive } = await import('../src/state/live.ts');
    const { PerformanceTable } = await import('../src/views/live/DiagnosticsPanel.tsx');
    const data = useLibrary.getState().data;
    const outputs = [
      { ...data.settings.outputs[0], id: 'o1', name: 'Audience 4K', enabled: true },
      { ...data.settings.outputs[0], id: 'o2', name: 'Lobby', enabled: true },
    ] as typeof data.settings.outputs;
    const lib = { data: { ...data, settings: { ...data.settings, outputs } } };
    Object.assign(useLibrary.getInitialState(), lib);
    useLibrary.setState(lib);
    const health = {
      o1: entry({
        compositor: 'webgpu',
        gpuMB: 412.4,
        uploadMs: 2.5,
        rasterMs: { n: 40, p50: 12, p95: 18, max: 30 },
        budgets: { rasterP95Ms: 30, uploadMs: 4, gpuMB: 400 },
        alarms: ['gpuMemory'],
        fontCoverage: { chars: '☧', count: 1, scripts: ['Zyyy'] },
      }),
      o2: entry({ outputId: 'o2', compositor: '2d', budgets: { rasterP95Ms: 10, uploadMs: 4, gpuMB: 100 } }),
    };
    Object.assign(useLive.getInitialState(), { health });
    useLive.setState({ health });
    const html = renderToStaticMarkup(createElement(PerformanceTable));
    const row = (id: string) => html.split(`data-performance-output="${id}"`)[1]!.split('</tr>')[0]!;
    const a = row('o1');
    expect(a).toContain('12 / 18 ms');
    expect(a).toContain('(p95 ≤ 30 ms)');
    expect(a).toContain('2.5 ms');
    expect(a).toMatch(/color:var\(--amber\)">412.4 MB/);
    expect(a).toContain('(≤ 400 MB)');
    expect(a).toContain('1 character(s) without a font');
    expect(a).toContain('data-issue="gpuMemory"');
    expect(a).toContain('The graphics card of this screen is nearly out of memory');
    expect(a).toContain('GPU memory 412.4 MB, budget 400 MB');
    expect(a).toContain('data-issue="fontCoverage"');
    const b = row('o2');
    expect(b).toContain('none (2D)');
    expect(b).toContain('>ok<');
    expect(b).not.toContain('data-issue');
  });
});
