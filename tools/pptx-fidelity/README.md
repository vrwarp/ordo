# @ordo/pptx-fidelity

How faithfully ordo draws PowerPoint decks (design/27 §14). LibreOffice 24.2 is the reference: each deck is
drawn by LibreOffice (as the hub draws it: outline repair, PDF export, 144 dpi pages), by pptx-preview and
natively (`@ordo/pptx-scene` drawn by `@ordo/renderer` in headless Chromium), and every slide is scored
against LibreOffice's page with SSIM of greyscale pictures at 960x540 (1 = identical, ffmpeg).

Real decks stay outside the repository: pass their paths. Decks are untrusted input; the harness reads them
only through the converter and the hub's zip reader.

## Fidelity runs

```
cd tools/pptx-fidelity
npx tsx src/main.ts --engine native --lo-compat --out <dir> --chromium <chrome> <deck | folder>...
```

Folders are searched with their subfolders for every PresentationML file (`src/decks.ts` `DECK_RE`:
`.pptx`, `.pptm`, `.ppsx`, `.ppsm`, `.potx`, `.potm`). A link whose deck is gone is skipped with a line in
the log, not counted as a failure. LibreOffice's pages are kept in `<dir>/<deck>/libreoffice/` and reused
by the next run with the same `--out` (they are the slow part); `--fresh-lo` draws them again.

