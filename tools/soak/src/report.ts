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

/**
 * The phones phase (`--phones N`, design/28 §5.3 and §9): N phones signed in with a cap, each with one socket
 * and the Live now poll; optional uploads during the service. `waited`: the video stayed `uploaded` (its job
 * waiting for the service) for as long as the service ran; `outputConfigFetches`: config requests the outputs
 * made during the phones phase (a phone's upload must make none); `refused`: phone requests the hub answered
 * with an error.
 */
export type PhonesSummary = {
  phones: number;
  capped: boolean;
  requests: number;
  refused: number;
  outputConfigFetches: number;
  video?: { mb: number; waited: boolean; states: string[] };
  photo?: { state: string };
};

/** When the phones' uploads ran (ms since the epoch); `end` unset while they still run. */
export type UploadWindow = { start: number; end?: number };

/** What an output missed while the uploads ran (design/28 §9: zero missed frames during the upload). */
export type WindowSummary = {
  outputId: string;
  name: string;
  missed: number;
  lateFlips: number;
  longTasks: number;
  videoDropped: number;
  pass: boolean;
};

export type SoakReport = {
  startedAt: string;
  minutes: number;
  gos: number;
  outputs: OutputSummary[];
  phones?: PhonesSummary;
  uploads?: { window: UploadWindow; outputs: WindowSummary[] };
  pass: boolean;
};

/**
 * The counters each output added between two of its samples whose span meets the window (a span that ends
 * after the window starts and starts before it ends): what it missed while the files were uploaded, counted
 * from the sample before the window, so frames missed between that sample and the next are in.
 */
export function inWindow(
  samples: readonly Sample[],
  names: Record<string, string>,
  w: UploadWindow,
): WindowSummary[] {
  const end = w.end ?? Number.POSITIVE_INFINITY;
  const by = new Map<string, Sample[]>();
  for (const s of samples) by.set(s.outputId, [...(by.get(s.outputId) ?? []), s]);
  const out: WindowSummary[] = [];
  for (const [outputId, list] of by) {
    list.sort((a, b) => a.t - b.t);
    const acc = { missed: 0, lateFlips: 0, longTasks: 0, videoDropped: 0 };
    const keys = Object.keys(acc) as (keyof typeof acc)[];
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const s = list[i]!;
      if (s.t < w.start || prev.t > end) continue;
      for (const k of keys) {
        const d = s[k] - prev[k];
        acc[k] += d >= 0 ? d : s[k];
      }
    }
    out.push({
      outputId,
      name: names[outputId] ?? outputId,
      ...acc,
      pass: acc.missed === 0 && acc.lateFlips === 0,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The upload window passes with no missed and no late frame on any output. */
export function windowPass(outputs: readonly WindowSummary[]): boolean {
  return outputs.length > 0 && outputs.every((o) => o.pass);
}

/** The phones phase passes with no config refetch, no refused request, and the video held for the service. */
export function phonesPass(p: PhonesSummary | undefined): boolean {
  if (!p) return true;
  return p.outputConfigFetches === 0 && p.refused === 0 && (p.video ? p.video.waited : true);
}

/** Whether the video stayed uploaded for every sample taken while the service was live. */
export function videoWaited(states: readonly string[]): boolean {
  return states.length > 0 && states.every((s) => s === 'uploaded');
}

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
    out.push({
      outputId,
      name: names[outputId] ?? outputId,
      ...acc,
      samples: list.length,
      errors: [...errors],
      pass,
    });
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
  const p = r.phones;
  const phones = p
    ? `
## Phones

${p.phones} phone(s), ${p.capped ? 'capped sessions' : 'uncapped (the hub grants no caps)'}: ${p.requests} requests, ${p.refused} refused. Output config requests during the phones phase: ${p.outputConfigFetches}.${p.video ? ` Video (${p.video.mb} MB): ${p.video.waited ? 'waited for the service' : 'did NOT wait for the service'} (${p.video.states.join(', ')}).` : ''}${p.photo ? ` Photo: ${p.photo.state}.` : ''} ${phonesPass(p) ? 'PASS' : 'FAIL'}
`
    : '';
  const u = r.uploads;
  const uploads = u
    ? `
## While the phones uploaded

${Math.round(((u.window.end ?? u.window.start) - u.window.start) / 1000)} s. ${u.outputs
        .map(
          (o) =>
            `${o.name}: ${o.missed} missed, ${o.lateFlips} late, ${o.longTasks} long tasks${o.pass ? '' : ' (FAIL)'}`,
        )
        .join('; ')}. ${windowPass(u.outputs) ? 'PASS' : 'FAIL'}
`
    : '';
  return `# Soak test ${r.pass ? 'PASSED' : 'FAILED'}

Started ${r.startedAt}, ran ${r.minutes} minutes, ${r.gos} GOs.

| Output | Frames presented | Missed frames | Long tasks | Late flips | GPU losses | Video frames dropped | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows}
${errs ? `\n## Errors reported\n\n${errs}\n` : ''}${phones}${uploads}
A pass requires zero missed frames, zero long tasks and zero GPU losses on every output (docs/prd/08-reliability.md)${p ? ', and in the phones phase no output config request, no refused phone request and a video that waited for the service (design/28 §9)' : ''}${u ? ', and no missed or late frame while the phones uploaded' : ''}.
`;
}
