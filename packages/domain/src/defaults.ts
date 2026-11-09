import type {
  AudioSettings,
  GeneralSettings,
  KeyMap,
  Look,
  Rgba,
  SurfaceSettings,
  TextStyle,
  Theme,
} from './schemas.ts';

export const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
export const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
export const KEY_GREEN: Rgba = { r: 0, g: 255, b: 0, a: 1 };

export const DEFAULT_FONT = 'Inter';

/**
 * Script fallback families (design/27 §10) by ISO 15924 code, the codes `textScripts` reports: the faces
 * ordo bundles for every output (M3) and, for Han, Kana and Hangul, the Noto CJK families shipped when the
 * text needs them. The drawers' font resolver tries them, when loaded, after a run's own family and its
 * `fallbackFonts`, for text in that script.
 */
export const SCRIPT_FALLBACK_FONTS: Readonly<Record<string, readonly string[]>> = {
  Grek: ['Noto Sans'],
  Cyrl: ['Noto Sans'],
  Hebr: ['Noto Sans Hebrew'],
  Arab: ['Noto Naskh Arabic'],
  Deva: ['Noto Sans Devanagari'],
  Taml: ['Noto Sans Tamil'],
  Thai: ['Noto Sans Thai'],
  Mymr: ['Noto Sans Myanmar'],
  Hani: ['Noto Sans SC', 'Noto Sans TC', 'Noto Sans JP', 'Noto Sans KR'],
  Hira: ['Noto Sans JP'],
  Kana: ['Noto Sans JP'],
  Hang: ['Noto Sans KR'],
};

export const DEFAULT_LYRIC_STYLE: TextStyle = {
  fontFamily: DEFAULT_FONT,
  fontWeight: 700,
  fontStyle: 'normal',
  fontSizePx: 84,
  color: WHITE,
  align: 'center',
  valign: 'middle',
  lineHeight: 1.2,
  letterSpacing: 0,
  transform: 'none',
  padding: 20,
  outline: { width: 4, color: { r: 0, g: 0, b: 0, a: 0.85 } },
  shadow: { dx: 0, dy: 4, blur: 12, color: { r: 0, g: 0, b: 0, a: 0.6 } },
};

export const DEFAULT_THEME: Theme = {
  id: 'theme-default',
  name: 'Default',
  lyricBox: { x: 120, y: 140, w: 1680, h: 800, rotation: 0 },
  text: DEFAULT_LYRIC_STYLE,
  textBoxDefaults: {
    ...DEFAULT_LYRIC_STYLE,
    fontWeight: 400,
    fontSizePx: 64,
    outline: undefined,
    shadow: undefined,
  },
};

const lowerThirdStyle: TextStyle = {
  ...DEFAULT_LYRIC_STYLE,
  fontSizePx: 56,
  outline: { width: 3, color: { r: 0, g: 0, b: 0, a: 1 } },
  shadow: undefined,
  fill: { color: { r: 0, g: 0, b: 0, a: 0.55 }, radius: 12 },
  padding: 24,
};

export const LOOK_MAIN: Look = {
  id: 'look-main',
  name: 'Main',
  kind: 'main',
  layers: {
    background: { visible: true },
    slide: { mode: 'authored' },
    lowerThird: { visible: true },
    media: { visible: true },
    props: { logo: true, countdown: true, clock: false, messages: false, elapsed: false, style: {} },
  },
  clearColor: BLACK,
  transition: { kind: 'crossfade', ms: 300 },
};

export const LOOK_LOWER_THIRD: Look = {
  id: 'look-lower-third',
  name: 'Lobby / overflow',
  kind: 'lowerThird',
  layers: {
    background: { visible: false },
    slide: {
      mode: 'lyricOnly',
      style: lowerThirdStyle,
      band: { x: 160, y: 820, w: 1600, h: 220, rotation: 0 },
      nonSong: 'text',
    },
    lowerThird: { visible: true },
    media: { visible: false },
    props: { logo: false, countdown: true, clock: false, messages: false, elapsed: false, style: {} },
  },
  clearColor: BLACK,
  transition: { kind: 'crossfade', ms: 300 },
};

