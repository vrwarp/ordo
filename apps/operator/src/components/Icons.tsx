import type { PlaylistItem, PresentationKind } from '@ordo/domain';
import type { SVGProps } from 'react';

export type IconName =
  | 'playlists'
  | 'library'
  | 'live'
  | 'settings'
  | 'setup'
  | 'previews'
  | 'user'
  | 'logout'
  | 'chevronDown'
  | 'chevronRight'
  | 'chevronLeft'
  | 'check'
  | 'search'
  | 'close'
  | 'plus'
  | 'minus'
  | 'moreHorizontal'
  | 'grip'
  | 'sliders'
  | 'external'
  | 'music'
  | 'slides'
  | 'loop'
  | 'video'
  | 'image'
  | 'audio'
  | 'timer'
  | 'action'
  | 'folder'
  | 'tag'
  | 'theme'
  | 'font'
  | 'upload'
  | 'import'
  | 'play'
  | 'pause'
  | 'restart'
  | 'bgLayer'
  | 'slideLayer'
  | 'bannerLayer'
  | 'mediaLayer'
  | 'propsLayer'
  | 'lights'
  | 'volume'
  | 'volumeMute'
  | 'power'
  | 'monitor'
  | 'monitorOff'
  | 'notes'
  | 'message'
  | 'clock'
  | 'grid'
  | 'list'
  | 'arrange'
  | 'edit'
  | 'copy'
  | 'trash'
  | 'eye'
  | 'eyeOff'
  | 'warning'
  | 'info'
  | 'calendar'
  | 'arrowUp'
  | 'arrowDown'
  | 'backspace'
  | 'keyboard'
  | 'midi'
  | 'streamdeck'
  | 'backup'
  | 'activity'
  | 'shield'
  | 'layers';

