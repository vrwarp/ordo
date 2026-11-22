import type { Rgba } from '@ordo/domain';
import { compileGeom, type GeomSource, type PathCmdSource } from '@ordo/renderer/geom/compile.ts';
import { buildGeom, type BuiltGeom, type GeomPath } from '@ordo/renderer/geom/path.ts';
import type { RecipeMemberWire, RecipePathWire, RecipeWire } from '../src/pptx/raster-recipe.ts';

/*
 * Recipes written to the wire format of C-RM1 for the tests and the measures: synthetic shapes (set A), n-gons of
 * any size and text-bearing members. Built from the renderer's own compiler and builder with the wide limits, so a
 * recipe here is what the planner's converter will write.
 */

export const WIDE = { points: 262_144, paths: 64 } as const;

export const colour = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a });

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** One built path as the wire has it: command bytes and little-endian float32 points, both base64. */
export function pathWire(p: GeomPath, cont?: boolean): RecipePathWire {
  const pts = new Float32Array(p.pts as number[]);
  const le = Buffer.alloc(pts.length * 4);
  for (let i = 0; i < pts.length; i++) le.writeFloatLE(pts[i]!, i * 4);
  return {
    cmds: base64(Uint8Array.from(p.cmds)),
    pts: le.toString('base64'),
    fill: p.fill,
    stroke: p.stroke,
    ...(cont ? { cont: true as const } : {}),
  };
}

export type Box = { x: number; y: number; w: number; h: number };

/** A member: the stored shape fields (no geometry) and a built geometry at the shape's box. */
export function memberWire(
  box: Box,
  built: BuiltGeom,
  shape: Record<string, unknown> = {},
  extra: Partial<Pick<RecipeMemberWire, 'text' | 'families'>> = {},
): RecipeMemberWire {
  return {
    shape: {
      type: 'shape',
      box: { x: box.x, y: box.y, w: box.w, h: box.h, rotation: 0 },
      shape: 'rect',
      fill: colour(200, 60, 40),
      opacity: 1,
      radius: 0,
      ...shape,
    },
    geom: { paths: built.paths.map((p, i) => pathWire(p, false && i > 0)) },
    ...extra,
  };
}

/** Compiles and builds a custGeom source at a box with the wide limits. */
export function builtOf(src: GeomSource, box: Box): BuiltGeom {
  return buildGeom(compileGeom(src, undefined, WIDE), box.w, box.h, undefined, undefined, WIDE);
}

export function source(paths: PathCmdSource[][], space = 1000): GeomSource {
  return {
    paths: paths.map((cmds) => ({ w: String(space), h: String(space), cmds })),
  } as unknown as GeomSource;
}

/** The commands of a regular n-gon (n points, then a close) about (cx, cy) in a 1000 x 1000 path space. */
export function ngon(n: number, r: number, cx = 500, cy = 500): PathCmdSource[] {
  const cmds: PathCmdSource[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    cmds.push({
      op: i === 0 ? 'moveTo' : 'lnTo',
      args: [(cx + r * Math.cos(a)).toFixed(3), (cy + r * Math.sin(a)).toFixed(3)],
    });
  }
  cmds.push({ op: 'close', args: [] });
  return cmds;
}

/** A closed square outline (a hole when inside another). */
export function square(a: number, b: number): PathCmdSource[] {
  return [
    { op: 'moveTo', args: [String(a), String(a)] },
    { op: 'lnTo', args: [String(b), String(a)] },
    { op: 'lnTo', args: [String(b), String(b)] },
    { op: 'lnTo', args: [String(a), String(b)] },
    { op: 'close', args: [] },
  ];
}

/** The recipe of members whose boxes lie in `box` (slide logical px; w and h should be whole so w x 2 is whole). */
export function recipeWire(box: Box, members: RecipeMemberWire[]): RecipeWire {
  return { v: 1, w: box.w * 2, h: box.h * 2, box: { ...box }, density: 2, members };
}

/** A member whose shape is a regular n-gon filling its box (a wide outline when n is large). */
export function ngonMember(box: Box, n: number, shape: Record<string, unknown> = {}): RecipeMemberWire {
  const src = source([ngon(n, 480)]);
  return memberWire(box, builtOf(src, box), shape);
}

/**
 * The golden vector's recipe (apps/hub/test/data/raster-recipe-v1.json): a shape with a hole and a text-bearing
 * shape in a 40 x 30 logical px run (80 x 60 device px). Deterministic: the planner's round-trip test reads the
 * file, and its TypeScript hash must equal raster-recipe-v1.sha256.
 */
export function goldenRecipe(): RecipeWire {
  const ringBox = { x: 2, y: 2, w: 20, h: 20 };
  const ring = memberWire(ringBox, builtOf(source([[...square(0, 1000), ...square(250, 750)]]), ringBox), {
    fill: colour(30, 120, 200),
    stroke: { width: 1, color: colour(0, 0, 0) },
  });
  const tb = { x: 22, y: 4, w: 16, h: 12 };
  const wordsBox = memberWire(
    tb,
    builtOf(source([ngon(140, 480)]), tb),
    { fill: colour(240, 220, 40, 0.5) },
    {
      text: {
        type: 'text',
        box: { ...tb, rotation: 0 },
        text: 'Amen',
        style: {
          fontFamily: 'Carlito',
          fontWeight: 400,
          fontStyle: 'normal',
          fontSizePx: 6,
          color: colour(20, 20, 60),
          align: 'center',
          valign: 'middle',
          lineHeight: 1.2,
          letterSpacing: 0,
          padding: 0,
        },
        opacity: 1,
      },
      families: ['Carlito'],
    },
  );
  return recipeWire({ x: 0, y: 0, w: 40, h: 30 }, [ring, wordsBox]);
}
