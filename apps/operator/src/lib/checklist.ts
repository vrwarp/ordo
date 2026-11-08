import type { KeyMap } from '@ordo/domain';
import type { Settings } from '@ordo/protocol';
import { BUDGET_INFO, CORE_GAVE_UP } from './budgets.ts';

export type ChecklistSection = { title: string; items: string[]; ordered?: boolean };

function keysFor(map: KeyMap, id: string): string {
  const k = Object.entries(map)
    .filter(([, a]) => a.id === id)
    .map(([c]) => c);
  return k.length ? k.join(' / ') : '(no key)';
}

/** The one-page service runbook generated from the current settings (prd/08, design/15). */
export function buildChecklist(s: Settings, opUrl: string): ChecklistSection[] {
  const outs = s.outputs.filter((o) => o.enabled);
  const lookName = (id: string) => s.looks.find((l) => l.id === id)?.name ?? id;
  const km = s.keymap;
  return [
    {
      title: 'Before the service',
      ordered: true,
      items: [
        'Turn on the projectors and TVs, then the presentation PC.',
        `Open Chrome and go to ${opUrl}. Sign in with the operate PIN (tick "Remember this device").`,
        'Check the top bar: Hub dot green.',
        `Open Playlists, pick today's service, press Go live. Wait until Cache shows 100 % (green).`,
        `Press Launch outputs (${keysFor(km, 'launchOutputs')}). Each window opens on its screen: ${outs
          .map((o) => `${o.name}${o.screen ? ` → ${o.screen.label}` : ''} (${lookName(o.lookId)})`)
          .join('; ')}.`,
        'Check every output dot in the top bar is green and the Program view shows each screen.',
        'Start the countdown to service in Stage tools if it is not in the playlist.',
        'Sound check: play the first video or audio cue briefly and confirm it reaches the desk.',
      ],
    },
    {
      title: 'During the service',
      items: [
        `Next slide: ${keysFor(km, 'next')}. Previous: ${keysFor(km, 'prev')}.`,
        `Next item: ${keysFor(km, 'nextItem')}. Previous item: ${keysFor(km, 'prevItem')}.`,
        'Click a section button (V1, C, B…) to jump to it. Click a slide to arm it, double-click to show it.',
        `Clear slide: ${keysFor(km, 'clearSlide')}. Clear lower third: ${keysFor(km, 'clearLowerThird')}. Clear props: ${keysFor(km, 'clearProps')}.`,
        `Clear everything to black: ${keysFor(km, 'clearAll')} twice within 2 seconds.`,
        `Logo: ${keysFor(km, 'logo')}. Play or pause media: ${keysFor(km, 'mediaPlayPause')}. Restart media: ${keysFor(km, 'mediaRestart')}.`,
        'Messages to the stage: type in Stage tools and press Send; Dismiss removes it.',
      ],
    },
    {
      title: 'What the colours mean',
      items: [
        'Green: working. Amber: waiting (caching, arming, or the hub is unreachable and this PC is running the service). Red: an output is not connected or has an error.',
        'Amber top bar "Hub lost": keep going. Everything works from this PC; it reconnects by itself.',
        'Hub down before the service: press Go live anyway and choose "Go live from this PC". It works best when the playlist was downloaded beforehand (Download for offline use on the playlist). The service stays on this PC until End service, even if the hub comes back.',
        'A red output dot: press Relaunch. If it stays red, see below.',
      ],
    },
    {
      title: 'Red states in the top bar (one button each)',
      items: [
        'Amber "Recovering…": the operator core is restarting by itself. Wait a second; key presses made meanwhile are sent when it is back.',
        'Amber "UI stalled": the operator page was busy. The outputs were not affected; use the Stream Deck if keys feel late.',
        ...Object.values(BUDGET_INFO).map((b) => b.checklist),
        CORE_GAVE_UP.checklist,
      ],
    },
    {
      title: 'If something goes wrong',
      ordered: true,
      items: [
        `An output is frozen, black or missing: press Relaunch (${keysFor(km, 'relaunchOutputs')}). Windows close and reopen in about 10 seconds.`,
        'The operator window was closed or reloaded: open it again and press Relaunch.',
        'Chrome closed: reopen Chrome, open the operator page, press Launch outputs.',
        'No sound: check the Master is not muted in the bottom bar and the audio device is plugged in.',
      ],
    },
    {
      title: 'Switch to ProPresenter (last resort)',
      ordered: true,
      items: [
        'Click each ordo output window and press Ctrl+Shift+Q to close it (or close them from the taskbar).',
        "Open ProPresenter. Today's playlist is already prepared in it.",
        "Set ProPresenter's screens on and continue from the current song.",
        'Tell the tech team afterwards; export Diagnostics from Settings → Diagnostics.',
      ],
    },
    {
      title: 'After the service',
      ordered: true,
      items: [
        'Press End service.',
        'Close the output windows (or leave them; they show black).',
        'Turn off the projectors.',
      ],
    },
  ];
}
