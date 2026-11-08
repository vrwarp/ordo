/**
 * Fuzzing of the PowerPoint text extractor (design/25 "Fuzzing"): random bytes, random XML, mutated real
 * slide XML and archives with missing parts must either resolve with finite, bounded boxes or reject with
 * an Error; never hang, never return NaN or Infinity.
 */
import JSZip from 'jszip';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extractPptxText, PPTX_MAX_SLIDES } from './pptx.ts';
import { IMPORT_LIMITS } from './sanitize.ts';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Slide XML as PowerPoint writes it (trimmed), used as the seed for mutations. */
const REAL_SLIDE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm rot="5400000"><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="4400" dirty="0"/><a:t>Welcome &amp; hello</a:t></a:r><a:br/><a:r><a:t>Line two</a:t></a:r></a:p></p:txBody></p:sp><p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="G"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="6096000" y="3429000"/><a:ext cx="3048000" cy="1714500"/><a:chOff x="0" y="0"/><a:chExt cx="6096000" cy="3429000"/></a:xfrm></p:grpSpPr><p:sp><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>Grouped</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp><p:graphicFrame><p:xfrm><a:off x="1" y="2"/><a:ext cx="3" cy="4"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Cell</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame></p:spTree></p:cSld></p:sld>`;
const PRES = (sz: string, ids: string) =>
  `<?xml version="1.0"?><p:presentation ${NS}><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz ${sz}/></p:presentation>`;
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`;

async function pptx(parts: Record<string, string | undefined>): Promise<Uint8Array> {
  const z = new JSZip();
  for (const [k, v] of Object.entries(parts)) if (v !== undefined) z.file(k, v);
  return z.generateAsync({ type: 'uint8array' });
}

/** Extract and check the bounds; says whether the file was accepted or rejected with a clean Error. */
async function check(buf: Uint8Array): Promise<'ok' | 'rejected'> {
  let res: Awaited<ReturnType<typeof extractPptxText>>;
  try {
    res = await extractPptxText(buf);
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(RangeError); // no stack overflow / invalid array length
    return 'rejected';
  }
  expect(res.slideSize.cx).toBeGreaterThan(0);
  expect(res.slideSize.cy).toBeGreaterThan(0);
  expect(res.slides.length).toBeLessThanOrEqual(PPTX_MAX_SLIDES);
  for (const s of res.slides)
    for (const b of s.boxes) {
      for (const v of Object.values(b.box)) expect(Number.isFinite(v)).toBe(true);
      expect(Math.abs(b.box.x)).toBeLessThanOrEqual(3840);
      expect(b.box.w).toBeGreaterThanOrEqual(0);
      expect(b.text.length).toBeLessThanOrEqual(IMPORT_LIMITS.text);
      if (b.fontSizePx !== undefined) {
        expect(b.fontSizePx).toBeGreaterThanOrEqual(IMPORT_LIMITS.fontSizeMin);
        expect(b.fontSizePx).toBeLessThanOrEqual(IMPORT_LIMITS.fontSizeMax);
      }
    }
  return 'ok';
}

/** `check` as a fast-check property body (which must resolve to void or a boolean). */
const holds = (buf: Uint8Array): Promise<void> => check(buf).then(() => undefined);

const attrNum = fc.oneof(
  fc.integer({ min: -2e9, max: 2e9 }).map(String),
  fc.constantFrom('0', '-0', 'NaN', 'Infinity', '1e999', '', 'abc', '-1'),
);
const xmlTok = fc.oneof(
  fc.constantFrom(
    '<p:sp>',
    '</p:sp>',
    '<p:txBody>',
    '</p:txBody>',
    '<a:p>',
    '</a:p>',
    '<a:r><a:t>',
    '</a:t></a:r>',
    '<a:br/>',
    '<p:grpSp>',
    '</p:grpSp>',
    '<p:spPr>',
    '</p:spPr>',
    '<a:xfrm>',
    '</a:xfrm>',
    '&amp;',
    '&#0;',
    '&#xD800;',
    '<![CDATA[x]]>',
    '<!-- c -->',
    '<',
    '>',
    '"',
  ),
  fc
    .tuple(fc.constantFrom('a:off', 'a:ext', 'a:chOff', 'a:chExt', 'a:rPr'), attrNum, attrNum)
    .map(([t, a, b]) => `<${t} x="${a}" y="${b}" cx="${a}" cy="${b}" sz="${a}"/>`),
  fc.string({ maxLength: 10 }),
);
const randomSlide = fc
  .array(xmlTok, { maxLength: 80 })
  .map(
    (t) => `<?xml version="1.0"?><p:sld ${NS}><p:cSld><p:spTree>${t.join('')}</p:spTree></p:cSld></p:sld>`,
  );
const mutatedSlide = fc
  .array(
    fc.tuple(fc.nat({ max: REAL_SLIDE.length }), fc.nat({ max: 30 }), fc.oneof(xmlTok, fc.constant(''))),
    {
      minLength: 1,
      maxLength: 10,
    },
  )
  .map((muts) => {
    let s = REAL_SLIDE;
    for (const [p, del, ins] of muts) s = s.slice(0, p) + ins + s.slice(p + del);
    return s;
  });

