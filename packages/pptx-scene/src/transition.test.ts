import { describe, expect, it } from 'vitest';
import { openPackage, type PartSource } from './opc.ts';
import { buildDeck, partText } from './test-util.ts';
import { DEFAULT_TRANSITION_MS, readSlideTransition, readTransition, showLoops } from './transition.ts';

const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
const enc = new TextEncoder();

/**
 * The transition read from a one-slide deck whose `p:sld` ends with `after`: from the whole slide and from
 * its tail alone, which must agree.
 */
function transitionOf(after: string) {
  const parts = buildDeck({
    slides: [{ after: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${after}` }],
  });
  const pkg = openPackage(parts);
  const whole = readTransition(pkg.xml('ppt/slides/slide1.xml', { keep: false })!);
  expect(readSlideTransition(pkg, 'ppt/slides/slide1.xml')).toEqual(whole);
  return whole;
}

/** PowerPoint 2010's form: the p14 branch with its duration, a plain fallback. */
const alternate = (choice: string, fallback: string) =>
  `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14">${choice}</mc:Choice>` +
  `<mc:Fallback>${fallback}</mc:Fallback></mc:AlternateContent>`;

describe('readTransition', () => {
  it('reads fades and dissolves as crossfades with the p14 duration, else spd, else 700 ms', () => {
    expect(
      transitionOf(
        alternate(
          '<p:transition spd="slow" p14:dur="2000" advTm="5000"><p:fade/></p:transition>',
          '<p:transition spd="slow" advTm="5000"><p:fade/></p:transition>',
        ),
      ),
    ).toEqual({ transition: { kind: 'crossfade', ms: 2000 }, advanceMs: 5000 });
    expect(transitionOf('<p:transition spd="med"><p:dissolve/></p:transition>')).toEqual({
      transition: { kind: 'crossfade', ms: 750 },
    });
    expect(transitionOf('<p:transition><p:fade/></p:transition>')).toEqual({
      transition: { kind: 'crossfade', ms: DEFAULT_TRANSITION_MS },
    });
    expect(transitionOf('<p:transition><p:fade thruBlk="1"/></p:transition>')).toEqual({
      transition: { kind: 'crossfade', ms: DEFAULT_TRANSITION_MS },
      note: 'a fade through black is shown as a crossfade',
    });
  });

  it('reads a cut, a transition without an effect as a cut, and no transition as none', () => {
    expect(transitionOf('<p:transition><p:cut/></p:transition>')).toEqual({ transition: { kind: 'cut' } });
    expect(transitionOf('<p:transition advTm="3000"/>')).toEqual({
      transition: { kind: 'cut' },
      advanceMs: 3000,
    });
    expect(transitionOf('<p:transition><p:sndAc><p:stSnd/></p:sndAc></p:transition>')).toEqual({
      transition: { kind: 'cut' },
    });
    expect(transitionOf('')).toEqual({});
  });

  it('shows other effects as a crossfade with a note, and bounds every number', () => {
    expect(
      transitionOf(
        alternate(
          '<p:transition spd="slow" p14:dur="1250"><p14:vortex dir="r"/></p:transition>',
          '<p:transition spd="slow"><p:fade/></p:transition>',
        ),
      ),
    ).toEqual({
      transition: { kind: 'crossfade', ms: 1250 },
      note: 'a vortex transition is shown as a crossfade',
    });
    expect(transitionOf('<p:transition><p:push dir="u"/></p:transition>').note).toBe(
      'a push transition is shown as a crossfade',
    );
    expect(
      transitionOf(
        alternate('<p:transition p14:dur="1e12" advTm="1e300"><p:fade/></p:transition>', '<p:transition/>'),
      ),
    ).toEqual({ transition: { kind: 'crossfade', ms: 10_000 }, advanceMs: 86_400_000 });
    expect(transitionOf('<p:transition p14:dur="NaN" advTm="-5"><p:fade/></p:transition>')).toEqual({
      transition: { kind: 'crossfade', ms: DEFAULT_TRANSITION_MS },
    });
  });
});

describe('showLoops', () => {
  function withProps(props: string | undefined): PartSource {
    const parts = buildDeck({ slides: [{}] });
    if (props === undefined) return parts;
    const rels = partText(parts, 'ppt/_rels/presentation.xml.rels').replace(
      '</Relationships>',
      '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps" Target="presProps.xml"/></Relationships>',
    );
    parts.set('ppt/_rels/presentation.xml.rels', enc.encode(rels));
    parts.set('ppt/presProps.xml', enc.encode(props));
    return parts;
  }
  const pr = (inner: string) =>
    `<p:presentationPr xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${inner}</p:presentationPr>`;

  it('reads p:showPr loop from the presentation properties', () => {
    expect(showLoops(openPackage(withProps(pr('<p:showPr loop="1" showNarration="1"/>'))))).toBe(true);
    expect(showLoops(openPackage(withProps(pr('<p:showPr showNarration="1"/>'))))).toBe(false);
    expect(showLoops(openPackage(withProps(undefined)))).toBe(false);
    expect(showLoops(openPackage(withProps('<!DOCTYPE x><p:presentationPr/>')))).toBe(false);
  });
});

describe('readSlideTransition', () => {
  const fade = '<p:transition spd="slow" advTm="3000"><p:fade/></p:transition>';
  const read = (xml: string) => {
    const parts = buildDeck({ slides: [{}] });
    parts.set('ppt/slides/slide1.xml', enc.encode(xml));
    return readSlideTransition(openPackage(parts), 'ppt/slides/slide1.xml');
  };
  const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const want = { transition: { kind: 'crossfade', ms: 1000 }, advanceMs: 3000 };

  it("reads a slide's tail whatever prefix or default namespace the deck uses", () => {
    const pml = fade.replaceAll('p:', 'pml:');
    expect(read(`<pml:sld xmlns:pml="${P}"><pml:cSld><pml:spTree/></pml:cSld>${pml}</pml:sld>`)).toEqual(
      want,
    );
    expect(read(`<sld xmlns="${P}"><cSld><spTree/></cSld>${fade.replaceAll('p:', '')}</sld>`)).toEqual(want);
  });

  it('is empty for a slide without a shape tree end, a broken tail or a missing part', () => {
    expect(read(`<p:sld xmlns:p="${P}">${fade}</p:sld>`)).toEqual({});
    expect(read(`<p:sld xmlns:p="${P}"><p:cSld></p:cSld><!DOCTYPE x>${fade}</p:sld>`)).toEqual({});
    expect(readSlideTransition(openPackage(buildDeck({ slides: [{}] })), 'ppt/slides/slide9.xml')).toEqual(
      {},
    );
  });
});
