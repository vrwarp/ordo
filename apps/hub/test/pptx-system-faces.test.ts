/**
 * Rule H (sub-wave 1c, `src/pptx/systemFaces.ts`): a hub measures a table cell in a script its font library has
 * no face for (Han, Kana, Hangul) with this computer's face for it, resolved once at start and awaited by every
 * import; the library's face always wins; no face found is today's estimate.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ShapeObject, TableData } from '@ordo/domain';
import { cellRich } from '@ordo/domain/table.ts';
import { buildDeck, sfntFont, tableFrame, tc } from '@ordo/pptx-scene/test-util.ts';
import { describe, expect, it } from 'vitest';
import type { SceneFontFile } from '../src/pptx/faces.ts';
import { sceneTask } from '../src/pptx/sceneTask.ts';
import type { SceneTaskInput } from '../src/pptx/shared.ts';
import {
  FC_MATCH_PATHS,
  fontconfigLookup,
  type SystemFaceLookup,
  SystemFaces,
  type SystemScriptFace,
  systemOnlyScripts,
} from '../src/pptx/systemFaces.ts';
import { startHub, tempDir } from './helpers.ts';
import { slidesOf, storeDeck, waitJob, zipDeck } from './pptx-helpers.ts';

const IN = 914_400;
const TEXT = '이야기를 나누는 시간';
const dir = tempDir('ordo-sysfaces-');

function file(name: string, bytes: Uint8Array): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

/** A TrueType collection of `fonts` ('ttcf' 1.0): each font's table offsets moved to its place in the file. */
function ttc(fonts: readonly Uint8Array[]): Uint8Array {
  const head = 12 + 4 * fonts.length;
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let at = head;
  for (const f of fonts) {
    const b = Buffer.from(f);
    for (let i = 0; i < b.readUInt16BE(4); i++) {
      const e = 12 + i * 16;
      b.writeUInt32BE(b.readUInt32BE(e + 8) + at, e + 8);
    }
    offsets.push(at);
    parts.push(b);
    at += b.length;
  }
  const h = Buffer.alloc(head);
  h.write('ttcf', 0, 'latin1');
  h.writeUInt32BE(0x00010000, 4);
  h.writeUInt32BE(fonts.length, 8);
  for (const [i, o] of offsets.entries()) h.writeUInt32BE(o, 12 + i * 4);
  return new Uint8Array(Buffer.concat([h, ...parts]));
}

// Every Hangul face maps 가 (U+AC00), the letter the hub asks fontconfig to cover (`SYSTEM_FACE_SCRIPTS`), and the
// common letters a face must map to be kept for Hangul (`SYSTEM_FACE_LETTERS`).
const hangulChars = Object.fromEntries([...new Set(`${TEXT}가나다라마바사아자하한글`)].map((c) => [c, 1000]));
/** ordo's default face stand-in: Latin only, its line 1.2 of the size. */
const latin = file(
  'Inter.ttf',
  sfntFont(Object.fromEntries([...'abc '].map((c) => [c, 500])), {
    vertical: { ascender: 1000, descender: -200 },
  }),
);
/** This computer's Hangul face: its line 1.26 of the size (WenQuanYi Zen Hei's 1.2598). */
const hangulBytes = sfntFont(hangulChars, { vertical: { ascender: 1000, descender: -260 } });
const hangul = file('hangul.ttf', hangulBytes);
/** A face without Hangul (what fc-match names on a computer without a Korean face): its line 1.5. */
const noHangulBytes = sfntFont({ x: 500 }, { vertical: { ascender: 1100, descender: -400 } });
const noHangul = file('no-hangul.ttf', noHangulBytes);
/** A collection: the face without Hangul at index 0, the Hangul face at index 1. */
const collection = file('pair.ttc', ttc([noHangulBytes, hangulBytes]));
/** The library's Noto Sans KR: its line 1.4. */
const notoKr = file(
  'NotoSansKR.ttf',
  sfntFont(hangulChars, { vertical: { ascender: 1100, descender: -300 } }),
);

