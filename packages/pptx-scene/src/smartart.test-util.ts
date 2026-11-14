/**
 * SmartArt test decks (M6, `smartart.ts`): a graphic frame, its data model naming the drawing, and the
 * drawing part with `dsp:` shapes, as PowerPoint writes them. Synthetic XML only; used with `test-util.ts`
 * `buildDeck` and `withPart`.
 */
import type { PartSource } from './opc.ts';
import { esc, NS_A, NS_R, withPart } from './test-util.ts';

const NS_DGM = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
const NS_DSP = 'http://schemas.microsoft.com/office/drawing/2008/diagram';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Relationship types of a SmartArt's parts, from the part holding the frame. */
export const DIAGRAM_RELS = {
  data: `${REL}/diagramData`,
  layout: `${REL}/diagramLayout`,
  style: `${REL}/diagramQuickStyle`,
  colors: `${REL}/diagramColors`,
  drawing: 'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing',
} as const;

/** A `p:graphicFrame` holding SmartArt whose data model is `rId` (`dmId`). */
export function smartArtFrame(o: {
  id: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
  dmId: string;
  rot?: number;
}): string {
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${o.id}" name="Diagram ${o.id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>` +
    `<p:xfrm${o.rot ? ` rot="${Math.round(o.rot * 60_000)}"` : ''}><a:off x="${o.x}" y="${o.y}"/><a:ext cx="${o.cx}" cy="${o.cy}"/></p:xfrm>` +
    `<a:graphic><a:graphicData uri="${NS_DGM}"><dgm:relIds xmlns:dgm="${NS_DGM}" xmlns:r="${NS_R}" r:dm="${o.dmId}" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

/**
 * A data model whose extension names the drawing as relationship `drawingId` (none: no drawing cache), its
 * points the document's (no text) and `points` (`dgm:pt` elements) after it.
 */
export function dataModelXml(drawingId?: string, points = ''): string {
  const ext = drawingId
    ? `<dgm:extLst><a:ext uri="${NS_DSP}"><dsp:dataModelExt xmlns:dsp="${NS_DSP}" relId="${drawingId}" minVer="${NS_DGM}"/></a:ext></dgm:extLst>`
    : '';
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<dgm:dataModel xmlns:dgm="${NS_DGM}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    `<dgm:ptLst><dgm:pt modelId="{0}" type="doc"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:p><a:endParaRPr/></a:p></dgm:t></dgm:pt>${points}</dgm:ptLst>` +
    `<dgm:cxnLst/><dgm:bg/><dgm:whole/>${ext}</dgm:dataModel>`
  );
}

export interface DspShape {
  x: number;
  y: number;
  cx: number;
  cy: number;
  rot?: number;
  geom?: string;
  /** Fill and line elements inside `dsp:spPr` (default: a solid fill of accent1 through the style). */
  fill?: string;
  ln?: string;
  /** Extra `dsp:spPr` children after the fill and line (`a:effectLst`, `a:sp3d` …). */
  extra?: string;
  /** `a:p` elements of the shape's text. */
  paras?: string;
  /** Attributes of `a:bodyPr`. */
  bodyPr?: string;
  /** The text rectangle (`dsp:txXfrm`). */
  tx?: { x: number; y: number; cx: number; cy: number; rot?: number };
  /** Style references (default: line 1, fill 1, effect 0, minor font in lt1, as SmartArt writes them). */
  style?: string;
}

const DEFAULT_STYLE =
  '<dsp:style><a:lnRef idx="1"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef><a:fillRef idx="1"><a:scrgbClr r="0" g="0" b="0"/></a:fillRef>' +
  '<a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dsp:style>';

let modelIds = 0;

/** One `dsp:sp`. */
export function dspSp(s: DspShape): string {
  const rot = s.rot ? ` rot="${Math.round(s.rot * 60_000)}"` : '';
  const tx = s.tx
    ? `<dsp:txXfrm${s.tx.rot ? ` rot="${Math.round(s.tx.rot * 60_000)}"` : ''}><a:off x="${s.tx.x}" y="${s.tx.y}"/><a:ext cx="${s.tx.cx}" cy="${s.tx.cy}"/></dsp:txXfrm>`
    : '';
  const text = s.paras
    ? `<dsp:txBody><a:bodyPr ${s.bodyPr ?? 'lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"'}><a:noAutofit/></a:bodyPr><a:lstStyle/>${s.paras}</dsp:txBody>`
    : '';
  return (
    `<dsp:sp modelId="{${++modelIds}}"><dsp:nvSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvSpPr/></dsp:nvSpPr>` +
    `<dsp:spPr><a:xfrm${rot}><a:off x="${s.x}" y="${s.y}"/><a:ext cx="${s.cx}" cy="${s.cy}"/></a:xfrm>` +
    `<a:prstGeom prst="${esc(s.geom ?? 'rect')}"><a:avLst/></a:prstGeom>${s.fill ?? '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>'}${s.ln ?? ''}${s.extra ?? ''}</dsp:spPr>` +
    `${s.style ?? DEFAULT_STYLE}${text}${tx}</dsp:sp>`
  );
}

/** A drawing part of `dsp:` shapes (`shapes`: `dspSp(...)` joined), its group properties `grpSpPr`. */
export function drawingXml(shapes: string, grpSpPr = '<dsp:grpSpPr/>'): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<dsp:drawing xmlns:dgm="${NS_DGM}" xmlns:dsp="${NS_DSP}" xmlns:a="${NS_A}" xmlns:r="${NS_R}">` +
    `<dsp:spTree><dsp:nvGrpSpPr><dsp:cNvPr id="0" name=""/><dsp:cNvGrpSpPr/></dsp:nvGrpSpPr>${grpSpPr}${shapes}</dsp:spTree></dsp:drawing>`
  );
}

/** Relationships of a part (its `.rels` part). */
export function relsXml(list: { id: string; type: string; target: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_PKG}">${list
    .map((r) => `<Relationship Id="${esc(r.id)}" Type="${esc(r.type)}" Target="${esc(r.target)}"/>`)
    .join('')}</Relationships>`;
}

