#!/usr/bin/env bash
# A minimal ffmpeg and ffprobe for the demo's VM hub (docs/design/26-pages-demo.md, "The VM hub"): static
# linux-arm64 (musl) binaries with only what the hub asks of them (apps/hub/src/media/ffmpeg.ts), in place of Alpine's
# ffmpeg and the 93 MiB of codec libraries it pulls in.
#
#   apps/demo/scripts/build-ffmpeg.sh <out-dir> [<cache-dir>]
#
# Writes <out-dir>/ffmpeg, <out-dir>/ffprobe and <out-dir>/SOURCES (what went in, with its licence: x264 makes the
# build GPL). Cross-compiled with zig (`zig cc -target aarch64-linux-musl`), so the host needs only bash, curl, git,
# make, tar, xz, binutils (nm, strings) and pkg-config; no root, no cross toolchain. Downloads go to <cache-dir> (default
# <repo>/.cache/vm/ffmpeg); scripts/build-vm.ts keys the result by this file's hash and reuses it.
#
# What the hub needs (keep in step with apps/hub/src/media/ffmpeg.ts):
# - ffprobe on every media item (pictures too), its JSON writer;
# - encoders: libx264 (H.264 delivery), aac (audio and delivery audio), libvpx-vp9 + libopus (videos with alpha),
#   mjpeg and png (posters, stills, page pictures), rawvideo (RGBA pictures), wrapped_avframe and pcm_s16le (the
#   null output of the loudness pass);
# - filters: scale, pad, fps, setsar, format, loudnorm, and what ffmpeg inserts itself (autorotation, resampling);
# - outputs: mp4/m4a, webm, image2, rawvideo, null; inputs: the containers and codecs people bring (phones, cameras,
#   ProPresenter and PowerPoint media, Windows video), decoded by ffmpeg's own decoders, VP8/VP9 with alpha by libvpx.
# Not in it: AV1 decoding (no dav1d), network protocols, hardware acceleration, devices.
set -euo pipefail

OUT=$(mkdir -p "$1" && cd "$1" && pwd)
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
CACHE=$(mkdir -p "${2:-$REPO/.cache/vm/ffmpeg}" && cd "${2:-$REPO/.cache/vm/ffmpeg}" && pwd)
JOBS=${JOBS:-$(nproc 2>/dev/null || echo 4)}

ZIG_VERSION=0.14.1
FFMPEG_VERSION=8.1.3
FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55 # branch stable
LIBVPX_TAG=v1.15.2
LIBVPX_COMMIT=d168454ecd099805c675d4a98c66f4891373302a
OPUS_VERSION=1.5.2
OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1
ZLIB_VERSION=1.3.1
ZLIB_SHA256=9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23

log() { printf '[ffmpeg] %s\n' "$*" >&2; }

# fetch FILE SHA256 URL...: download once into the cache from the first source that gives the expected bytes (with no
# checksum, the first that answers). A source that answers with something else (a challenge or error page) is reported
# and the next one tried; nothing that failed its check stays in the cache.
fetch() {
	local file=$CACHE/$1 sum=$2 url
	shift 2
	if [ -s "$file" ] && { [ -z "$sum" ] || echo "$sum  $file" | sha256sum -c --quiet 2>/dev/null; }; then return; fi
	rm -f "$file"
	for url in "$@"; do
		log "download $url"
		if ! curl -fsSL --retry 4 -o "$file.part" "$url"; then
			log "  failed: $url"
			continue
		fi
		if [ -n "$sum" ] && ! echo "$sum  $file.part" | sha256sum -c --quiet 2>/dev/null; then
			log "  not the expected file ($(stat -c %s "$file.part") bytes, $(file -b "$file.part" | cut -c1-60)): $url"
			rm -f "$file.part"
			continue
		fi
		mv "$file.part" "$file"
		return
	done
	log "no source gave $1"
	exit 1
}

# git_at URL COMMIT DIR: a checkout of exactly COMMIT (shallow), cached.
git_at() {
	local url=$1 commit=$2 dir=$CACHE/$3
	if [ ! -d "$dir/.git" ] || [ "$(git -C "$dir" rev-parse HEAD)" != "$commit" ]; then
		log "git $url @ $commit"
		rm -rf "$dir"
		git init -q "$dir"
		git -C "$dir" fetch -q --depth 1 "$url" "$commit"
		git -C "$dir" checkout -q FETCH_HEAD
	fi
}

# ---------------------------------------------------------------- the cross compiler: zig, wrapped as a toolchain

case "$(uname -m)" in
	x86_64) ZIG_HOST=x86_64-linux ZIG_SHA256=24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c ;;
	aarch64 | arm64) ZIG_HOST=aarch64-linux ZIG_SHA256= ;;
	*) log "no zig for host $(uname -m)"; exit 1 ;;
