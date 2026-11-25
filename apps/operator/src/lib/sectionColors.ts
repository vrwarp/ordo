/**
 * Deterministic ProPresenter-style section accent colors for slide bands and arrangement chips
 * (design/30 §5.1). Pure helper with no DOM or controller imports so it stays compact-safe.
 */
export type SectionTone = {
  bg: string;
  fg: string;
  border: string;
};

const TONES: Record<string, SectionTone> = {
  verse: { bg: '#1d4ed8', fg: '#eff6ff', border: '#3b82f6' },
  chorus: { bg: '#be123c', fg: '#fff1f2', border: '#f43f5e' },
  prechorus: { bg: '#4338ca', fg: '#eef2ff', border: '#6366f1' },
  bridge: { bg: '#b45309', fg: '#fffbeb', border: '#f59e0b' },
  tag: { bg: '#0f766e', fg: '#f0fdfa', border: '#14b8a6' },
  intro: { bg: '#6d28d9', fg: '#f5f3ff', border: '#8b5cf6' },
  default: { bg: '#333a47', fg: '#e7eaee', border: '#4b5563' },
};

export function sectionTone(label: string, short?: string): SectionTone {
  const s = `${label} ${short ?? ''}`.toLowerCase();
  if (/pre[-\s]?chorus|\bpc\d*\b/.test(s)) return TONES.prechorus!;
  if (/chorus|refrain|\bc\d*\b/.test(s)) return TONES.chorus!;
  if (/bridge|\bb\d*\b/.test(s)) return TONES.bridge!;
  if (/tag|outro|ending|coda|\bt\d*\b/.test(s)) return TONES.tag!;
  if (/intro|interlude|instrumental|turnaround|vamp|\bi\d*\b/.test(s)) return TONES.intro!;
  if (/verse|stanza|\bv\d*\b/.test(s)) return TONES.verse!;
  return TONES.default!;
}
