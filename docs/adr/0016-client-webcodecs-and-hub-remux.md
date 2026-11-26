# ADR 0016: Client WebCodecs pre-transcode, Hub H.264 remux fast-path and non-destructive media trim

## Context

Under [ADR 0009](0009-delivery-codec-h264.md), every uploaded video was unconditionally
re-encoded on the Hub CPU using software `libx264 -preset medium`, one `heavy` job at a time.
That created two avoidable bottlenecks:

1. Uploads that already satisfied the 1080p60 H.264 + AAC delivery spec still spent minutes
   re-encoding on a modest NAS CPU.
2. Volunteers uploading large 4K60 HEVC `.mov` clips from a laptop or iPad had to upload
   multi-gigabyte originals over home uplinks and then wait on NAS software encoding.

In addition, `Media.trim` existed on the Hub for PowerPoint imports, but operators had no UI
or API to trim or re-trim video and audio items in the Media Library.

## Decision

1. **Hub compliant-H.264 remux fast-path (`canRemuxH264` / `remuxH264`).** When `ffprobe`
   confirms an opaque, untrimmed video already satisfies Ordo's delivery spec — 8-bit
   progressive `yuv420p` H.264 (`Baseline`, `Constrained Baseline`, `Main`, or `High`
   profile), even dimensions `<= 1920x1080`, square SAR, `<= 60.5 fps`, bitrate `<= 20 Mbps`,
   and AAC audio `<= 2` channels (or silent) — the Hub remuxes with
   `ffmpeg -c:v copy [-c:a copy] -movflags +faststart -map_metadata -1` instead of running
   `libx264`. Poster extraction (`640x360`) and `loudnorm` LUFS measurement still run as usual.
   If remuxing fails on a malformed container, the Hub falls back to `transcodeH264`. Existing
   `heavy` job pacing rules during live services are unchanged.
2. **Optional client-side WebCodecs pre-transcode (`apps/operator`).** On desktop and tablet
   Operator browsers (when `settings.general.clientVideoTranscode` is enabled, default `true`),
   a lazily loaded Web Worker (`videoTranscode.worker.ts` using `mediabunny` + WebCodecs)
   inspects modern video containers (`.mp4`, `.m4v`, `.mov`, `.webm`, `.mkv`) before upload:
   - Already-compliant H.264 + AAC MP4/MOV clips skip client re-encoding so the Hub remuxes
     them losslessly.
   - Non-compliant opaque clips (4K, HEVC, VP9, AV1, high-fps, rotated, high-bitrate) are
     hardware-transcoded in the worker to a full-timeline 1080p60 H.264 + AAC `.mp4` and
     uploaded alone as `Media.original`.
   - Legacy containers (`.wmv`, `.avi`, `.mpg`, `.vob`), alpha videos, compact phone layouts,
     unsupported browser codecs, worker errors, and venue PCs currently driving live output
     windows (`mode === 'live'` with open output windows) transparently upload the raw file to
     the Hub's `ffmpeg` pipeline.
3. **Non-destructive video & audio trimming (`PUT /media/:id/trim`).** Any `video` or `audio`
   item (excluding animated GIFs) can be trimmed, re-trimmed, or reset to full length from the
   Media Inspector. The Hub records `Media.sourceDurationMs` from `Media.original`, validates
   and stores `Media.trim`, re-processes `delivery`, `poster`, `durationMs`, and `loudnessLufs`
   from `Media.original`, and releases superseded delivery/poster hashes.

## Consequences

- For client-transcoded uploads, `Media.original` on the Hub is the full-timeline 1080p60
  H.264 + AAC `.mp4` rather than the raw 4K/HEVC camera original, trading archival 4K retention
  for 10x–20x smaller uploads and NAS storage while keeping full-timeline non-destructive
  trimming. Operators who need raw originals stored on the Hub can disable
  `clientVideoTranscode` in Settings → General.
- `videoTranscode.worker.ts`, `services/videoTranscode.ts`, and `mediabunny` are dynamically
  loaded only outside compact phone layouts and listed in `COMPACT_FORBIDDEN`, keeping phone
  bundle sizes unaffected.