describe('extractPptxText (fuzz)', () => {
  it('random bytes reject cleanly', async () => {
    await fc.assert(
      // 300 random bytes are never a zip holding ppt/presentation.xml: each must be rejected, not accepted.
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), async (b) => {
        expect(await check(b)).toBe('rejected');
      }),
      { numRuns: 500 },
    );
  });

  it('random slide XML and slide sizes resolve within bounds', async () => {
    await fc.assert(
      fc.asyncProperty(randomSlide, attrNum, attrNum, async (slide, cx, cy) =>
        holds(
          await pptx({
            'ppt/presentation.xml': PRES(`cx="${cx}" cy="${cy}"`, '<p:sldId id="256" r:id="rId2"/>'),
            'ppt/_rels/presentation.xml.rels': RELS,
            'ppt/slides/slide1.xml': slide,
          }),
        ),
      ),
      { numRuns: 300 },
    );
  });

  it('mutated real slide XML resolves within bounds or rejects', async () => {
    await fc.assert(
      fc.asyncProperty(mutatedSlide, async (slide) =>
        holds(
          await pptx({
            'ppt/presentation.xml': PRES('cx="12192000" cy="6858000"', '<p:sldId id="256" r:id="rId2"/>'),
            'ppt/_rels/presentation.xml.rels': RELS,
            'ppt/slides/slide1.xml': slide,
          }),
        ),
      ),
      { numRuns: 300 },
    );
  });

  it('archives with missing parts resolve or reject', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), async ([a, b, c, d]) =>
        holds(
          await pptx({
            'ppt/presentation.xml': a
              ? PRES('cx="12192000" cy="6858000"', '<p:sldId id="256" r:id="rId2"/>')
              : undefined,
            'ppt/_rels/presentation.xml.rels': b ? RELS : undefined,
            'ppt/slides/slide1.xml': c ? REAL_SLIDE : undefined,
            'ppt/slides/_rels/slide1.xml.rels': d
              ? RELS.replace('slides/slide1.xml', '../slideLayouts/nowhere.xml')
              : undefined,
          }),
        ),
      ),
      { numRuns: 32 },
    );
  });
});

describe('extractPptxText regressions found by fuzzing', () => {
  it('a zero or negative slide size falls back instead of producing Infinity', async () => {
    for (const sz of ['cx="0" cy="0"', 'cx="-5" cy="6858000"', 'cx="1e999" cy="NaN"']) {
      const r = await extractPptxText(
        await pptx({
          'ppt/presentation.xml': PRES(sz, '<p:sldId id="256" r:id="rId2"/>'),
          'ppt/_rels/presentation.xml.rels': RELS,
          'ppt/slides/slide1.xml': REAL_SLIDE,
        }),
      );
      await check(await pptx({ 'ppt/presentation.xml': PRES(sz, '') }));
      expect(r.slides[0]!.boxes.length).toBeGreaterThan(0);
      for (const b of r.slides[0]!.boxes)
        for (const v of Object.values(b.box)) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('a group with a zero child extent does not explode the coordinates', async () => {
    const slide = REAL_SLIDE.replace('<a:chExt cx="6096000" cy="3429000"/>', '<a:chExt cx="1" cy="1"/>');
    await check(
      await pptx({
        'ppt/presentation.xml': PRES('cx="12192000" cy="6858000"', '<p:sldId id="256" r:id="rId2"/>'),
        'ppt/_rels/presentation.xml.rels': RELS,
        'ppt/slides/slide1.xml': slide,
      }),
    );
  });

  it('a slide list referencing one slide 100,000 times is bounded', async () => {
    const r = await extractPptxText(
      await pptx({
        'ppt/presentation.xml': PRES(
          'cx="12192000" cy="6858000"',
          '<p:sldId id="256" r:id="rId2"/>'.repeat(100_000),
        ),
        'ppt/_rels/presentation.xml.rels': RELS,
        'ppt/slides/slide1.xml': REAL_SLIDE,
      }),
    );
    expect(r.slides.length).toBeLessThanOrEqual(PPTX_MAX_SLIDES);
  });

  it('deeply nested groups are rejected or bounded, not a stack overflow', async () => {
    const g = '<p:grpSp>';
    const slide = REAL_SLIDE.replace(
      '</p:spTree>',
      `${g.repeat(20_000)}${'</p:grpSp>'.repeat(20_000)}</p:spTree>`,
    );
    await check(
      await pptx({
        'ppt/presentation.xml': PRES('cx="12192000" cy="6858000"', '<p:sldId id="256" r:id="rId2"/>'),
        'ppt/_rels/presentation.xml.rels': RELS,
        'ppt/slides/slide1.xml': slide,
      }),
    );
  });

  it('XML entity expansion (billion laughs) does not blow up', async () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE p:sld [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;"><!ENTITY g "&f;&f;&f;&f;&f;&f;&f;&f;&f;&f;">]>${REAL_SLIDE.replace(/^<\?xml[^>]*>/, '').replace('Line two', '&g;&g;&g;&g;&g;&g;&g;&g;&g;&g;')}`;
    const t0 = Date.now();
    await check(
      await pptx({
        'ppt/presentation.xml': PRES('cx="12192000" cy="6858000"', '<p:sldId id="256" r:id="rId2"/>'),
        'ppt/_rels/presentation.xml.rels': RELS,
        'ppt/slides/slide1.xml': bomb,
      }),
    );
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('long trailing whitespace in a text body is linear', async () => {
    const slide = REAL_SLIDE.replace('Line two', `x${' '.repeat(100_000)}y${' '.repeat(100_000)}`);
    const t0 = Date.now();
    await check(
      await pptx({
        'ppt/presentation.xml': PRES('cx="12192000" cy="6858000"', '<p:sldId id="256" r:id="rId2"/>'),
        'ppt/_rels/presentation.xml.rels': RELS,
        'ppt/slides/slide1.xml': slide,
      }),
    );
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});
