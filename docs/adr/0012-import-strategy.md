# ADR 0012: Import strategy

## Decision

- ProPresenter 7: decode `.pro` and playlist files with vendored community `.proto`
  definitions; import text with geometry and the first run's style; log everything
  skipped.
- SongSelect: import the downloaded ChordPro and lyrics text files, and the same parser
  for paste. No automated SongSelect login.
- PPTX and PDF: render pages on the hub (LibreOffice to PDF, pdftoppm to PNG) into image
  slides; for PPTX additionally extract text runs with positions from the package XML so
  an image slide can be made editable. `PptxGenJS` is a writer and is not used.
- Google Fonts: the hub downloads families once and serves them locally.

## Reasons

- Fidelity where it matters (lyrics, sections, arrangements), honesty where it cannot be
  achieved (PowerPoint fonts, builds), no fragile scraping.

## Consequences

- The Docker image includes LibreOffice (size and cold start).
- The proto definitions must be kept in step with ProPresenter releases; the import log
  records the version used.
