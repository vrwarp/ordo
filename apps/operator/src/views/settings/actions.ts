import type { ActionId } from '@ordo/domain';

export const ACTION_LABELS: Record<ActionId, string> = {
  go: 'GO (armed slide)',
  next: 'Next',
  prev: 'Previous',
  firstSlide: 'First slide of item',
  lastSlide: 'Last slide of item',
  nextItem: 'Next item',
  prevItem: 'Previous item',
  goToSection: 'Go to section (index)',
  goToSlide: 'Go to slide N of section',
  goToItem: 'Go to playlist item (index)',
  goToSlideItem: 'Go to slide N of item',
  clearSlide: 'Clear slide',
  clearAll: 'Clear all (confirm)',
  clearLowerThird: 'Clear lower third',
  clearProps: 'Clear props',
  clearMedia: 'Clear media',
  clearBackground: 'Clear background',
  logo: 'Logo',
  mediaPlayPause: 'Play / pause media',
  mediaRestart: 'Restart media',
  timerStart: 'Start timer',
  timerStop: 'Stop timer',
  timerReset: 'Reset timer',
  messagePreset: 'Send message preset (index)',
  messageDismiss: 'Dismiss message',
  audioMute: 'Mute / unmute master',
  audioMasterUp: 'Master +3 dB',
  audioMasterDown: 'Master −3 dB',
  audioFadeOut: 'Stop audio cue',
  launchOutputs: 'Launch outputs',
  relaunchOutputs: 'Relaunch outputs',
};

export const ACTION_OPTIONS = (Object.keys(ACTION_LABELS) as ActionId[]).map((value) => ({
  value,
  label: ACTION_LABELS[value],
}));

export const ACTIONS_WITH_ARG = new Set<ActionId>([
  'goToSection',
  'goToSlide',
  'goToItem',
  'goToSlideItem',
  'messagePreset',
  'timerStart',
  'timerStop',
  'timerReset',
]);

export function parseArg(id: ActionId, raw: string): number | string | undefined {
  if (!ACTIONS_WITH_ARG.has(id) || raw.trim() === '') return undefined;
  if (id.startsWith('timer')) return raw.trim();
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function actionText(a: { id: ActionId; arg?: number | string } | undefined): string {
  if (!a) return '—';
  return `${ACTION_LABELS[a.id]}${a.arg !== undefined ? ` ${a.arg}` : ''}`;
}
