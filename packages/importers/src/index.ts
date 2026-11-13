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
export { Sha256, sha256Blob, sha256Bytes, sha256Hex } from './sha256.ts';
export {
  clearExifOrientation,
  displayNeeds,
  isMetafile,
  METAFILE_FORMATS,
  PICTURE_LIMITS,
  type PictureHeader,
  pictureHeader,
} from './pptx-pictures.ts';
export { geomFileOf, type NamedGeomFile, nameGeoms, nameShapeFiles, SHAPE_FILE_KINDS } from './pptx-geoms.ts';
export { PPTX_IMPORT_LIMITS, type SceneScan, type SceneSlideExtra } from './pptx-scan.ts';
export {
  deckFaceNeeds,
  FACE_LIMITS,
  type FaceFile,
  FaceUnreadable,
  faceSourceOf,
  facesForDeck,
  type LibraryFace,
  loadDeckFaces,
  sfntFaceMetrics,
} from './pptx-faces.ts';
export { BoundedZip, ZipLimitError, zipSource } from './zip-bounded.ts';
export {
  type AssembleOptions,
  assemblePptxScene,
  CLIENT_M9_WRITES,
  CLIENT_SHEETS,
  LOOP_IMPORT_NOTE,
  CONVERTER_VERSION,
  importPptxClient,
  M9_WRITES,
  PPTX_CLIENT_LIMITS,
  type PptxClientImportResult,
  type PptxClientOptions,
  type PptxClientPicture,
  type PptxClientScene,
  type PptxLoSlide,
  type PptxSceneParse,
  parsePptxScene,
  sniffMediaKind,
} from './pptx-client.ts';
