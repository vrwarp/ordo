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
  matchMidi,
  learnFrom,
  parseMidi,
  type MidiInputInfo,
  type MidiOutputInfo,
  type MidiMessage,
} from './midi.ts';
export { wrapText, renderKeyPixels, renderStripPixels } from './deck-render.ts';
