# ADR 0012: Import strategy

## Decision

- ProPresenter 7: decode `.pro` and playlist files with vendored community `.proto`
  definitions; import text with geometry and the first run's style; log everything
  skipped.
- SongSelect: import the downloaded ChordPro and lyrics text files, and the same parser
  for paste. No automated SongSelect login.
- PDF, and PPTX as 'Pictures (LibreOffice)': render pages on the hub (LibreOffice to PDF,
  pdftoppm to PNG) into image slides; for PPTX additionally extract text runs with positions
  from the package XML so an image slide can be made editable. `PptxGenJS` is a writer and
  is not used.
- PPTX as editable slides (the default since M3, design/27): `@ordo/pptx-scene` converts the
  deck into ordinary ordo objects. Since #11 and the regroup of 2026-11-13 (amended below) the
  operator that uploads a deck parses it in a Web Worker and sends the scene with it; the hub
  validates and stores, building version 1 from the scene with the same import core it uses for
  its own parse, and parses the deck itself whenever the scene is missing, late or refused.
- Google Fonts: the hub downloads families once and serves them locally.

## Reasons

- Fidelity where it matters (lyrics, sections, arrangements), honesty where it cannot be
  achieved (PowerPoint fonts, builds), no fragile scraping.

## Consequences

- The Docker image includes LibreOffice (size and cold start).
- The proto definitions must be kept in step with ProPresenter releases; the import log
  records the version used.

## Amendment 2026-11-13: parse PowerPoint in the uploading browser, the hub validates and stores

Decision. The native PowerPoint import runs where the deck is uploaded: the operator's import worker
(`parsePptxScene`, `@ordo/importers`) reads the deck within the same caps as the hub (its own bounded zip
reader), converts it with the library's font faces, and uploads the scene beside the deck. The hub checks the
scene in its CPU pool (`apps/hub/src/pptx/clientScene.ts`) and builds version 1 with the one import core
(`pptx-core.ts`, `pptx-scan.ts`, `pptx-geoms.ts`, `pptx-pictures.ts`, `pptx-ladder.ts`) that its own parse
uses. The hub keeps its own parse, its pool and LibreOffice for every other path (no scene, a refused scene,
re-import, the LibreOffice follow-up, 'Show original', 'Pictures (LibreOffice)').

Reasons. A NAS is the slowest computer in the building and the venue PC the fastest (the owner's #11): the
CPU of a large import moves to the device that asked for it, and the Pages demo imports PowerPoint with no
hub at all. One import core keeps the two paths from drifting (a hub-vs-client equivalence test over the
worship corpus, `tools/pptx-fidelity`).

Consequences.
- The scene is untrusted input like the deck: bounded on both sides (32 MB part, the pool's heap and
  timeout), schema-checked off the event loop, its shape files re-hashed, released after version 1.
- The operator never parses while a playlist is live, parses only in a Worker with a deadline, and falls back
  to the hub on any failure (counted in its health view and logged), so an import can never cost the service.
- The converter's version and stored fields are one constant each (`@ordo/pptx-scene` `version.ts`); a hub and
  a browser of different builds only ever disagree into the hub's own parse.
