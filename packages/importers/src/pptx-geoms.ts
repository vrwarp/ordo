/**
 * Geometry file extraction, naming and hashing for PowerPoint imports.
 * Pure TypeScript: runs in Node.js, browsers, and Web Workers.
 */
import { GEOM_FILE_MAX_BYTES, GeomFile, type ShapeGeom, type Slide, type SlideObject } from '@ordo/domain';
import { sanitizeGeom } from './sanitize.ts';
import { sha256Hex } from './sha256.ts';

export type NamedGeomFile = { hash: string; bytes: Uint8Array };

export function geomFileOf(file: unknown): NamedGeomFile | undefined {
  const paths = file && typeof file === 'object' ? (file as { paths?: unknown }).paths : undefined;
  if (!Array.isArray(paths)) return undefined;
  const clean = sanitizeGeom({ paths } as ShapeGeom)?.paths;
  const ok = GeomFile.safeParse({ paths: clean });
  if (!ok.success) return undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(ok.data));
  if (bytes.length > GEOM_FILE_MAX_BYTES) return undefined;
  return { hash: sha256Hex(bytes), bytes };
}

export function nameGeoms(slide: Slide, names: ReadonlyMap<string, string>): Slide {
  let changed = false;
  const rename = (g: ShapeGeom): ShapeGeom | undefined => {
    const { ref, ...rest } = g;
    const name = ref === undefined ? undefined : names.get(ref);
    if (name === ref) return g;
    changed = true;
    const out: ShapeGeom = name ? { ...rest, ref: name } : rest;
    return out.preset || out.paths || out.ref ? out : undefined;
  };
  const objects = slide.objects.map((o): SlideObject => {
    if (o.type === 'shape' && o.geom?.ref !== undefined) {
      const geom = rename(o.geom);
      if (geom === o.geom) return o;
      const { geom: _g, ...rest } = o;
      return geom ? { ...rest, geom } : rest;
    }
    if (o.type === 'image' && o.mask?.ref !== undefined) {
      const mask = rename(o.mask);
      if (mask === o.mask) return o;
      const { mask: _m, ...rest } = o;
      return mask ? { ...rest, mask } : rest;
    }
    return o;
  });
  return changed ? { ...slide, objects } : slide;
}
