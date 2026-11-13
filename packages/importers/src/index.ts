/**
 * Importers (design/20): pure functions from input bytes to domain entities plus a log, runnable in Node
 * (hub jobs) and in the browser.
 */
export { readZip, safeEntryPath, ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL_BYTES } from './zip.ts';
export {
  importPro7,
  isPlaylistCandidate,
  pro7UrlPath,
  sectionLabelFor,
  PRO7_MEDIA_PREFIX,
  type ImportLogEntry,
  type ImportLogLevel,
  type Pro7ImportOptions,
  type Pro7ImportResult,
  type Pro7PresRef,
} from './pro7.ts';
export { PRO7_PROTO_VERSION, pro7Root, pro7Type, decodeAs } from './proto.ts';
export { PPTX_MEDIA_PREFIX, remapMediaIds } from './remap.ts';
export { extractPptxText, type PptxText, pptxForRendering } from './pptx.ts';
export { parseSongFile } from './songselect.ts';
export { parseRtf, splitFontName, type RtfResult } from './rtf.ts';
export { sha256Hex, sha256Bytes } from './sha256.ts';
export {
  pictureHeader,
  clearExifOrientation,
  displayNeeds,
  isMetafile,
  METAFILE_FORMATS,
  PICTURE_LIMITS,
  type PictureHeader,
} from './pptx-pictures.ts';
export { geomFileOf, nameGeoms, type NamedGeomFile } from './pptx-geoms.ts';
export {
  importPptxClient,
  type PptxClientOptions,
  type PptxClientImportResult,
  type PptxClientPicture,
  type PptxClientScene,
  type PptxClientSceneScan,
  type PptxClientSlideExtra,
  type PptxLoSlide,
  CLIENT_M9_WRITES,
  CLIENT_SHEETS,
  CONVERTER_VERSION,
  PPTX_CLIENT_LIMITS,
} from './pptx-client.ts';
