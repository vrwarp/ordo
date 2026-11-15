import { describe, expect, it } from 'vitest';
import {
  inWindow,
  type PhonesSummary,
  phonesPass,
  type SoakReport,
  summarize,
  toMarkdown,
  videoWaited,
  windowPass,
} from './report.ts';

const s = (t: number, presented: number, missed = 0, longTasks = 0) => ({
  t,
  outputId: 'o1',
  presented,
  missed,
  longTasks,
  lateFlips: 0,
  gpuLost: 0,
  videoDropped: 0,
});

describe('soak summary', () => {
  it('sums deltas and survives counter resets', () => {
    const [r] = summarize([s(1, 0), s(2, 60), s(3, 120, 1), s(4, 30, 1), s(5, 90, 1)], { o1: 'Audience 1' });
    expect(r).toMatchObject({ name: 'Audience 1', presented: 210, missed: 1, pass: false });
  });
  it('passes a clean run', () => {
    const [r] = summarize([s(1, 0), s(2, 60), s(3, 120)], {});
    expect(r!.pass).toBe(true);
  });
});

describe('the phones phase (design/28 §5.3, §9)', () => {
  const phones = (p: Partial<PhonesSummary> = {}): PhonesSummary => ({
    phones: 3,
    capped: true,
    requests: 40,
    refused: 0,
    outputConfigFetches: 0,
    video: { mb: 50, waited: true, states: ['uploaded'] },
    photo: { state: 'ready' },
    ...p,
  });
  it('passes with no config refetch, no refused request and a video that waited', () => {
    expect(phonesPass(undefined)).toBe(true);
    expect(phonesPass(phones())).toBe(true);
    expect(phonesPass(phones({ outputConfigFetches: 1 }))).toBe(false);
    expect(phonesPass(phones({ refused: 2 }))).toBe(false);
    expect(phonesPass(phones({ video: { mb: 50, waited: false, states: ['processing'] } }))).toBe(false);
    expect(phonesPass(phones({ video: undefined }))).toBe(true);
  });
  it('a video waited when every sample while live was uploaded', () => {
    expect(videoWaited(['uploaded', 'uploaded'])).toBe(true);
    expect(videoWaited(['uploaded', 'processing'])).toBe(false);
    expect(videoWaited([])).toBe(false);
  });
  it('the Markdown report says it', () => {
    const r: SoakReport = { startedAt: 't', minutes: 2, gos: 12, outputs: [], phones: phones(), pass: true };
    const md = toMarkdown(r);
    expect(md).toContain('## Phones');
    expect(md).toContain('3 phone(s), capped sessions: 40 requests, 0 refused');
    expect(md).toContain('Output config requests during the phones phase: 0');
    expect(md).toContain('Video (50 MB): waited for the service');
    expect(toMarkdown({ ...r, phones: undefined })).not.toContain('## Phones');
  });
});

/**
 * Review of P0: the samples started after the phones signed in and after the whole video upload, so the frames
 * the outputs missed meanwhile were never counted. The outputs are sampled once before the phones (the
 * baseline), and the uploads run beside the loop with their window reported on its own.
 */
describe('the baseline and the upload window', () => {
  const at = (t: number, missed: number, lateFlips = 0, outputId = 'o1') => ({
    t,
    outputId,
    presented: t * 60,
    missed,
    longTasks: 0,
    lateFlips,
    gpuLost: 0,
    videoDropped: 0,
  });
  it('frames missed between the baseline sample and the first loop sample are counted', () => {
    // The baseline at t 0 (before the phones), the first loop sample at t 40 (after sign-ins and a long upload).
    const [r] = summarize([at(0, 0), at(40, 7), at(41, 7)], {});
    expect(r).toMatchObject({ missed: 7, pass: false });
    // Without the baseline (as before) the first sample counted nothing: the run passed.
    const [before] = summarize([at(40, 7), at(41, 7)], {});
    expect(before).toMatchObject({ missed: 0, pass: true });
  });
  it('the window counts what was missed or late while the files were uploaded, and fails on any', () => {
    const samples = [at(0, 0), at(10, 0), at(20, 3, 1), at(30, 3, 1), at(40, 5, 1), at(50, 5, 1)];
    const w = inWindow(samples, { o1: 'Audience 1' }, { start: 12, end: 25 });
    // The span 10..20 meets the window (3 missed, 1 late), 20..30 too (none); 30..40 is after it.
    expect(w).toEqual([
      {
        outputId: 'o1',
        name: 'Audience 1',
        missed: 3,
        lateFlips: 1,
        longTasks: 0,
        videoDropped: 0,
        pass: false,
      },
    ]);
    expect(windowPass(w)).toBe(false);
    const clean = inWindow(samples, {}, { start: 41, end: 49 });
    expect(clean[0]).toMatchObject({ missed: 0, lateFlips: 0, pass: true });
    expect(windowPass(clean)).toBe(true);
    expect(windowPass([])).toBe(false);
    // Still running: up to the last sample.
    expect(inWindow(samples, {}, { start: 31 })[0]).toMatchObject({ missed: 2 });
  });
  it('the Markdown report has the window', () => {
    const r: SoakReport = {
      startedAt: 't',
      minutes: 2,
      gos: 12,
      outputs: [],
      uploads: {
        window: { start: 0, end: 90_000 },
        outputs: [
          {
            outputId: 'o1',
            name: 'Audience 1',
            missed: 0,
            lateFlips: 0,
            longTasks: 0,
            videoDropped: 0,
            pass: true,
          },
        ],
      },
      pass: true,
    };
    const md = toMarkdown(r);
    expect(md).toContain('## While the phones uploaded');
    expect(md).toContain('90 s. Audience 1: 0 missed, 0 late, 0 long tasks. PASS');
    expect(md).toContain('no missed or late frame while the phones uploaded');
  });
});
