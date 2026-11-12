import { describe, expect, it } from 'vitest';
import { importPro7 } from './pro7.ts';
import { pro7Type } from './proto.ts';

const enc = new TextEncoder();

function rtf(text: string): Uint8Array {
  return enc.encode(
    `{\\rtf1\\ansi\\ansicpg1252\\cocoartf2639\n{\\fonttbl\\f0\\fnil\\fcharset0 Helvetica;}\n` +
      `{\\colortbl;\\red255\\green255\\blue255;\\red255\\green255\\blue255;}\n` +
      `\\pard\\qc\n\\f0\\fs120 \\cf2 ${text}}`,
  );
}

const uuid = (s: string) => ({ string: s });

function textCue(
  id: string,
  text: string,
): {
  uuid: { string: string };
  name: string;
  isEnabled: boolean;
  actions: Array<Record<string, unknown>>;
} {
  return {
    uuid: uuid(id),
    name: `Cue ${id}`,
    isEnabled: true,
    actions: [
      {
        uuid: uuid(`A-${id}`),
        type: 'ACTION_TYPE_PRESENTATION_SLIDE',
        isEnabled: true,
        slide: {
          presentation: {
            baseSlide: {
              size: { width: 1920, height: 1080 },
              uuid: uuid(`S-${id}`),
              elements: [
                {
                  element: {
                    uuid: uuid(`E-${id}`),
                    name: 'Text',
                    bounds: { origin: { x: 100, y: 150 }, size: { width: 1720, height: 780 } },
                    opacity: 1,
                    text: { rtfData: rtf(text), verticalAlignment: 'VERTICAL_ALIGNMENT_MIDDLE' },
                  },
                },
              ],
            },
          },
        },
      },
    ],
  };
}

function mediaAction(path: string) {
  return {
    uuid: uuid(`M-${path}`),
    type: 'ACTION_TYPE_MEDIA',
    isEnabled: true,
    media: {
      layerType: 'LAYER_TYPE_BACKGROUND',
      element: {
        uuid: uuid(`ME-${path}`),
        url: {
          absoluteString: `file:///Media/${path}`,
          platform: 'PLATFORM_MACOS',
          local: { root: 'ROOT_USER_DOCUMENTS', path: `Media/${path}` },
        },
        video: {},
      },
      video: { playbackBehavior: 'PLAYBACK_BEHAVIOR_LOOP' },
    },
  };
}

function encodePresentation(obj: Record<string, unknown>): Uint8Array {
  const T = pro7Type('rv.data.Presentation');
  const err = T.verify(T.fromObject(obj));
  if (err) throw new Error(err);
  return T.encode(T.fromObject(obj)).finish();
}

describe('pro7 exportCompat option', () => {
  it('propagates or lifts background media by default and preserves per-slide background with exportCompat: true', () => {
    const cue1 = textCue('1', 'Slide One');
    cue1.actions.push(mediaAction('bg.mp4'));
    const cue2 = textCue('2', 'Slide Two');
    const cue3 = textCue('3', 'Slide Three');

    const presDoc = {
      uuid: uuid('pres-1'),
      name: 'Test Presentation',
      cues: [cue1, cue2, cue3],
    };

    const presBytes = encodePresentation(presDoc);
    const files = new Map<string, Uint8Array>([
      ['Test.pro', presBytes],
      ['Media/bg.mp4', new Uint8Array(0)],
    ]);

    // Default import (exportCompat is falsy)
    const defResult = importPro7(files);
    expect(defResult.presentations).toHaveLength(1);
    const defPres = defResult.presentations[0]!;
    const defSlides = defPres.sections.flatMap((s) => s.slides);
    expect(defSlides).toHaveLength(3);

    // In default mode, Cue 1 background propagates across all 3 slides and is lifted to presentation level
    expect(defPres.backgroundMediaId).toBeDefined();
    expect(defSlides[0]!.backgroundMediaId).toBeUndefined();
    expect(defSlides[1]!.backgroundMediaId).toBeUndefined();
    expect(defSlides[2]!.backgroundMediaId).toBeUndefined();

    // With exportCompat: true
    const compatResult = importPro7(files, { exportCompat: true });
    expect(compatResult.presentations).toHaveLength(1);
    const compatPres = compatResult.presentations[0]!;
    const compatSlides = compatPres.sections.flatMap((s) => s.slides);
    expect(compatSlides).toHaveLength(3);

    // Slide 1 keeps backgroundMediaId, Slides 2 and 3 do not, presentation has no backgroundMediaId
    expect(compatPres.backgroundMediaId).toBeUndefined();
    expect(compatSlides[0]!.backgroundMediaId).toBeDefined();
    expect(compatSlides[1]!.backgroundMediaId).toBeUndefined();
    expect(compatSlides[2]!.backgroundMediaId).toBeUndefined();
  });
});