const koreanDeck = () =>
  buildDeck({
    slides: [
      {
        shapes: tableFrame({
          id: 4,
          x: IN,
          y: IN,
          cols: [4 * IN],
          rows: [
            {
              h: 1,
              cells: [
                tc(TEXT, {
                  rPr: 'lang="ko-KR"',
                  rPrChildren: '<a:latin typeface="Malgun Gothic"/><a:ea typeface="Malgun Gothic"/>',
                }),
              ],
            },
          ],
        }),
      },
    ],
  });

/** A cell's line spacing as a share of single: its paragraph's, else its box's (`lineHeight` / 1.2). */
const cellSpacing = (t: TableData, i = 0) => {
  const c = cellRich(t, i)!;
  return c.paras?.[0]?.lineSpacing ?? c.style.lineHeight / 1.2;
};
const tableOf = (objects: readonly unknown[]) =>
  (objects as ShapeObject[]).find((o) => o.type === 'shape' && o.table)!.table!;

/** The Korean cell's spacing as the `pptx-scene` task measures it with these faces. */
function measured(fonts: SceneFontFile[], system?: SystemScriptFace[]): number {
  const input: SceneTaskInput = {
    parts: koreanDeck(),
    pictureSizes: [],
    range: { from: 0, to: 1 },
    options: {},
    fonts,
    ...(system ? { systemScriptFaces: system } : {}),
  };
  return cellSpacing(tableOf(sceneTask(input).result.slides[0]!.slide.objects));
}

const silent = { info: () => undefined, warn: () => undefined };
const library: SceneFontFile[] = [['Inter', 400, false, latin]];
/** Today's estimate: no Hangul face anywhere. */
const estimate = measured(library);

describe("the pptx-scene task with this computer's script faces (rule H)", () => {
  it("spaces a Korean cell by this computer's Hangul face where the library has none; none: today's estimate", () => {
    expect(estimate).not.toBeCloseTo(1.26 / 1.2, 3);
    expect(measured(library, [['Hang', hangul, 0]])).toBeCloseTo(1.26 / 1.2, 6);
    expect(measured(library, [])).toBe(estimate);
    // Faces for other scripts do not reach a Hangul cell.
    expect(measured(library, [['Hani', hangul, 0]])).toBe(estimate);
  });

  it('ignores a face that does not map the letter', () => {
    expect(measured(library, [['Hang', noHangul, 0]])).toBe(estimate);
  });

  it("lets the library's face win (its Noto Sans KR)", () => {
    const withKr: SceneFontFile[] = [...library, ['Noto Sans KR', 400, false, notoKr]];
    expect(measured(withKr)).toBeCloseTo(1.4 / 1.2, 6);
    expect(measured(withKr, [['Hang', hangul, 0]])).toBeCloseTo(1.4 / 1.2, 6);
  });

  it('reads a TrueType collection at its index (the Hangul face at index 1)', () => {
    expect(measured(library, [['Hang', collection, 1]])).toBeCloseTo(1.26 / 1.2, 6);
    expect(measured(library, [['Hang', collection, 0]])).toBe(estimate);
  });

  it('names the system faces a table was measured with', () => {
    const out = sceneTask({
      parts: koreanDeck(),
      pictureSizes: [],
      range: { from: 0, to: 1 },
      options: {},
      fonts: library,
      systemScriptFaces: [['Hang', collection, 1]],
    });
    expect(out.systemFaces).toEqual(['Hang pair.ttc']);
  });
});

