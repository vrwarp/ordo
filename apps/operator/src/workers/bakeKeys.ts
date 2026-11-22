import type { Slide } from '@ordo/domain';
import { localKey } from '../services/bakePlan.ts';

/**
 * The keys worker's whole job (design/29 section 1.4, D11): the key of a heavy slide on this computer, worked out with
 * the same function the plan uses on the main thread (`localKey`: the domain's `pictureSource` and `prerenderKey`), so
 * the two can never disagree. A slide's key costs the main thread about 30 ms per 600 KB (canonical JSON and a
 * plain-JavaScript SHA-256), which is a long task in the middle of the operator's screen; here it costs a worker.
 * No file, no network, no store: the slide, the file hash of each picture it draws and the library's faces come in the
 * message, the keys go out. Everything is in this module behind plain data, so node tests it; the worker file only
 * passes the messages.
 */

export type KeysIn = {
  t: 'keys';
  id: number;
  slides: { slide: Slide; files: Record<string, string> }[];
  fonts: { family: string; file: { hash: string } }[];
};
/** One key per slide in the order asked; `null` for a slide whose key could not be worked out (the main thread then does it). */
export type KeysOut = { t: 'keys'; id: number; keys: (string | null)[] };

export function keysOf(m: KeysIn): KeysOut {
  const fonts = Array.isArray(m.fonts) ? m.fonts : [];
  const keys = (Array.isArray(m.slides) ? m.slides : []).map((entry) => {
    try {
      const { slide, files } = entry;
      return localKey(slide, { mediaFile: (id) => files?.[id], fonts });
    } catch {
      return null;
    }
  });
  return { t: 'keys', id: m.id, keys };
}
