# PRD 05: Library, media, fonts and import

## Library

- The hub holds the library: presentations, playlists, media, fonts, themes, looks and
  settings, in SQLite plus a media directory on the NAS.
- Search: a single box over titles, lyrics text, CCLI numbers and tags, with results in
  under 100 ms for a library of 5,000 presentations. The index lives in the operator app
  (a worker) and is rebuilt from hub deltas.
- Folders and tags organise presentations. Presentations have a type and can be
  archived rather than deleted.
- Every presentation save creates a revision. The editor shows a history list with
  timestamps and a one-click restore that creates a new revision.
- Nightly backup: the hub writes a dated SQLite snapshot and a media manifest to a
  backup directory on the NAS. Restore is a documented command. Retention 30 days.

## Media

- Upload through the operator app (drag and drop, multiple files) or through the editor
  when placing an image or background.
- Accepted: MP4 (H.264, HEVC where the hub can decode), MOV, WebM (VP9, AV1), AVI, WMV,
  MPEG-1/2 program streams (.mpg, .vob), JPEG, PNG, GIF (still or animated), WAV, MP3, AAC,
  FLAC, OGG, WMA, AIFF. The older formats are common in church archives and PowerPoint decks.
- The hub transcodes every video into one delivery format (H.264 High at the output's
  resolution, 1080p60 maximum, AAC stereo audio) and generates a poster frame and a loop
  preview. Alpha WebM is stored as-is and delivered as VP9 with alpha; it is not required
  at this venue and is a best-effort path.
- Animated GIFs are converted to a looping H.264 video (opaque) or VP9 alpha video
  (transparent). Still GIFs become PNG.
- SVG pictures are accepted and shown on Audience screens as a still picture: the operator app
  draws each one into a PNG as it uploads it (at least 1920 px on its longer side, at most
  3840 px wide), and an SVG from a library made before that is drawn by the output itself. An
  animated SVG shows its first frame on the screens; it moves only in the operator's previews
  (the media library, pickers, background swatches), and those places say so ("moves in
  previews only"). A moving background should be a video.
- An uploaded file opened from its link never runs as a page: SVGs download, and every hub API
  response is a sandboxed document that may load nothing (design/21).
- Audio files are normalised to a delivery format (AAC 256 kbps stereo). Audio files and
  video soundtracks are loudness measured so the audio engine plays them at one level
  (design/18 "Gain staging").
- Media have a name, tags, duration, loop flag, and a "background" flag for use in the
  background picker.
- The media detail view shows the transcoding state. A media item is not selectable in
  a playlist until transcoding is done.

## Fonts

- Upload TTF, OTF, WOFF and WOFF2 to the hub. The hub records the family, style and
  weight and serves them to every output.
- Google Fonts: a search in the font picker lists families from Google Fonts; adding one
  downloads its files to the hub (the hub fetches them once, when internet is available)
  and from then on serves them locally, so services never depend on Google.
- Fonts are part of the service cache.

## Import

### ProPresenter 7

- Import a ProPresenter 7 library folder or individual `.pro` files, and playlists.
- Imported: title, metadata (CCLI, author, copyright), sections (from slide group labels),
  slide text with per-slide text box geometry, font family and size, colour, outline and
  shadow, arrangements, backgrounds (media files found alongside are uploaded), and
  playlists referencing imported presentations.
- Not imported, reported in a per-file import log: builds and animations, media bins
  not found on disk, macros, timers, looks and stage layouts, audio routing.
- Import runs on the hub from an uploaded zip or from a NAS folder path, and shows
  progress and the log in the operator app.

### SongSelect

- Import files downloaded from CCLI SongSelect: the ChordPro export and the lyrics text
  export. The parser detects section labels, chord lines (stored but not shown on
  slides), CCLI song number, title, author and copyright lines.
- Paste also works: the same parser runs on pasted text in New song.

### PPTX and PDF

- Upload a `.pptx` or `.pdf`; the hub renders each page to a 1920x1080 PNG (PDF via
  `pdftoppm`; PPTX via LibreOffice headless to PDF, then `pdftoppm`) and creates a slides
  presentation with one image slide per page, the source file attached.
- For PPTX the hub also extracts each slide's text runs and their bounding boxes from the
  package XML. Converting an image slide to an editable slide uses these to create text
  boxes over the rendered image. Fonts will not match PowerPoint exactly; the editor says so.
- `PptxGenJS` is a PPTX writer, not a reader, and is not used for import. Export to
  PPTX is not in scope.

## Acceptance

- The venue's whole ProPresenter 7 library imports with every song's lyrics and sections
  intact and a readable log of what was skipped.
- A 200 MB MOV uploaded from home is playable at the venue after transcoding, with a
  progress indicator in between.
- An SVG background shows on every Audience screen, whether it was uploaded now or before
  this release; an animated one shows its first frame there and moves in the operator's
  previews (`e2e/svg-media.spec.ts`).
- A font added from Google Fonts renders identically on every output with the WAN off.
