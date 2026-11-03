# ADR 0009: One delivery format per media kind

## Decision
Every uploaded video is transcoded on the hub to H.264 High profile MP4 at up to
1920x1080 and 60 fps with AAC stereo; videos with alpha to VP9 WebM with alpha; animated
GIFs to one of those; audio files to AAC 256 kbps. Originals are kept.

## Reasons
- H.264 has hardware decode on every Windows GPU the venue could have; VP9 and AV1
  hardware decode is less uniform.
- One format means one tested playback path and predictable decode load.
- Keeping originals allows a future re-encode (for example to AV1) without re-upload.

## Consequences
- The NAS transcodes; large uploads take minutes and the UI must show state.
- The Docker image carries ffmpeg with libx264 and libvpx.