esac
fetch "zig-$ZIG_HOST-$ZIG_VERSION.tar.xz" "$ZIG_SHA256" "https://ziglang.org/download/$ZIG_VERSION/zig-$ZIG_HOST-$ZIG_VERSION.tar.xz"
ZIG_DIR=$CACHE/zig-$ZIG_HOST-$ZIG_VERSION
[ -x "$ZIG_DIR/zig" ] || tar -C "$CACHE" -xf "$CACHE/zig-$ZIG_HOST-$ZIG_VERSION.tar.xz"

WORK=$(mktemp -d)
trap 'if [ -z "${KEEP_WORK:-}" ]; then rm -rf "$WORK"; else log "work folder kept: $WORK"; fi' EXIT
TC=$WORK/toolchain
PREFIX=$WORK/prefix
mkdir -p "$TC" "$PREFIX"
TRIPLE=aarch64-linux-musl
export ZIG_GLOBAL_CACHE_DIR=$CACHE/zig-cache ZIG_LOCAL_CACHE_DIR=$CACHE/zig-cache
for tool in cc gcc c++ g++; do
	kind=cc
	case $tool in c++ | g++) kind=c++ ;; esac
	printf '#!/bin/sh\nexec "%s/zig" %s -target %s "$@"\n' "$ZIG_DIR" "$kind" "$TRIPLE" >"$TC/$TRIPLE-$tool"
