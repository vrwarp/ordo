import { drawnGeomRefs, GEOM_FILE_MAX_BYTES, isGeomFileRef, type Look, type Slide } from '@ordo/domain';
import { readGeomFiles } from '@ordo/renderer';

/*
 * The slide prepare steps (design/27 M9 render-seams): what a worker reads, decodes or lays out before it
 * draws a slide synchronously, besides its pictures. The outputs' asset worker runs them in a job's lane
 * turns (design/27 §7.5), the operator's thumbnail worker at once, both through this registry, so a slide
 * draws the same in both. Steps run in order and each says which files it found missing: the asset worker
 * reports them with the missing pictures, and the link draws the slide again once they are cached.
 *
 * Built in: the geometry files (`ShapeGeom.ref`, M6 round 2). M9 registers its own (tables laid out in 8 ms
 * slices, warp faces, vector pictures, decoration files). A step reads only through its host and never from a
 * deck string as a key; it must not throw for a file that is missing or bad (a throw is a failed job), only
 * for a cancelled job (`host.check`).
 *
 * This module imports nothing of the asset worker, so the thumbnail worker (apps/operator) uses it as it is.
 */

/** What a step can do in its worker. */
export interface PrepareHost {
  /** A file's bytes by hash: undefined (or a throw) when it is not there yet. */
  read(hash: string): Promise<Blob | undefined>;
  /** Runs a synchronous slice of work in a turn of the job (the asset worker's lanes; at once elsewhere). */
  slice<T>(fn: () => T): Promise<T>;
  /** Throws when the job was cancelled (the asset worker's `Cancelled`). */
  check(): void;
}

/** What is about to be drawn: the slides of the job (the slide, and the next one a look shows). */
export interface PrepareJob {
  readonly slides: readonly Slide[];
  /** Device px per logical px of the drawing. */
  readonly scale: number;
  readonly look?: Look;
}

export interface PrepareStep {
  /** A name for logs and for replacing a step (a later registration of one name replaces the earlier). */
  readonly name: string;
  /** Prepares the job; resolves with the hashes of the files it needs that are not there yet. */
  run(job: PrepareJob, host: PrepareHost): Promise<readonly string[] | undefined>;
}

/** The geometry files the slides draw (`ShapeGeom.ref`), read and parsed into the renderer's store. */
export const geometryFiles: PrepareStep = {
  name: 'geometry files',
  async run(job, host) {
    const refs: string[] = [];
    for (const s of job.slides) refs.push(...drawnGeomRefs(s).filter(isGeomFileRef));
    if (!refs.length) return undefined;
    const r = await readGeomFiles(
      refs,
      async (hash) => {
        const blob = await host.read(hash);
        return !blob ? undefined : blob.size > GEOM_FILE_MAX_BYTES ? null : blob.text();
      },
      undefined,
      (fn) => host.slice(fn),
    );
    host.check();
    const missing: string[] = [];
    for (const [hash, why] of r) if (why === 'missing') missing.push(hash);
    return missing;
  },
};

const steps: PrepareStep[] = [geometryFiles];

/** Add a step after the registered ones (or in place of one of its name); returns its unregistration. */
export function registerPrepareStep(step: PrepareStep): () => void {
  const at = steps.findIndex((s) => s.name === step.name);
  if (at >= 0) steps[at] = step;
  else steps.push(step);
  return () => {
    const i = steps.indexOf(step);
    if (i >= 0) steps.splice(i, 1);
  };
}

/** The registered steps, in order. */
export function prepareSteps(): readonly PrepareStep[] {
  return [...steps];
}

/**
 * Run every registered step for `job`, in order (each after the previous one, so a later step can use what an
 * earlier one read): the hashes the steps found missing, each once.
 */
export async function prepareSlides(job: PrepareJob, host: PrepareHost): Promise<string[]> {
  const missing = new Set<string>();
  for (const step of [...steps]) {
    host.check();
    const m = await step.run(job, host);
    for (const h of m ?? []) missing.add(h);
  }
  return [...missing];
}

/** The slides of a job with an optional next slide, as the steps take them. */
export function jobSlides(job: { slide?: Slide; nextSlide?: Slide }): Slide[] {
  const out: Slide[] = [];
  if (job.slide) out.push(job.slide);
  if (job.nextSlide) out.push(job.nextSlide);
  return out;
}
