import { describe, expect, it } from 'vitest';
import { normalizePart } from './markup.ts';
import { CLRMAP_OVR, NS_A, NS_P, NS_R, timingXml } from './test-util.ts';
import { gainDbOf, MAX_TIMING_NODES, readSlideTiming } from './timing.ts';
import { parseXml, rootOf, type XNode } from './xml.ts';
import { budgetMs } from '@ordo/domain/timing.test-util.ts';

const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/** A slide root with `after` following its (empty) shape tree, normalised as `Package.xml` reads it. */
function slide(after: string): XNode {
  const root = rootOf(
    parseXml(`<p:sld ${NS}><p:cSld><p:spTree/></p:cSld>${CLRMAP_OVR}${after}</p:sld>`, 's'),
  )!;
  normalizePart(root, { strict: false, percents: false });
  return root;
}

describe('readSlideTiming: the p:timing mapping (design/27 §8)', () => {
  it('starts a clip by itself when an after- or with-previous play effect comes before the first click', () => {
    const t = readSlideTiming(
      slide(
        timingXml([
          { spid: 4, kind: 'video', start: 'auto' },
          { spid: 5, kind: 'audio', start: 'with' },
        ]),
      ),
    );
    expect(t.media.get(4)?.start).toBe('auto');
    expect(t.media.get(5)?.start).toBe('auto');
    expect(t.media.get(4)?.kind).toBe('video');
    expect(t.media.get(5)?.kind).toBe('audio');
  });

  it('waits for a click: a click effect, a trigger, or a play effect after the first click', () => {
    const t = readSlideTiming(
      slide(
        timingXml([
          { spid: 4, kind: 'video', start: 'click' },
          { spid: 5, kind: 'video', start: 'trigger' },
          { spid: 6, kind: 'audio', start: 'late' },
        ]),
      ),
    );
    expect(t.media.get(4)?.start).toBe('click');
    expect(t.media.get(5)?.start).toBe('click');
    expect(t.media.get(6)?.start).toBe('click');
  });

  it('keeps an automatic start when a trigger also toggles the clip (as PowerPoint writes "Automatically")', () => {
    const auto = timingXml([{ spid: 4, kind: 'video', start: 'auto' }]);
    const both = auto.replace(
      '</p:childTnLst></p:cTn></p:par></p:tnLst>',
      `${timingXml([{ spid: 4, kind: 'video', start: 'trigger' }]).match(/<p:seq concurrent="1" nextAc="seek"><p:cTn id="\d+" restart[\s\S]*<\/p:seq>/)![0]}</p:childTnLst></p:cTn></p:par></p:tnLst>`,
    );
    expect(both).toContain('interactiveSeq');
    expect(readSlideTiming(slide(both)).media.get(4)?.start).toBe('auto');
  });

  it('leaves the start open when nothing plays the clip (PowerPoint shows play controls)', () => {
    const t = readSlideTiming(slide(timingXml([{ spid: 4, kind: 'video', start: 'none' }])));
    expect(t.media.get(4)).toBeDefined();
    expect(t.media.get(4)?.start).toBeUndefined();
  });

  it('reads loop, rewind, volume, mute, hide while stopped, numSld, full screen and narration', () => {
    const t = readSlideTiming(
      slide(
        timingXml([
          {
            spid: 4,
            kind: 'video',
            start: 'auto',
            loop: true,
            rewind: true,
            vol: 50_000,
            mute: true,
            showWhenStopped: false,
            fullScrn: true,
          },
          { spid: 7, kind: 'audio', start: 'auto', numSld: 3, narration: true },
        ]),
      ),
    );
    expect(t.media.get(4)).toEqual({
      start: 'auto',
      loop: true,
      rewind: true,
      vol: 50_000,
      muted: true,
      showWhenStopped: false,
      fullScreen: true,
      narration: false,
      kind: 'video',
    });
    expect(t.media.get(7)).toMatchObject({ slides: 3, narration: true, loop: false, rewind: false });
  });

  it('clamps numbers and ignores ones it cannot read', () => {
    const t = readSlideTiming(
      slide(
        timingXml([
          { spid: 4, kind: 'audio', start: 'auto', vol: 900_000, numSld: 5_000 },
          { spid: 5, kind: 'audio', start: 'auto', vol: -3 },
        ])
          .replace('numSld="5000"', 'numSld="5000"')
          .replace('vol="-3"', 'vol="NaN"'),
      ),
    );
    expect(t.media.get(4)).toMatchObject({ vol: 100_000, slides: 999 });
    expect(t.media.get(5)?.vol).toBeUndefined();
  });

  it('reads the transition sound and counts animation sounds, which are not clips', () => {
    const anim =
      '<p:audio><p:cMediaNode><p:cTn display="0"/><p:tgtEl><p:sndTgt r:embed="rId9" name="whoosh.wav"/></p:tgtEl></p:cMediaNode></p:audio>';
    const t = readSlideTiming(
      slide(
        '<p:transition spd="slow"><p:fade/><p:sndAc><p:stSnd loop="1"><p:snd r:embed="rId7" name="chime.wav"/></p:stSnd></p:sndAc></p:transition>' +
          timingXml([], anim),
      ),
    );
    expect(t.transitionSound).toEqual({ rid: 'rId7', loop: true });
    expect(t.animationSounds).toBe(1);
    expect(t.media.size).toBe(0);
  });

  it('reads the timing and the transition inside the branch of mc:AlternateContent it understands', () => {
    const timing = timingXml([{ spid: 4, kind: 'video', start: 'auto', loop: true }]);
    const t = readSlideTiming(
      slide(
        `<mc:AlternateContent xmlns:mc="${MC}" xmlns:p14="${P14}"><mc:Choice Requires="p14"><p:transition p14:dur="900"><p:fade/><p:sndAc><p:stSnd><p:snd r:embed="rId3" name="a.wav"/></p:stSnd></p:sndAc></p:transition></mc:Choice>` +
          '<mc:Fallback><p:transition><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>' +
          `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice Requires="p14" xmlns:p14="${P14}">${timing}</mc:Choice><mc:Fallback/></mc:AlternateContent>`,
      ),
    );
    expect(t.transitionSound?.rid).toBe('rId3');
    expect(t.media.get(4)).toMatchObject({ start: 'auto', loop: true });
  });

  it('plays a clip a play effect names even when no media node describes it', () => {
    const t = readSlideTiming(
      slide(
        timingXml([{ spid: 4, kind: 'video', start: 'auto' }]).replace(/<p:video>[\s\S]*<\/p:video>/, ''),
      ),
    );
    expect(t.media.get(4)).toMatchObject({ start: 'auto', loop: false, showWhenStopped: true });
  });

  it('a pause or stop effect does not start a clip', () => {
    const t = readSlideTiming(
      slide(timingXml([{ spid: 4, kind: 'video', start: 'auto' }]).replace('playFrom(0.0)', 'stop')),
    );
    expect(t.media.get(4)?.start).toBeUndefined();
  });

  it('stays bounded on a timing tree far past the element budget', () => {
    const effect = timingXml([{ spid: 4, kind: 'video', start: 'auto' }]).match(
      /<p:par><p:cTn id="\d+" fill="hold"><p:stCondLst><p:cond delay="0"\/>[\s\S]*?<\/p:par><\/p:childTnLst><\/p:cTn><\/p:par>/,
    )![0];
    const many = timingXml([{ spid: 4, kind: 'video', start: 'auto' }]).replace(
      '<p:childTnLst><p:par>',
      `<p:childTnLst>${effect.repeat(Math.floor(240_000 / effect.split('<').length))}<p:par>`,
    );
    // About as many elements as the walk's budget: every one of them plays clip 4.
    expect(many.split('<').length).toBeGreaterThan(MAX_TIMING_NODES * 2);
    const t0 = performance.now();
    const t = readSlideTiming(slide(many));
    expect(performance.now() - t0).toBeLessThan(budgetMs(5_000));
    expect(t.media.size).toBeLessThanOrEqual(1_000);
  });
});

describe('gainDbOf', () => {
  it('is 20·log10(vol/100,000), clamped to −100 .. 0, undefined when not written', () => {
    expect(gainDbOf(undefined)).toBeUndefined();
    expect(gainDbOf(100_000)).toBe(0);
    expect(gainDbOf(80_000)).toBe(-1.94);
    expect(gainDbOf(50_000)).toBe(-6.02);
    expect(gainDbOf(0)).toBe(-100);
    expect(gainDbOf(1)).toBe(-100);
    expect(gainDbOf(200_000)).toBe(0);
  });
});