| option                       |                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--engine native\|ppv\|both` | which renderers to score (default pptx-preview)                                                                                                                 |
| `--no-ppv`                   | leave pptx-preview out whatever `--engine` says                                                                                                                 |
| `--lo-compat`                | draw native slides with LibreOffice's policies where ordo's differ (`src/compat/`); each slide a rule changes is drawn both ways                                |
| `--before hub\|paste`        | also score what a hub with LibreOffice shows (`beforeHubSsim`, below): its real version 2, or (`paste`) the pixel paste alone                                   |
| `--hub dist\|source`         | the hub `--before hub` imports through: this checkout's sources (default) or its built bundle                                                                   |
| `--no-libreoffice`           | also score what a hub without LibreOffice shows (`noLoSsim`, `missing`, below)                                                                                  |
| `--hub-budget`               | draw every slide as the hub stores it once its budgets ran (a slide it makes a picture loses its objects)                                                       |
| `--slides [DECK:]LIST`       | score only these slides (1-based shown numbers, `3,5-7`), for every deck or the decks whose run name contains `DECK`; repeatable                                |
| `--manifest FILE`            | a suite manifest: per-feature means, worship decks first                                                                                                        |
| `--baseline FILE`            | compare with an earlier `summary.json` or `native-baseline.json`; a worship deck whose native SSIM drops by more than `--max-drop` (default 0.02) fails the run |
| `--corpus`                   | add the synthetic decks of `src/corpus.ts`                                                                                                                      |
| `--raw`                      | also draw with pptx-preview unmodified                                                                                                                          |
| `--script-stand-ins`         | serve a missing script fallback family with fontconfig's face for the script                                                                                    |
| `--chromium PATH`            | the Chromium to drive (else `ORDO_CHROMIUM`, Playwright's, or the system's)                                                                                     |

The run writes `<dir>/summary.json`, `<dir>/native-baseline.json` and `<dir>/report.html`, and prints the
means. Native pictures are `<dir>/<deck>/native/slide-NNNN.png`; delete them after measuring when disk is
tight (the summaries keep every number).

### What `summary.json` holds per slide

- `nativeSsim`: the native drawing against LibreOffice (with `--lo-compat`, drawn as LibreOffice would;
  `policySsim` as ordo draws it; 0 when nothing could be drawn). Residual elements draw nothing, so on a
  hybrid slide the art box is blank: run on a build, this is the harness's "before" of that build (M9's
  zero-tolerance gate). A picture slide is drawn with the objects the converter emitted for it, although
  the hub stores it as a compact picture slide; a hub without LibreOffice showed nothing there
  (`blackSsim`).
- `blackSsim`: an all-black frame scored the same way, the floor to beat.
- `tier`, `class`, `reasons` (the converter's), `hub` (the class in the hub when its §3.4 budgets make it
  differ: `src/census.ts` `hubClasses`).
- `beforeHubSsim` (`--before hub`, `src/beforehub.ts`): what a hub **with** LibreOffice shows. Every deck
  with a slide in F (below) is imported once through this checkout's hub with LibreOffice
  (`src/hub-import.ts`: the upload route, the native import, the LibreOffice follow-up); the hub's version 2
  of those slides (LibreOffice's art over a hybrid slide's box, its page for a picture slide, its conversion
  of the metafiles), with its pictures and geometry files, is drawn by the native column's renderer and
  scored (`beforeHubFrom: 'hub'`). A slide LibreOffice could not draw in the hub (its bounded follow-up gave
  up: on one deck of E, LibreOffice crashes under the hub's resource limits on every attempt) is scored as
  the hub shows it, without its art (`beforeHubFailed`).
  Any other slide scores `nativeSsim`. Decks have the mean as `beforeHubSsim`, the summary as
  `beforeHubMean` (and `before`).
- `beforeHubPaste` (`--before`, F only): the labelled fallback. LibreOffice's pixels inside the art box and
  the metafiles' boxes (grown by 2 px before and 3 px after) pasted over the native page, scored as the
  native page is; a picture slide (or a slide the converter did not emit) scores 1. It stands in as
  `beforeHubSsim` where the hub gave no score (its import failed, or the slide is still pending there:
  `beforeHubFrom: 'paste'`; `--before paste` uses it alone).
  It is no bound of the real picture: it takes LibreOffice's background inside the box, misses art that
  spills past it (a 3-D extrusion), and resamples a page of another size twice. Measured over E's F (the
  186 slides the hub drew with their art), it is within ±0.012 of the hub on 114, up to 0.19 above it where
  a large box covers a textured background, at least 0.02 above it on 23 of the 37 picture slides (the hub
  shows its stored page, not LibreOffice's), and up to 0.04 below it on extruded 3-D.
- `noLoSsim` (`--no-libreoffice`): what a hub **without** LibreOffice shows: the deck emitted with
  `EmitOptions.libreoffice: false` (M9: the art and the metafile conversions left out and listed), each slide
  as the hub stores it (`hubStoredSlide`: a picture slide loses its objects; the budget ladder will fill that
  hook). It is `nativeSsim` where the two draw alike, and `nativeNoLo` names its picture where they do not.
  `missing` lists the kinds nothing draws (`EmittedSlide.missing`). Summary: `noLoMean`.
- `metafiles`: metafile pictures left to LibreOffice on the slide (pending; such a slide is in F even when
  native). `exception`: the reason of a named exception (`src/exceptions.ts`) for the slide, which lifts
  gate 2 (before-hub) only, unless `exceptionGate: 'all'` says it lifts gate 1 (before-harness) too; decks
  carry their file's `sha256`, by which exceptions name them.
- **F** (the M9 exit's set): every slide whose hub class is not native, every slide with `metafiles`, and
  every shown slide the converter did not emit. `native.all.causes` and the report table it by cause, with
  `exit_ssim.py`'s groups (first match: 3d, warp, table, decorations, pictures, vertical, metafile/ole,
  chart, smartart; then ladder for a picture slide, other): before-harness, before-hub (and how many from the
  hub), the paste, without LibreOffice, black, `missing`, exceptions and the largest object.
- `rasterMs`: the median `drawSlide2D` time (draw and flush) at 1920 and 3840 px wide, pictures prepared.
- `coldMs`: preparing the pictures the deck's cache lacks plus the first draw, at each width.
- `maxObjectMs` and `maxObjectId`: the largest single object's draw and flush at 1920 and 3840 px, cold
  (design/27 §13's 50 ms task). After every slide's own timings, each slide is drawn again on a canvas of its
  own, object by object as `drawSlide2D` draws them (the authored objects within the slide's drawing budget),
  from a copy of the slide with the effect sprites cleared and the deck's geometry files read again (their
  paths, Path2D and union tracing are built inside the times, as on an output that has just read them), so
  nothing cached for its objects applies; its pictures are prepared first, outside the times, as an
  output's lanes prepare them (`src/objecttime.ts`, `src/native-page.ts`). The run prints the p95 and the
  largest over all slides.

## Census

```
npx tsx src/census.ts --out census.jsonl <deck | folder>...
```

The tier, class and reasons of every shown slide of every deck as this checkout's converter writes them,
and the slide's class in the hub once its budgets ran, one JSON line per deck (`src/census.ts` documents the
columns: `n`, `i`, `tier`, `class`, `reasons`, `objects`, `geom`, `refs`, `bytes`, `metafiles`, `stored`,
`hub`, `hubWhy`; per deck `geomFiles`, `geomBytes`, `error`). It reads the same files as a fidelity run
(`DECK_RE`); a link whose deck is gone is listed as `unreadable: "missing target"` without slides, never as
an error. Each deck is converted in the harness's worker, with the pool's heap limit and timeout.

A census line names its deck. Tables made from a census of private decks print counts only.

### The golden-pptx census ratchet (CI)

```
pnpm --filter @ordo/pptx-fidelity census:ratchet            # compare; exit 1 on a regression
pnpm --filter @ordo/pptx-fidelity census:ratchet -- --write # record golden-census-baseline.json
```

`src/census-ratchet.ts` runs the census over the committed public corpus (`golden-pptx/`, 112 decks, 1,071
shown slides, about 15 s here) and compares it with `golden-census-baseline.json`: per deck, each shown
slide's number, class, class in the hub and reasons. A slide whose class or hub class got worse (native <
hybrid < picture), a shown slide that is gone, or a deck of the baseline that is missing or that the converter
can no longer read fails the run. A better class, other reasons on the same class and decks or slides the
baseline lacks pass and are reported; record an improvement with `--write` in the same PR, so it cannot slip
back. The census goes to `test-results/census-golden.jsonl` and the comparison to
`test-results/census-ratchet.json`. CI's fidelity job runs it on every pull request.

<!-- m9:harness -->
## Hub import (M9)

```
npx tsx src/hub-import.ts [--dry-run] [--libreoffice] [--client-scene | --equivalence] [--out DIR] [--hub dist|source] [--sermons DIR]... <deck | folder>...
```

The M9 exit's import of the whole worship set through a real hub (plan §6.3). It starts this checkout's hub
(one process, `jobs.light` 1, data under `<DIR>/hub-data`) with a PATH of links to `node`, `ffmpeg`,
`ffprobe`, `pdftoppm`, `pdfinfo` and `prlimit` only and `ORDO_LIBREOFFICE=auto`, checks that
`GET /capabilities` reports LibreOffice absent, posts every deck through `POST /import/document`, and writes
`hub-import.json` and `hub-import.md`: per deck the job state, the time to version 1, the classes,
`pending`, the `missing` kinds, `simplified`, the presentation's bytes and its largest slide's, and whether
a goLive of it resolves every file it names (`resolvePlaylist`, then each file fetched); then the gates
(every job done, nothing pending, no picture slide, no slide over 64 KB, no presentation over 4 MiB, every
reference resolved, no LibreOffice command in the hub log, sermon decks at version 1 within 5 s, RSS within
`--mem-limit-mb`). `--libreoffice` runs with LibreOffice on the PATH and counts the slides left to it.
`--dry-run` lists the decks and the dangling links (unreadable) without a hub. Decks under `--sermons` are
reported as `sermon-<k>`.

`--client-scene` measures the path operators take (design/27 m9:import-core): each deck is parsed first as
the operator's import worker parses it (`parsePptxScene` in Node, with the hub's library faces fetched from
the hub, for the LibreOffice the hub reports) and posted with its scene; each record says whether the hub
used it (`scene`: used, refused, none) and the parse's time (`clientMs`). `--equivalence` (implies it)
imports each deck twice, with its scene and parsed by the hub itself, and lists every difference between the
two stored presentations modulo ids, media ids (by file), times, the import log and digests
(`src/equivalence.ts`) in `equivalence.json`.

## Registries (M9)

- `src/compat/`: one LibreOffice policy rule per file (`compatRule`: key, text, `hits(element, slide)`),
  listed once in `COMPAT_REGISTRY` (`index.ts`), in report order. An M9 track adds its rule (`flat3d`,
  `warpRuns`, `vertLo`, `mirrorTurn`, `chartLo`) as a file and one line there.
- `src/features/`: one family of XML features per file (`featureFamily`: key, features in report order,
  optional targets, `detect(source)` with the slide's XML and the parts it names, `related('/chart')`),
  listed once in `FEATURE_FAMILIES`. The text family is `textFeatures` (as since M2); every other family's
  features are `xmlFeatures`, tabled the same way.
- `src/exceptions.ts`: the named exceptions of the M9 gates, each a deck's SHA-256 prefix, a slide and a
  reason (no deck names), and the gates it lifts (`gate`: 'hub', the default, or 'all'). A run writes
  `exception` (and `exceptionGate`) on each slide one names; `exit_ssim.py` honours them.
- `src/libreoffice.ts`: LibreOffice's reference pictures (`pptxToPdf`, moved here from the hub, which keeps
  its own sandboxed LibreOffice path).
<!-- /m9:harness -->

<!-- m9:ladder -->
## The hub's budget ladder in the harness (M9)

`native.ts` `hubLadder` models the hub's step 3 (`apps/hub/src/pptx/ladder.ts`, the same functions): outline
files within the import's budget (objects naming one past it left out), each slide fitted to 64 KB as the hub
stores it (`fitSlideBudget`: grid, plain, minimal) and the presentation's tail stored minimal; no slide is a
picture for its size. `--hub-budget` draws every slide, its LibreOffice-policy form and its LibreOffice-less
form as the hub stores them (`withHubBudget`), and `--no-libreoffice` scores the stored form
(`hubStoredSlide`). The census's hub columns (`hubClasses`) come from it: `hub` (hybrid when the ladder left
something out), `hubWhy` (`slide`, `presentation`, `geoms`), `level` (when not `full`) and `missing`;
`census.ts --no-libreoffice` reads each slide as a hub without LibreOffice emits it, with the converter's
`missing` kinds too, and `--hub-budget` is accepted (the hub columns always model the ladder).
<!-- /m9:ladder -->

## Other tools

- `src/placement.ts`: the M1 placement check on the synthetic 4:3 deck (boxes within 2 px of LibreOffice's).
- `src/table-probe.ts`: the probe deck that measured LibreOffice's table row rule.

## Tests

`npx vitest run tools/pptx-fidelity` from the repository root. The Chromium tests run when
`ORDO_TEST_CHROMIUM` names a Chromium or Playwright's is installed; the ffmpeg ones when ffmpeg is on the
PATH.