export const LOOK_STREAM: Look = {
  ...LOOK_LOWER_THIRD,
  id: 'look-stream',
  name: 'Livestream (key)',
  kind: 'stream',
  layers: {
    ...LOOK_LOWER_THIRD.layers,
    props: { logo: false, countdown: false, clock: false, messages: false, elapsed: false, style: {} },
  },
  clearColor: KEY_GREEN,
};

export const LOOK_STAGE: Look = {
  id: 'look-stage',
  name: 'Stage',
  kind: 'stage',
  layers: {
    background: { visible: false },
    slide: {
      mode: 'lyricOnly',
      style: {
        ...DEFAULT_LYRIC_STYLE,
        fontSizePx: 72,
        outline: undefined,
        shadow: undefined,
        align: 'left',
        valign: 'top',
      },
      band: { x: 60, y: 140, w: 1800, h: 520, rotation: 0 },
      nextSlide: {
        style: {
          ...DEFAULT_LYRIC_STYLE,
          fontSizePx: 44,
          fontWeight: 400,
          outline: undefined,
          shadow: undefined,
          color: { r: 200, g: 200, b: 200, a: 0.75 },
          align: 'left',
          valign: 'top',
        },
        band: { x: 60, y: 700, w: 1800, h: 260, rotation: 0 },
      },
      nonSong: 'text',
    },
    lowerThird: { visible: false },
    media: { visible: false },
    props: { logo: false, countdown: true, clock: true, messages: true, elapsed: true, style: {} },
  },
  clearColor: BLACK,
  transition: { kind: 'cut' },
};

export const DEFAULT_LOOKS: Look[] = [LOOK_MAIN, LOOK_LOWER_THIRD, LOOK_STREAM, LOOK_STAGE];

export const DEFAULT_KEYMAP: KeyMap = {
  Escape: { id: 'clearSlide' },
  Space: { id: 'next' },
  ArrowRight: { id: 'next' },
  ArrowDown: { id: 'next' },
  ArrowLeft: { id: 'prev' },
  ArrowUp: { id: 'prev' },
  PageDown: { id: 'nextItem' },
  PageUp: { id: 'prevItem' },
  F1: { id: 'clearSlide' },
  F2: { id: 'clearAll' },
  F3: { id: 'clearLowerThird' },
  F4: { id: 'clearProps' },
  F5: { id: 'logo' },
  F8: { id: 'mediaPlayPause' },
  'Shift+F8': { id: 'mediaRestart' },
  'Ctrl+Shift+L': { id: 'launchOutputs' },
  'Ctrl+Shift+R': { id: 'relaunchOutputs' },
  Digit1: { id: 'goToSlide', arg: 1 },
  Digit2: { id: 'goToSlide', arg: 2 },
  Digit3: { id: 'goToSlide', arg: 3 },
  Digit4: { id: 'goToSlide', arg: 4 },
  Digit5: { id: 'goToSlide', arg: 5 },
  Digit6: { id: 'goToSlide', arg: 6 },
  Digit7: { id: 'goToSlide', arg: 7 },
  Digit8: { id: 'goToSlide', arg: 8 },
  Digit9: { id: 'goToSlide', arg: 9 },
};

export const DEFAULT_AUDIO: AudioSettings = {
  pairs: [{ id: 'pair-house', name: 'House L/R', left: 0, right: 1 }],
  defaultPairId: 'pair-house',
  masterDb: 0,
};

export const DEFAULT_SURFACES: SurfaceSettings = {
  streamDeckPages: [],
  midi: [
    { id: 'midi-next', kind: 'note', number: 60, threshold: 1, action: { id: 'next' } },
    { id: 'midi-prev', kind: 'note', number: 62, threshold: 1, action: { id: 'prev' } },
  ],
  midiEnabled: false,
  messagePresets: ['Wrap up', 'Repeat chorus', 'One more time', 'Watch the leader', 'Mic check'],
};

export const DEFAULT_GENERAL: GeneralSettings = {
  venueName: 'ordo',
  timeZone: 'UTC',
  clock24h: false,
  defaultLinesPerSlide: 2,
  defaultPreRollMs: 33,
};