describe('SystemFaces: resolved once, checked, bounded', () => {
  const lookupOf =
    (faces: Record<string, { file: string; index: number }>): SystemFaceLookup =>
    async (script) =>
      faces[script];

  it('keeps a face only when it maps the letter, a collection read at its index', async () => {
    expect(await new SystemFaces(lookupOf({ Hang: { file: collection, index: 1 } }), silent).ready).toEqual([
      ['Hang', collection, 1],
    ]);
    expect(await new SystemFaces(lookupOf({ Hang: { file: collection, index: 0 } }), silent).ready).toEqual(
      [],
    );
    expect(await new SystemFaces(lookupOf({ Hang: { file: noHangul, index: 0 } }), silent).ready).toEqual([]);
    expect(
      await new SystemFaces(lookupOf({ Hang: { file: join(dir, 'gone.ttf'), index: 0 } }), silent).ready,
    ).toEqual([]);
    // One face for several scripts is kept for each script it maps (this one has no Han letter).
    expect(
      await new SystemFaces(
        lookupOf({ Hang: { file: hangul, index: 0 }, Hani: { file: hangul, index: 0 } }),
        silent,
      ).ready,
    ).toEqual([['Hang', hangul, 0]]);
  });

  it("keeps a face for a script only when it maps the script's common letters, not the one asked for", async () => {
    // fonts-noto-core's Nushu face (NotoTraditionalNushu): U+4E00 is its only ideograph, and fontconfig names it for
    // `:charset=4e00` on a computer without a CJK face (the font set the project's hub image had before it installed
    // Noto Sans CJK).
    const nushu = file('nushu.ttf', sfntFont({ 一: 1000, a: 500, ' ': 250 }));
    expect(await new SystemFaces(lookupOf({ Hani: { file: nushu, index: 0 } }), silent).ready).toEqual([]);
    // A face with a few Hangul letters only is no Hangul face either.
    const few = file('few-hangul.ttf', sfntFont({ 가: 1000, 이: 1000, 야: 1000 }));
    expect(await new SystemFaces(lookupOf({ Hang: { file: few, index: 0 } }), silent).ready).toEqual([]);
    // A CJK face with the common letters of all four scripts is kept for each.
    const cjk = file(
      'cjk.ttf',
      sfntFont(
        Object.fromEntries(
          [
            ...'一人大日中上下天山水火木あいうえおかきくのをんすアイウエオカキクンストー가나다라마바사아자하한글',
          ].map((c) => [c, 1000]),
        ),
      ),
    );
    expect(
      await new SystemFaces(
        lookupOf({
          Hani: { file: cjk, index: 0 },
          Hira: { file: cjk, index: 0 },
          Kana: { file: cjk, index: 0 },
          Hang: { file: cjk, index: 0 },
        }),
        silent,
      ).ready,
    ).toEqual([
      ['Hani', cjk, 0],
      ['Hira', cjk, 0],
      ['Kana', cjk, 0],
      ['Hang', cjk, 0],
    ]);
  });

  it('settles with no face when the lookup does not answer in time, and says so', async () => {
    const warned: string[] = [];
    const never: SystemFaceLookup = () => new Promise(() => undefined);
    const faces = new SystemFaces(
      never,
      { info: () => undefined, warn: (_o, m) => warned.push(m) },
      { timeoutMs: 50 },
    );
    expect(await faces.ready).toEqual([]);
    expect(warned.join('\n')).toMatch(/did not answer within/);
  });

  it('lists the scripts only this computer has a face for', () => {
    const faces: SystemScriptFace[] = [
      ['Hani', hangul, 0],
      ['Hang', hangul, 0],
    ];
    expect(systemOnlyScripts(faces, [{ family: 'Inter' }])).toEqual(['Hani', 'Hang']);
    // The library's Noto Sans JP serves Han (a fallback family of Han), not Hangul; its Noto Sans KR serves both.
    expect(systemOnlyScripts(faces, [{ family: 'Inter' }, { family: 'noto sans jp' }])).toEqual(['Hang']);
    expect(systemOnlyScripts(faces, [{ family: 'Inter' }, { family: 'Noto Sans KR' }])).toEqual([]);
    expect(systemOnlyScripts([], [{ family: 'Inter' }])).toEqual([]);
  });
});

