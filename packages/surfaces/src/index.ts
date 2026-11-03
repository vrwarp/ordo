/**
 * Control surfaces (design/19): one action vocabulary, three drivers (keyboard, Stream Deck over WebHID,
 * MIDI over Web MIDI), all in the operator window.
 */
export type { Action, Dispatch } from './types.ts';
export { normalizeCombo, isModifierOnly, KeyboardDriver } from './keyboard.ts';
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
} from './deck-model.ts';
export { StreamDeckDriver, dialActions, type DeckInfo } from './streamdeck.ts';
export { MidiDriver, matchMidi, learnFrom, parseMidi, type MidiInputInfo, type MidiMessage } from './midi.ts';
export { wrapText } from './deck-render.ts';