const PATHS: Record<IconName, string> = {
  playlists: 'M4 5h12M4 9.5h8M4 14h6M13.5 10v5.5M11 12.75h5',
  library: 'M3.5 4h3v12h-3zM8 4h3v12H8zM12.5 4.3l3-.8 2 11.7-3 .8z',
  live: 'M5.5 5.5a6.4 6.4 0 0 0 0 9M14.5 5.5a6.4 6.4 0 0 1 0 9M7.8 7.8a3.1 3.1 0 0 0 0 4.4M12.2 7.8a3.1 3.1 0 0 1 0 4.4M10 10h.01',
  settings: 'M4 6h12M4 10h12M4 14h12M7.5 4.5v3M12.5 8.5v3M8.5 12.5v3',
  setup: 'M3 4.5h14v9H3zM7 16.5h6M10 13.5v3',
  previews: 'M3 5h6v5H3zM11 5h6v5h-6zM3 12h6v5H3zM11 12h6v5h-6z',
  user: 'M10 9.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4.5 16.5a5.5 5.5 0 0 1 11 0',
  logout: 'M8 4H4.5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1H8M12 6.5 15.5 10 12 13.5M7.5 10h8',
  chevronDown: 'M5.5 7.5 10 12l4.5-4.5',
  chevronRight: 'M7.5 5.5 12 10l-4.5 4.5',
  chevronLeft: 'M12.5 5.5 8 10l4.5 4.5',
  check: 'M4.5 10.5 8.2 14l7.3-7.5',
  search: 'M9 14.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zM13.2 13.2 16.5 16.5',
  close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  plus: 'M10 4.5v11M4.5 10h11',
  minus: 'M4.5 10h11',
  moreHorizontal: 'M5 10h.01M10 10h.01M15 10h.01',
  grip: 'M7.5 5.5h.01M7.5 10h.01M7.5 14.5h.01M12.5 5.5h.01M12.5 10h.01M12.5 14.5h.01',
  sliders: 'M4 6h12M4 10h12M4 14h12M7 4.5v3M13 8.5v3M9 12.5v3',
  external: 'M11 4h5v5M16 4l-6.5 6.5M14 11.5V15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h3.5',
  music: 'M8 14.5a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM16 13a2 2 0 1 1-4 0 2 2 0 0 1 4 0zM8 14.5V5.5l8-1.5v9',
  slides: 'M3.5 5h13v9h-13zM6.5 8h7M6.5 11h4.5M10 14v2.5M7 16.5h6',
  loop: 'M14.5 6.5H6a2.5 2.5 0 0 0-2.5 2.5v1M12.5 4.5l2 2-2 2M5.5 13.5H14a2.5 2.5 0 0 0 2.5-2.5v-1M7.5 15.5l-2-2 2-2',
  video: 'M3.5 6h9v8h-9zM12.5 8.5 16.5 6.5v7l-4-2',
  image: 'M3.5 4.5h13v11h-13zM7 8a1 1 0 1 0 0 .01M4 14l4-4 3 3 2.5-2.5L16 13',
  audio: 'M4 8.5h3l4-3v9l-4-3H4zM14 7.5a3.5 3.5 0 0 1 0 5M15.8 5.8a6 6 0 0 1 0 8.4',
  timer: 'M8 3.5h4M10 6.5a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM10 9.5v2.5l1.8 1.2',
  action: 'M11 3.5 5.5 10.5H10l-1 6 5.5-7H10l1-6z',
  folder: 'M3.5 5.5h4.5l1.5 1.8h7v8.2h-13z',
  tag: 'M4 10.2V4h6.2l6.3 6.3-6.2 6.2zM7.2 7.2h.01',
  theme:
    'M10 3.5a6.5 6.5 0 1 0 0 13c1.2 0 2-.7 2-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.4-.6-.4-1 0-.8.6-1.4 1.4-1.4h1.6a2.4 2.4 0 0 0 2.4-2.4c0-3-2.9-5.3-6.5-5.3z',
  font: 'M5 15.5 9.5 4.5h1l4.5 11M6.8 11.8h6.4',
  upload: 'M10 13.5V4.5M6.5 8 10 4.5 13.5 8M4 14.5v1.5h12v-1.5',
  import: 'M10 4.5v9M6.5 10 10 13.5 13.5 10M4 14.5v1.5h12v-1.5',
  play: 'M6.5 5v10l8.5-5z',
  pause: 'M6.5 5v10M13.5 5v10',
  restart: 'M5.5 10a4.5 4.5 0 1 1 1.3 3.2M4 6.5v3.5h3.5',
  bgLayer: 'M3.5 5h13v10h-13zM6.5 8.5h.01M4 13.5l3.5-3.5 2.5 2.5 2-2 4 3',
  slideLayer: 'M3.5 5h13v10h-13zM6.5 8.5h7M6.5 11.5h5',
  bannerLayer: 'M3.5 5h13v10h-13zM5.5 11.5h9v2h-9z',
  mediaLayer: 'M3.5 5h13v10h-13zM8.5 7.8v4.4l3.8-2.2z',
  propsLayer: 'M10 4.5l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z',
  lights: 'M10 3.5a4 4 0 0 0-2.4 7.2c.5.4.9 1 .9 1.8h3c0-.8.4-1.4.9-1.8A4 4 0 0 0 10 3.5zM8.5 15h3M9 17h2',
  volume: 'M4 8.5h3l4-3v9l-4-3H4zM14 7.8a3.2 3.2 0 0 1 0 4.4',
  volumeMute: 'M4 8.5h3l4-3v9l-4-3H4zM13.5 8l3.5 4M17 8l-3.5 4',
  power: 'M10 3.5v6M6.2 5.8a5.5 5.5 0 1 0 7.6 0',
  monitor: 'M3 4.5h14v9.5H3zM7 16.5h6M10 14v2.5',
  monitorOff: 'M3 4.5h14v9.5H3zM7 16.5h6M10 14v2.5M4 15 16 4',
  notes: 'M5 4h10v12H5zM7.5 7.5h5M7.5 10.5h5M7.5 13.5h3',
  message: 'M4 5h12v8.5H8.5L5 16v-2.5H4z',
  clock: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10 6.5v3.8l2.5 1.5',
  grid: 'M4 4h5v5H4zM11 4h5v5h-5zM4 11h5v5H4zM11 11h5v5h-5z',
  list: 'M4.5 6h11M4.5 10h11M4.5 14h11',
  arrange: 'M4 6h5v3H4zM11 6h5v3h-5zM4 11h7v3H4zM13 11h3v3h-3z',
  edit: 'M13 4.5l2.5 2.5L7 15.5H4.5V13z',
  copy: 'M7 7h8.5v8.5H7zM4.5 13V4.5H13',
  trash: 'M5 6h10M8 6V4.5h4V6M6.2 6l.6 9.5h6.4l.6-9.5',
  eye: 'M3 10s2.8-4.5 7-4.5S17 10 17 10s-2.8 4.5-7 4.5S3 10 3 10zM10 11.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
  eyeOff:
    'M4 4l12 12M7.2 7.2A6.6 6.6 0 0 0 3 10s2.8 4.5 7 4.5c1.3 0 2.4-.3 3.4-.9M12.8 12.8A6.6 6.6 0 0 0 17 10s-2.8-4.5-7-4.5c-.8 0-1.6.1-2.3.4',
  warning: 'M10 4 3.5 15.5h13zM10 8.5v3M10 13.5h.01',
  info: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM10 9v4M10 6.8h.01',
  calendar: 'M4 6h12v10H4zM4 9.5h12M7 4v3M13 4v3',
  arrowUp: 'M10 15V5M6 9l4-4 4 4',
  arrowDown: 'M10 5v10M6 11l4 4 4-4',
  backspace: 'M7.5 5.5h8.5v9H7.5L3.5 10zM9.8 8.2l3.4 3.6M13.2 8.2l-3.4 3.6',
  keyboard: 'M3.5 6h13v8h-13zM6 8.5h1M8.5 8.5h1M11 8.5h1M13.5 8.5h1M6.5 11.5h7',
  midi: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM7 9.5h.01M8.2 7.2h.01M10 6.5h.01M11.8 7.2h.01M13 9.5h.01',
  streamdeck: 'M3.5 5h13v10h-13zM7.8 5v10M12.2 5v10M3.5 10h13',
  backup: 'M5 14.5h10v-2M10 4.5v7M7 8.5l3 3 3-3',
  activity: 'M3.5 10h3l2-5 3 10 2-5h3',
  shield: 'M10 3.5 4.5 5.8v4.4c0 3.2 2.3 5.5 5.5 6.3 3.2-.8 5.5-3.1 5.5-6.3V5.8z',
  layers: 'M10 4 3.5 7.5 10 11l6.5-3.5zM3.5 11l6.5 3.5L16.5 11M3.5 14l6.5 3.5L16.5 14',
};

export function Icon({
  name,
  size = 14,
  className,
  ...rest
}: {
  name: IconName;
  size?: number;
  className?: string;
} & Omit<SVGProps<SVGSVGElement>, 'name' | 'width' | 'height'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className ? `ico ${className}` : 'ico'}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Map a playlist item kind (and optional presentation kind) to a crisp SVG icon name. */
export function playlistItemIconName(
  kind: PlaylistItem['kind'],
  presentationKind?: PresentationKind,
): IconName {
  if (kind === 'presentation') {
    if (presentationKind === 'loop') return 'loop';
    if (presentationKind === 'slides') return 'slides';
    return 'music';
  }
  if (kind === 'media') return 'video';
  if (kind === 'timer') return 'timer';
  return 'action';
}
