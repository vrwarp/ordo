import { describe, expect, it } from 'vitest';
import {
  type PhonesSummary,
  phonesPass,
  type SoakReport,
  summarize,
  toMarkdown,
  videoWaited,
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