/** A colours part whose `node0` style label lists `textColors` (colour elements) as its text fills. */
export function colorsXml(textColors: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<dgm:colorsDef xmlns:dgm="${NS_DGM}" xmlns:a="${NS_A}" uniqueId="urn:test">` +
    `<dgm:styleLbl name="node0"><dgm:fillClrLst meth="repeat"><a:schemeClr val="lt1"/></dgm:fillClrLst><dgm:txFillClrLst meth="repeat">${textColors}</dgm:txFillClrLst></dgm:styleLbl>` +
    `</dgm:colorsDef>`
  );
}

/**
 * Add SmartArt parts `n` (`ppt/diagrams/dataN.xml`, `drawingN.xml` unless `drawing` is undefined) to a built
 * deck. The slide's relationships must name them (`smartArtRels`).
 */
export function withSmartArt(
  parts: PartSource,
  n: number,
  drawing: string | undefined,
  drawingRels?: { id: string; type: string; target: string }[],
): PartSource {
  withPart(
    parts,
    `ppt/diagrams/data${n}.xml`,
    dataModelXml(drawing === undefined ? undefined : `rIdDrawing${n}`),
    'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml',
  );
  if (drawing !== undefined)
    withPart(
      parts,
      `ppt/diagrams/drawing${n}.xml`,
      drawing,
      'application/vnd.ms-office.drawingml.diagramDrawing+xml',
    );
  if (drawingRels) withPart(parts, `ppt/diagrams/_rels/drawing${n}.xml.rels`, relsXml(drawingRels));
  return parts;
}

/** The slide relationships of SmartArt `n` (`rIdDm<n>` the data model, `rIdDrawing<n>` the drawing). */
export function smartArtRels(
  n: number,
  drawing = true,
  colors = false,
): { id: string; type: string; target: string }[] {
  return [
    { id: `rIdDm${n}`, type: DIAGRAM_RELS.data, target: `../diagrams/data${n}.xml` },
    ...(drawing
      ? [{ id: `rIdDrawing${n}`, type: DIAGRAM_RELS.drawing, target: `../diagrams/drawing${n}.xml` }]
      : []),
    // `smartArtFrame` names its colours part `rIdCs`.
    ...(colors ? [{ id: 'rIdCs', type: DIAGRAM_RELS.colors, target: `../diagrams/colors${n}.xml` }] : []),
  ];
}
