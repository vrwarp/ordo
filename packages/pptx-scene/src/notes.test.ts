import { describe, expect, it } from 'vitest';
import { MAX_NOTES_CHARS, readNotes } from './notes.ts';
import { openPackage, type PartSource } from './opc.ts';
import { br, buildDeck, NS_A, NS_P, NS_R, para, run } from './test-util.ts';

const NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;
const enc = new TextEncoder();
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';
/** A fallback branch that must not be read. */
const notesFallback =
  '<p:sp><p:nvSpPr><p:cNvPr id="20" name="f"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:spPr/>' +
  '<p:txBody><a:bodyPr/><a:p><a:r><a:t>fallback</a:t></a:r></a:p></p:txBody></p:sp>';

/** A notes slide: one shape per entry, `[placeholder type, inner txBody XML]`. */
function notesXml(shapes: [string | undefined, string][], wrap = (s: string) => s): string {
  const sp = shapes
    .map(
      ([type, txBody], i) =>
        `<p:sp><p:nvSpPr><p:cNvPr id="${i + 2}" name="s${i}"/><p:cNvSpPr/><p:nvPr>${type ? `<p:ph type="${type}" idx="${i + 1}"/>` : ''}</p:nvPr></p:nvSpPr>` +
        `<p:spPr/><p:txBody><a:bodyPr/>${txBody}</p:txBody></p:sp>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${wrap(sp)}</p:spTree></p:cSld></p:notes>`;
}

/** A two-slide deck whose first slide has the notes part `xml`. */
function deckWithNotes(xml: string): PartSource {
  const parts = buildDeck({
    slides: [{ rels: [{ id: 'rId9', type: 'notesSlide', target: '../notesSlides/notesSlide1.xml' }] }, {}],
  });
  parts.set('ppt/notesSlides/notesSlide1.xml', enc.encode(xml));
  return parts;
}

const notesOf = (parts: PartSource, slide = 1) =>
  readNotes(openPackage(parts), `ppt/slides/slide${slide}.xml`);

describe('readNotes', () => {
  it('reads the body placeholder: paragraphs on their own lines, breaks and fields kept', () => {
    const parts = deckWithNotes(
      notesXml([
        ['sldImg', para(run('not notes'))],
        [
          'body',
          para(run('Welcome everyone') + br + run('then the reading')) +
            para(`<a:fld id="{1}" type="slidenum"><a:t>3</a:t></a:fld>${run(' Psalm 23')}`) +
            para(''),
        ],
        ['sldNum', para(run('7'))],
        [undefined, para(run('a text box'))],
      ]),
    );
    expect(notesOf(parts)).toBe('Welcome everyone\nthen the reading\n3 Psalm 23');
    expect(notesOf(parts, 2)).toBeUndefined();
  });

  it('reads bodies inside groups and alternate content, joins several, and drops control characters', () => {
    const parts = deckWithNotes(
      notesXml(
        [
          ['body', para(run('first'))],
          ['body', para('<a:r><a:t>second&#x7;&#x1b;[31m</a:t></a:r>')],
        ],
        (sp) =>
          `<mc:AlternateContent xmlns:mc="${MC}"><mc:Choice xmlns:p14="${P14}" Requires="p14">` +
          `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${sp}</p:grpSp>` +
          `</mc:Choice><mc:Fallback>${notesFallback}</mc:Fallback></mc:AlternateContent>`,
      ),
    );
    expect(notesOf(parts)).toBe('first\nsecond[31m');
  });

  it('is bounded and never throws on a broken or hostile notes part', () => {
    const long = Array.from({ length: 3_000 }, (_, i) => para(run(`line ${i} of the sermon notes`))).join('');
    const text = notesOf(deckWithNotes(notesXml([['body', long]])));
    expect(text!.length).toBeLessThanOrEqual(MAX_NOTES_CHARS);
    expect(text!.startsWith('line 0 of the sermon notes\nline 1')).toBe(true);
    const logs: string[] = [];
    const broken = deckWithNotes('<!DOCTYPE x [<!ENTITY a "aaaa">]><p:notes/>');
    expect(
      readNotes(
        openPackage(broken, (m) => logs.push(m)),
        'ppt/slides/slide1.xml',
      ),
    ).toBeUndefined();
    expect(logs.join('\n')).toMatch(/notes of ppt\/slides\/slide1\.xml could not be read/);
    // A notes relationship naming another kind of part is not notes.
    const wrong = deckWithNotes(`<p:sld ${NS}/>`);
    expect(notesOf(wrong)).toBeUndefined();
  });
});
