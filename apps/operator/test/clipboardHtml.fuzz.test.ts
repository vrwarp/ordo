/**
 * The clipboard HTML readers on random HTML (design/21: clipboard HTML is untrusted input): 3,000 random
 * documents built from the pieces real and hostile pastes are made of (tags opened and never closed, quotes,
 * comments, entities past Unicode, ordo payloads with broken or hostile JSON) never make `htmlToRichText`
 * or `parseObjectsFromHtml` throw, and what they return holds: runs sorted, inside the text and at most
 * 2,000; at most one paragraph style per line; the text within CLIPBOARD_LIMITS.text; every pasted object
 * passes the schema with no re-import identity.
 */
import { SlideObject } from '@ordo/domain';
import { sanitizeObject } from '@ordo/importers/sanitize.ts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLIPBOARD_LIMITS, htmlToRichText, parseObjectsFromHtml } from '../src/views/editor/ops/index.ts';

const goodObject = {
  id: 'o1',
  type: 'shape',
  box: { x: 10, y: 10, w: 100, h: 50, rotation: 15 },
  shape: 'rect',
  opacity: 1,
  radius: 0,
  origin: { src: 'pptx', shapeId: 3, ph: 'body', group: 2 },
};
const enc = (v: unknown) => JSON.stringify(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const piece = fc.oneof(
  fc.constantFrom(
    '<p>',
    '</p>',
    '<div>',
    '</div>',
    '<br>',
    '<b>',
    '</b>',
    '<i>',
    '<sup class="versenum">',
    '</sup>',
    '<span class="woj">',
    '<span style="color: #c00; font-weight: bold; background-color: rgb(1,2,3)">',
    '<span style="font-family: \'Gentium\', serif; text-transform: uppercase">',
    '</span>',
    '<ul>',
    '<ol start="17">',
    '<li>',
    '</li>',
    '</ul>',
    '</ol>',
    '<pre>',
    '</pre>',
    '<script>',
    '</script>',
    '<style>',
    '<!--',
    '-->',
    '<!DOCTYPE html>',
    '<',
    '>',
    '"',
    "'",
    '=',
    '<a href="x>y">',
    '<a title=',
    '&nbsp;',
    '&amp;',
    '&#160;',
    '&#x1F600;',
    '&#99999999;',
    '&#x110000;',
    '&bogus;',
    '\n',
    '\t',
    ' ',
    'Amen',
    'שלום',
    '😀',
    '\ud800',
    `<div data-ordo-objects="${enc({ objects: [goodObject] })}">`,
    `<div data-ordo-objects="${enc({ v: 1, objects: [goodObject, { id: 'x', type: 'text' }, null] })}">`,
    '<div data-ordo-objects="{&quot;objects&quot;:[">',
    `<div data-ordo-rich="${enc({ text: 'Amen', runs: [{ start: 0, end: 9, fontWeight: 700 }, null] })}">`,
    `<div data-ordo-rich="${enc({ v: 1, text: 'ab\ncd', paras: [null, { align: 'center' }, { align: 'right' }] })}">`,
    '<div data-ordo-rich="not json">',
  ),
  fc.string({ maxLength: 12 }),
);
const doc = fc.array(piece, { maxLength: 60 }).map((a) => a.join(''));

describe('the clipboard HTML readers on random HTML', () => {
  it('never throw, and what they return holds', () => {
    fc.assert(
      fc.property(doc, (html) => {
        const r = htmlToRichText(html, { color: { r: 255, g: 255, b: 255, a: 1 } } as never);
        if (r) {
          expect(r.text.length).toBeLessThanOrEqual(CLIPBOARD_LIMITS.text + 4);
          let at = 0;
          for (const run of r.runs ?? []) {
            expect(run.start).toBeGreaterThanOrEqual(at);
            expect(run.end).toBeGreaterThan(run.start);
            expect(run.end).toBeLessThanOrEqual(r.text.length);
            at = run.end;
          }
          expect((r.runs ?? []).length).toBeLessThanOrEqual(2000);
          expect((r.paras ?? []).length).toBeLessThanOrEqual(r.text.split('\n').length);
        }
        for (const sanitize of [undefined, sanitizeObject]) {
          const o = parseObjectsFromHtml(html, sanitize);
          if (!o) continue;
          expect(o.objects.length).toBeGreaterThan(0);
          for (const x of o.objects) {
            expect(SlideObject.safeParse(x).success).toBe(true);
            expect(x.origin?.shapeId).toBeUndefined();
            expect(x.origin?.ph).toBeUndefined();
          }
        }
      }),
      { numRuns: 3000, seed: 20261113 },
    );
  });
});
