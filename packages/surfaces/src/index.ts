/**
 * Control surfaces (design/19): one action vocabulary, three drivers (keyboard, Stream Deck over WebHID,
 * MIDI over Web MIDI), all in the operator window.
 */
export type { Action, Dispatch } from './types.ts';
export {
  normalizeCombo,
  isModifierOnly,
  KeyboardDriver,
  KEY_REPEAT_INTERVAL_MS,
  type KeyboardOptions,
} from './keyboard.ts';
export {
  type DeckView,
  type KeyFace,
  BLANK_FACE,
  PAGE_KEY_PREFIX,
  defaultDeckPages,
  faceKey,
  keyFace,
  lcdText,
  pageTarget,
  resolvePageTarget,
  sanitizeDeckPages,
} from './deck-model.ts';
export { StreamDeckDriver, dialActions, type DeckInfo, type DeckRenderer } from './streamdeck.ts';
export {
  MidiDriver,
  formatMidiAccessError,
  matchMidi,
  learnFrom,
  parseMidi,
  type MidiAccessErrorInfo,
  type MidiActivityEvent,
  type MidiInputInfo,
  type MidiOutputInfo,
  type MidiMessage,
} from './midi.ts';
export {
  QUICKQ_CHANNEL,
  QUICKQ_PLAYBACK_MIN,
  QUICKQ_PLAYBACK_MAX,
  QUICKQ_CUE_MIN,
  QUICKQ_CUE_MAX,
  QUICKQ_NOTE_GOTO_BASE,
  QUICKQ_NOTE_ACTIVATE_BASE,
  QUICKQ_NOTE_GO_BASE,
  QUICKQ_NOTE_PAUSE_BASE,
  clampQuickQPlayback,
  clampQuickQCue,
  levelPctToVelocity,
  velocityToLevelPct,
  encodeQuickQ,
  decodeQuickQ,
  formatQuickQCommand,
  formatQuickQ,
  formatQuickQMapping,
  formatMidiCueSummary,
  validateQuickQCue,
  formatMidiBytesHex,
  type QuickQAction,
  type QuickQCommand,
  type QuickQDecodable,
  type QuickQEncodedMidi,
} from './quickq.ts';
export { wrapText, renderKeyPixels, renderStripPixels } from './deck-render.ts';