done
for tool in ar ranlib; do printf '#!/bin/sh\nexec "%s/zig" %s "$@"\n' "$ZIG_DIR" "$tool" >"$TC/$TRIPLE-$tool"; done
# The binaries are stripped at link time (-s); configure scripts still want a strip and an nm to call.
printf '#!/bin/sh\nexit 0\n' >"$TC/$TRIPLE-strip"
printf '#!/bin/sh\nexec nm "$@"\n' >"$TC/$TRIPLE-nm"
printf '#!/bin/sh\nexec strings "$@"\n' >"$TC/$TRIPLE-strings"
chmod +x "$TC"/*
export PATH=$TC:$PATH
export CC=$TRIPLE-cc CXX=$TRIPLE-c++ AR=$TRIPLE-ar RANLIB=$TRIPLE-ranlib STRIP=$TRIPLE-strip NM=$TRIPLE-nm
export PKG_CONFIG_LIBDIR=$PREFIX/lib/pkgconfig PKG_CONFIG_PATH=
CFLAGS_COMMON="-O2 -fPIC"

# ---------------------------------------------------------------- the libraries

fetch "zlib-$ZLIB_VERSION.tar.gz" "$ZLIB_SHA256" \
	"https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.gz" \
	"https://zlib.net/fossils/zlib-$ZLIB_VERSION.tar.gz"
log "zlib $ZLIB_VERSION"
tar -C "$WORK" -xzf "$CACHE/zlib-$ZLIB_VERSION.tar.gz"
(cd "$WORK/zlib-$ZLIB_VERSION" && CFLAGS="$CFLAGS_COMMON" ./configure --static --prefix="$PREFIX" >/dev/null &&
	make -s -j"$JOBS" install >/dev/null)

fetch "opus-$OPUS_VERSION.tar.gz" "$OPUS_SHA256" \
	"https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz" \
	"https://github.com/xiph/opus/releases/download/v$OPUS_VERSION/opus-$OPUS_VERSION.tar.gz"
log "opus $OPUS_VERSION"
tar -C "$WORK" -xzf "$CACHE/opus-$OPUS_VERSION.tar.gz"
(cd "$WORK/opus-$OPUS_VERSION" && CFLAGS="$CFLAGS_COMMON" ./configure -q --host=$TRIPLE --prefix="$PREFIX" \
	--enable-static --disable-shared --disable-doc --disable-extra-programs >/dev/null &&
	make -s -j"$JOBS" install >/dev/null)

git_at https://code.videolan.org/videolan/x264.git "$X264_COMMIT" x264
log "x264 ${X264_COMMIT:0:8}"
cp -a "$CACHE/x264" "$WORK/x264"
(cd "$WORK/x264" && ./configure --host=$TRIPLE --cross-prefix=$TRIPLE- --prefix="$PREFIX" \
	--enable-static --enable-pic --disable-cli --disable-opencl --disable-lavf --disable-swscale \
	--disable-ffms --disable-gpac --disable-lsmash --extra-cflags="-O2" >/dev/null &&
	make -s -j"$JOBS" install-lib-static >/dev/null)

git_at https://chromium.googlesource.com/webm/libvpx "$LIBVPX_COMMIT" libvpx
log "libvpx $LIBVPX_TAG"
cp -a "$CACHE/libvpx" "$WORK/libvpx"
(cd "$WORK/libvpx" && CROSS=$TRIPLE- ./configure --target=arm64-linux-gcc --prefix="$PREFIX" \
	--enable-static --disable-shared --enable-pic --enable-vp8 --enable-vp9 --disable-examples --disable-tools \
	--disable-docs --disable-unit-tests --disable-install-bins --enable-vp9-highbitdepth >/dev/null &&
	make -s -j"$JOBS" install >/dev/null)

# ---------------------------------------------------------------- ffmpeg

fetch "ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256" \
	"https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" \
	"https://www.ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
log "ffmpeg $FFMPEG_VERSION"
tar -C "$WORK" -xJf "$CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz"

list() { local IFS=,; echo "$*"; }
DECODERS=(
	h264 hevc vp8 vp9 libvpx_vp8 libvpx_vp9 mpeg4 h263 mpeg1video mpeg2video msmpeg4v1 msmpeg4v2 msmpeg4v3
	wmv1 wmv2 wmv3 vc1 prores dnxhd dvvideo mjpeg mjpegb qtrle theora flv svq3 rawvideo
	png apng bmp gif tiff webp jpegls ppm pgm pam
	aac aac_latm mp3 mp3float mp2 mp2float ac3 eac3 opus vorbis flac alac wmav1 wmav2 wmapro
	pcm_s16le pcm_s16be pcm_s24le pcm_s24be pcm_s32le pcm_f32le pcm_f32be pcm_u8 pcm_alaw pcm_mulaw adpcm_ima_qt
)
ENCODERS=(libx264 aac libvpx_vp9 libopus mjpeg png rawvideo wrapped_avframe pcm_s16le)
DEMUXERS=(
	mov matroska avi mpegts mpegps flv asf mp3 aac ac3 eac3 wav flac ogg m4v h264 hevc mpegvideo
	image2 image2pipe image_png_pipe image_jpeg_pipe image_webp_pipe image_bmp_pipe image_tiff_pipe
	image_gif_pipe gif apng image_jpegls_pipe image_ppm_pipe
)
MUXERS=(mp4 ipod mov webm matroska image2 image2pipe rawvideo null)
PARSERS=(h264 hevc vp8 vp9 mpeg4video mpegvideo mjpeg png gif bmp webp aac aac_latm mpegaudio ac3 opus vorbis flac vc1)
BSFS=(h264_mp4toannexb hevc_mp4toannexb aac_adtstoasc extract_extradata vp9_superframe vp9_superframe_split)
FILTERS=(
	scale pad fps setsar setdar format loudnorm aresample aformat anull null copy
	transpose hflip vflip rotate trim atrim settb asettb
	buffer abuffer buffersink abuffersink
)

(
	cd "$WORK/ffmpeg-$FFMPEG_VERSION"
	./configure \
		--prefix="$PREFIX" --enable-cross-compile --arch=aarch64 --target-os=linux \
		--cc=$TRIPLE-cc --cxx=$TRIPLE-c++ --ar=$TRIPLE-ar --ranlib=$TRIPLE-ranlib --strip=$TRIPLE-strip \
		--nm=$TRIPLE-nm --pkg-config=pkg-config --pkg-config-flags=--static \
		--extra-cflags="-O2 -I$PREFIX/include" --extra-ldflags="-static -s -L$PREFIX/lib" \
		--extra-libs="-lpthread -lm" \
		--enable-gpl --enable-static --disable-shared --disable-autodetect --disable-debug --disable-doc --disable-stripping \
		--disable-network --disable-everything --disable-ffplay --enable-ffmpeg --enable-ffprobe \
		--enable-avcodec --enable-avformat --enable-avfilter --enable-swscale --enable-swresample \
		--enable-zlib --enable-libx264 --enable-libvpx --enable-libopus \
		--enable-protocol=file,pipe \
		--enable-decoder="$(list "${DECODERS[@]}")" \
		--enable-encoder="$(list "${ENCODERS[@]}")" \
		--enable-demuxer="$(list "${DEMUXERS[@]}")" \
		--enable-muxer="$(list "${MUXERS[@]}")" \
		--enable-parser="$(list "${PARSERS[@]}")" \
		--enable-bsf="$(list "${BSFS[@]}")" \
		--enable-filter="$(list "${FILTERS[@]}")" \
		>"$WORK/ffmpeg-configure.log" 2>&1 || { tail -40 "$WORK/ffmpeg-configure.log" ffbuild/config.log 2>/dev/null; exit 1; }
	make -s -j"$JOBS" >"$WORK/ffmpeg-make.log" 2>&1 || { tail -40 "$WORK/ffmpeg-make.log"; exit 1; }
	cp ffmpeg ffprobe "$OUT/"
)

cat >"$OUT/SOURCES" <<EOF
ffmpeg $FFMPEG_VERSION (https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz), built with --enable-gpl: GPL-2.0-or-later
x264 $X264_COMMIT (https://code.videolan.org/videolan/x264): GPL-2.0-or-later
libvpx $LIBVPX_TAG (https://chromium.googlesource.com/webm/libvpx): BSD-3-Clause
opus $OPUS_VERSION (https://downloads.xiph.org/releases/opus/): BSD-3-Clause
zlib $ZLIB_VERSION (https://zlib.net/, https://github.com/madler/zlib): Zlib
Built by apps/demo/scripts/build-ffmpeg.sh with zig $ZIG_VERSION for $TRIPLE, statically linked.
EOF
ls -l "$OUT/ffmpeg" "$OUT/ffprobe" >&2
