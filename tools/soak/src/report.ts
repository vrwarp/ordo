/** Pure soak-report logic, unit tested. */
export type Sample = {
  t: number;
  outputId: string;
  presented: number;
  missed: number;
  longTasks: number;
  lateFlips: number;
  gpuLost: number;
  videoDropped: number;
  error?: string;
};

export type OutputSummary = {
  outputId: string;
  name: string;
  presented: number;
  missed: number;
  longTasks: number;
  lateFlips: number;
  gpuLost: number;
  videoDropped: number;
  samples: number;
  errors: string[];
  pass: boolean;
};

export type SoakReport = {
  startedAt: string;
  minutes: number;
  gos: number;
  outputs: OutputSummary[];
  pass: boolean;
};

/** Counters are cumulative per window; a window reload resets them, so sum positive deltas. */
export function summarize(samples: Sample[], names: Record<string, string>): OutputSummary[] {
  const by = new Map<string, Sample[]>();
  for (const s of samples) by.set(s.outputId, [...(by.get(s.outputId) ?? []), s]);
  const out: OutputSummary[] = [];
  for (const [outputId, list] of by) {
    list.sort((a, b) => a.t - b.t);
    const acc = { presented: 0, missed: 0, longTasks: 0, lateFlips: 0, gpuLost: 0, videoDropped: 0 };
    const keys = Object.keys(acc) as (keyof typeof acc)[];
    let prev: Sample | undefined;
    const errors = new Set<string>();
    for (const s of list) {
      if (s.error) errors.add(s.error);
      for (const k of keys) {
        const d = prev ? s[k] - prev[k] : 0;
        // A negative delta means the window restarted: count its fresh value instead.
        acc[k] += d >= 0 ? d : s[k];
      }
      prev = s;
    }
    const pass = acc.missed === 0 && acc.longTasks === 0 && acc.gpuLost === 0 && acc.presented > 0;
    out.push({ outputId, name: names[outputId] ?? outputId, ...acc, samples: list.length, errors: [...errors], pass });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function toMarkdown(r: SoakReport): string {
  const rows = r.outputs
    .map(
      (o) =>
        `| ${o.name} | ${o.presented} | ${o.missed} | ${o.longTasks} | ${o.lateFlips} | ${o.gpuLost} | ${o.videoDropped} | ${o.pass ? 'PASS' : 'FAIL'} |`,
    )
    .join('\n');
  const errs = r.outputs.flatMap((o) => o.errors.map((e) => `- ${o.name}: ${e}`)).join('\n');
  return `# Soak test ${r.pass ? 'PASSED' : 'FAILED'}

Started ${r.startedAt}, ran ${r.minutes} minutes, ${r.gos} GOs.

| Output | Frames presented | Missed frames | Long tasks | Late flips | GPU losses | Video frames dropped | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}
${errs ? `\n## Errors reported\n\n${errs}\n` : ''}
A pass requires zero missed frames, zero long tasks and zero GPU losses on every output (docs/prd/08-reliability.md).
`;
}
