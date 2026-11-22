/**
 * The numbers of the bake service that the plan (services/bakePlan.ts) and the service (services/bake.ts) share, and
 * nothing else (design/29 section 1.4, "As built in sub-wave 3 (bake-worker)"). Each is pinned by a test; the three
 * that are the renderer's or the hub's numbers are pinned equal to theirs by reading them there (a test, never an
 * import: neither the plan nor the service may carry the renderer, and the hub is another program).
 *
 * Q30.a (when pictures are made) and Q30.d (a failure is not tried again by itself) are the owner's defaults; changing
 * a delay is one number here.
 */

/** The first sweep is not earlier than this after the service starts (and after the library came from the hub). */
export const BAKE_START_DELAY_MS = 15_000;
/** A burst of library changes is one sweep this long after the LAST change. */
export const BAKE_SETTLE_MS = 3_000;
/** Between two pictures (the computer is not kept busy back to back). */
export const BAKE_GAP_MS = 1_000;
/** While something is still pending (never when everything is ready or failed): a sweep this often. */
export const BAKE_IDLE_SWEEP_MS = 300_000;
/** After End service: the computers resume this long after it. Equal to the hub's `PAUSED_RETRY_S` x 1000 (a test). */
export const BAKE_RESUME_MS = 120_000;
/** The hub has no key for a slide yet (its keys job is a moment behind a save): read the listing again after these. */
export const BAKE_UNKNOWN_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000, 60_000, 120_000];
/** A cause that is not the slide's (a font or a file that was not there yet, a stopped bake): tried again after these. */
export const BAKE_TRANSIENT_BACKOFF_MS: readonly number[] = [10_000, 60_000];
/** The third failure of a transient cause in one page's life is posted. */
export const BAKE_ATTEMPTS = 3;
/** The worker is killed this long after the deadline it was given. */
export const BAKE_HARD_GRACE_MS = 5_000;
/** The worker is released this long after its last picture. */
export const BAKE_WORKER_IDLE_MS = 30_000;
/** A lost request (a network error, a 401 or 403) holds this long when the hub's link says it is still up. */
export const BAKE_HUB_HOLD_MS = 15_000;
/** After a 507 `disk` every computer that sees it holds this long. */
export const BAKE_DISK_HOLD_MS = 600_000;
/** A listing read this recently is reused (`refresh` without `force`). */
export const BAKE_LISTING_FRESH_MS = 10_000;
/** A Go live that never becomes a service (the prepare was given up) releases the hold after this long. */
export const BAKE_GO_LIVE_HOLD_MAX_MS = 60_000;
/** The valve after a 503 when no End service is seen (a missed state update must not loop a 60 s bake every 120 s). */
export const BAKE_PAUSED_MAX_MS = 600_000;
/** Q31.c: a family with no face of its own is drawn in ordo's default face and listed (`'abort'`: no picture). */
export const BAKE_STAND_INS = 'allow' as const;
/** The time one bake may take, ms: the renderer's `BAKE_DEADLINE_MS` (Q38.a; a test holds them equal). */
export const BAKE_JOB_DEADLINE_MS = 60_000;
/** The picture sizes (widths) in the order they are uploaded: the renderer's `BAKE_UPLOAD_ORDER` (a test holds them equal). */
export const BAKE_UPLOAD_ORDER: readonly number[] = [1920, 3840, 640];
/** The two sizes a screen draws: a key that has both is ready (the 640 preview is nobody's yet). */
export const BAKE_READY_SIZES: readonly number[] = [1920, 3840];
/** The hub's file bound for one picture (a test holds it equal to the renderer's and the hub's). */
export const BAKE_MAX_PICTURE_BYTES = 32 * 1024 * 1024;
/** The sweep is planned in slices of this many ms (one slide a task, then a yield). */
export const BAKE_SLICE_MS = 8;
/** The file-form arm (Q54): the whole of a slide file's pages and head is read inside this limit, apart from the bake's. */
export const FILE_READ_DEADLINE_MS = 30_000;
/**
 * A record slide with at least this many objects has its key worked out in a worker of its own (a 600 KB slide costs
 * the main thread about 30 ms to key: the domain's canonical JSON and a plain-JavaScript SHA-256), and a smaller one on
 * the main thread, which a worker round trip would not beat.
 */
export const BAKE_KEYS_MIN_OBJECTS = 300;
/** The keys worker that does not answer within this is given up: the keys are worked out on the main thread, one slide a slice. */
export const BAKE_KEYS_DEADLINE_MS = 15_000;
/** The keys worker is released this long after its last answer. */
export const BAKE_KEYS_IDLE_MS = 5_000;
