/**
 * The operator's side of the browser parse (design/27 §2 "Where the deck is parsed", design/15 "Import"): a
 * PowerPoint imported as editable slides is parsed in the import worker (`workers/import.worker.ts`), so the
 * hub only checks and stores it. The service never pays for an import:
 *
 * - **Not while live**: with a playlist live the deck is uploaded without a scene (the hub refuses imports
 *   then and says so); no browser CPU is spent next to GO.
 * - **In a worker with a deadline**: one worker per parse, terminated when it answers or when
 *   `PARSE_DEADLINE_MS` passes, so a large or crafted deck can neither freeze nor crash the page.
 * - **Any failure falls back**: a timeout, an error, a browser without what the parse needs, a table in a
 *   face only the hub can measure: the deck is uploaded without a scene and the hub parses it. Every
 *   fallback is counted (`useImportParse`, shown in Settings, Diagnostics, and in the operator log export)
 *   and written to the operator log.
 */
import type { Font } from '@ordo/domain';
import { fileUrl } from '@ordo/client';
import { create } from 'zustand';
import type { ImportIn, ImportOut } from '../workers/import.worker.ts';
import { log } from './log.ts';

/** How long the import worker may parse one deck before it is terminated and the hub parses it. */
export const PARSE_DEADLINE_MS = 90_000;

/**
 * The largest scene the hub takes (`apps/hub/src/pptx/clientScene.ts` `CLIENT_SCENE_LIMITS`): a larger one is
 * not uploaded at all, since the hub would drop it and parse the deck itself.
 */
export const SCENE_MAX_BYTES = 128 * 1024 * 1024;

/** Why a deck went to the hub without a scene. */
export type HubReason = 'live' | 'timeout' | 'failed' | 'unavailable';

/** What this browser's parses came to since the page loaded. */
export type ImportParseStats = {
  /** Decks parsed here and uploaded with their scene. */
  parsed: number;
  /** Decks left to the hub, by reason. */
  hub: Record<HubReason, number>;
  /** The latest parse: when, how, and how long it took or why it went to the hub. */
  last?: { at: number; outcome: 'parsed' | HubReason; ms?: number; detail?: string };
};

const EMPTY: ImportParseStats = { parsed: 0, hub: { live: 0, timeout: 0, failed: 0, unavailable: 0 } };

export const useImportParse = create<ImportParseStats>(() => structuredClone(EMPTY));

/** Forget the counts (tests). */
export function resetImportParse(): void {
  useImportParse.setState(structuredClone(EMPTY), true);
}

function record(outcome: 'parsed' | HubReason, name: string, ms?: number, detail?: string): void {
  useImportParse.setState((s) => ({
    parsed: s.parsed + (outcome === 'parsed' ? 1 : 0),
    hub: outcome === 'parsed' ? s.hub : { ...s.hub, [outcome]: s.hub[outcome] + 1 },
    last: { at: Date.now(), outcome, ...(ms !== undefined ? { ms } : {}), ...(detail ? { detail } : {}) },
  }));
  const file = name.slice(0, 120);
  if (outcome === 'parsed') log('info', `PowerPoint ${file}: parsed in this browser in ${ms ?? 0} ms`);
  else
    log(
      'warn',
      `PowerPoint ${file}: the hub parses it (${HUB_REASON_TEXT[outcome]}${detail ? `: ${detail.slice(0, 200)}` : ''})`,
    );
}

/** Each reason in the volunteer's words (the Diagnostics page, the operator log). */
export const HUB_REASON_TEXT: Record<HubReason, string> = {
  live: 'a playlist was live',
  timeout: 'the browser took too long',
  failed: 'the browser could not read it',
  unavailable: 'this browser cannot parse in the background',
};

/** The library's faces as the worker fetches them (`FaceFile`). */
export function faceFiles(fonts: readonly Font[]): ImportIn['faces'] {
  return fonts.map((f) => ({
    family: f.family,
    weight: f.weight,
    italic: f.style === 'italic',
    url: fileUrl(f.file.hash),
  }));
}

export type ParseRequest = {
  file: Blob;
  name: string;
  extendBackgrounds: boolean;
  libreoffice: boolean;
  fonts: readonly Font[];
  /** A playlist is live: the deck goes to the hub without a parse here. */
  live: boolean;
  onProgress?: (pct: number) => void;
};

/** What starts an import worker (tests give a fake one). */
export type WorkerFactory = () => Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;

const defaultWorker: WorkerFactory = () =>
  new Worker(new URL('../workers/import.worker.ts', import.meta.url), {
    type: 'module',
    name: 'ordo-import',
  });

/**
 * The scene of a deck parsed in the import worker, as the `clientScene` part of the upload; undefined when
 * the hub is to parse it (see the module comment). Never throws.
 */
export async function clientScene(
  r: ParseRequest,
  env: { worker?: WorkerFactory; deadlineMs?: number } = {},
): Promise<Blob | undefined> {
  if (r.live) {
    record('live', r.name);
    return undefined;
  }
  let w: ReturnType<WorkerFactory>;
  try {
    if (typeof Worker === 'undefined' && !env.worker) throw new Error('no Web Worker');
    w = (env.worker ?? defaultWorker)();
  } catch (e) {
    record('unavailable', r.name, undefined, e instanceof Error ? e.message : String(e));
    return undefined;
  }
  const t0 = performance.now();
  const deadline = env.deadlineMs ?? PARSE_DEADLINE_MS;
  return new Promise<Blob | undefined>((resolve) => {
    let settled = false;
    const finish = (blob: Blob | undefined, outcome: 'parsed' | HubReason, detail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // One parse per worker: whatever it holds (the deck's XML, the faces) is freed with it.
      try {
        w.terminate();
      } catch {
        /* already gone */
      }
      record(outcome, r.name, Math.round(performance.now() - t0), detail);
      resolve(blob);
    };
    const timer = setTimeout(
      () => finish(undefined, 'timeout', `after ${Math.round(deadline / 1000)} s`),
      deadline,
    );
    w.onmessage = (ev: MessageEvent<ImportOut>) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.t === 'progress') r.onProgress?.(Math.max(0, Math.min(1, m.pct)));
      else if (m.t === 'done')
        if (m.scene.byteLength > SCENE_MAX_BYTES)
          finish(undefined, 'failed', 'its scene is larger than the hub takes');
        else finish(new Blob([m.scene], { type: 'application/json' }), 'parsed');
      else if (m.t === 'error') finish(undefined, 'failed', m.message);
    };
    w.onerror = (e: ErrorEvent) => {
      e.preventDefault?.();
      finish(undefined, 'failed', e.message || 'the import worker stopped');
    };
    const msg: ImportIn = {
      t: 'parse',
      file: r.file,
      extendBackgrounds: r.extendBackgrounds,
      libreoffice: r.libreoffice,
      faces: faceFiles(r.fonts),
    };
    try {
      w.postMessage(msg);
    } catch (e) {
      finish(undefined, 'unavailable', e instanceof Error ? e.message : String(e));
    }
  });
}