describe('fontconfigLookup: fc-match by absolute path, never through PATH', () => {
  it('runs the first fc-match of its absolute paths, whatever PATH holds, with the letter alone', async () => {
    expect(FC_MATCH_PATHS).toEqual([
      '/usr/bin/fc-match',
      '/usr/local/bin/fc-match',
      '/opt/homebrew/bin/fc-match',
    ]);
    const args = join(dir, 'fc-args.txt');
    const stub = join(dir, 'fc-match');
    writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\nprintf '%s\\t1' '${collection}'\n`);
    chmodSync(stub, 0o755);
    // A PATH of the lite tools only (no fc-match there), as on a hub without LibreOffice.
    const lite = tempDir('ordo-lite-');
    const was = process.env.PATH;
    process.env.PATH = lite;
    try {
      const lookup = fontconfigLookup({ paths: [join(dir, 'missing', 'fc-match'), 'fc-match', stub] });
      expect(await lookup('Hang', 0xac00)).toEqual({ file: collection, index: 1 });
      expect(readFileSync(args, 'utf8').split('\n').slice(0, 3)).toEqual([
        '-f',
        '%{file}\t%{index}',
        ':charset=ac00',
      ]);
      // Without an fc-match: no face.
      expect(
        await fontconfigLookup({ paths: [join(dir, 'missing', 'fc-match')] })('Hang', 0xac00),
      ).toBeUndefined();
    } finally {
      process.env.PATH = was;
    }
  });
});

describe('a hub imports with the faces it resolved at start (awaited)', () => {
  it('stores the system-face rows for an import that started before the resolution settled', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let asked = 0;
    const lookup: SystemFaceLookup = async (script) => {
      asked++;
      await gate;
      return script === 'Hang' ? { file: hangul, index: 0 } : undefined;
    };
    const hub = await startHub({ systemFaces: lookup });
    try {
      const deck = await zipDeck(koreanDeck(), dir, 'korean.pptx');
      const hash = await storeDeck(hub, deck);
      const first = hub.imports.pptx.queueNative(hash, 'Korean.pptx', {});
      // The resolution started with the hub and has not settled: the import waits for it.
      await new Promise((r) => setTimeout(r, 300));
      expect(asked).toBe(4);
      expect(hub.jobs.get(first.id).state).not.toBe('done');
      release();
      const job = await waitJob(hub, first.id, 120_000);
      expect(job.state).toBe('done');
      expect(job.log.join('\n')).toMatch(
        /table cells in Hangul measured with this computer's face hangul\.ttf/,
      );
      const id = (job.result as { presentationId: string }).presentationId;
      const t1 = tableOf(slidesOf(hub.lib.presentations.must(id))[0]!.objects);
      expect(cellSpacing(t1)).toBeCloseTo(1.26 / 1.2, 6);
      // A later import of the same deck stores the same table.
      const later = await waitJob(hub, hub.imports.pptx.queueNative(hash, 'Korean.pptx', {}).id, 120_000);
      const id2 = (later.result as { presentationId: string }).presentationId;
      expect(tableOf(slidesOf(hub.lib.presentations.must(id2))[0]!.objects).rows).toEqual(t1.rows);
    } finally {
      release();
      await hub.cleanup();
    }
  }, 180_000);

  it("stores today's estimate on a hub with no system face (the test helpers' default)", async () => {
    const hub = await startHub();
    try {
      const hash = await storeDeck(hub, await zipDeck(koreanDeck(), dir, 'korean-none.pptx'));
      const job = await waitJob(hub, hub.imports.pptx.queueNative(hash, 'Korean.pptx', {}).id, 120_000);
      expect(job.state).toBe('done');
      expect(job.log.join('\n')).not.toMatch(/this computer's face/);
      const id = (job.result as { presentationId: string }).presentationId;
      expect(cellSpacing(tableOf(slidesOf(hub.lib.presentations.must(id))[0]!.objects))).not.toBeCloseTo(
        1.26 / 1.2,
        3,
      );
    } finally {
      await hub.cleanup();
    }
  }, 180_000);
});
