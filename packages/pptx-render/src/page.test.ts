import { describe, expect, it } from 'vitest';
import { decodeMarker, encodeMarker, MARK_START } from './markers.ts';
import { takeMarkers } from './page.ts';
import { budgetMs } from './timing.test-util.ts';

describe('takeMarkers (run markers in the rendered page)', () => {
  it('removes every marker and returns the id of the first', () => {
    expect(takeMarkers(`${encodeMarker(5)}Hello`)).toEqual({ text: 'Hello', id: 5 });
    // pptx-preview can join runs into one text node.
    expect(takeMarkers(`${encodeMarker(60_000)}Now ${encodeMarker(3)}then`)).toEqual({
      text: 'Now then',
      id: 60_000,
    });
    expect(takeMarkers('plain')).toEqual({ text: 'plain' });
  });

  it("leaves a U+2064 that is not a marker: it is the deck's own text", () => {
    // Too few digits, then a marker.
    const odd = `a${MARK_START}\u2060b${MARK_START}`;
    expect(takeMarkers(odd)).toEqual({ text: odd });
    // The end of the text is not a digit.
    expect(decodeMarker(`x${MARK_START}`, 1)).toBeUndefined();
    expect(takeMarkers(`${MARK_START}${encodeMarker(9)}x${MARK_START}`)).toEqual({
      text: `${MARK_START}x${MARK_START}`,
      id: 9,
    });
  });

  it('takes one pass over a text of hundreds of thousands of U+2064', () => {
    const many = MARK_START.repeat(400_000);
    const t = performance.now();
    expect(takeMarkers(`${many}${encodeMarker(1)}${many}`)).toEqual({ text: many + many, id: 1 });
    expect(performance.now() - t).toBeLessThan(budgetMs(2000));
  });
});
