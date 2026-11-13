#!/usr/bin/env bash
# Adopt the renderer golden images that CI's golden container drew (design/23 "Golden images").
#
# The expected PNGs in packages/renderer/golden/expected/ are drawn in the pinned container
# (mcr.microsoft.com/playwright:v1.63.0-noble with the repository's font packages), never on a developer
# machine: text rasterises differently elsewhere. When an intended change moves a golden image, or adds a
# case, the CI job "Goldens (pinned container)" fails and uploads its pictures as the artifact
# "golden-images": test-results/golden/<case>.actual.png (what the container drew), <case>.expected.png and
# <case>.diff.png. Download and unzip it, look at the diffs, then copy the pictures you accept:
#
#   gh run download <run-id> --name golden-images --dir /tmp/golden-images
#   tools/golden-from-artifact.sh /tmp/golden-images                 # every case the run drew
#   tools/golden-from-artifact.sh /tmp/golden-images rich-cjk ...    # only these cases
#
# tools/golden-docker.sh leaves the same files in ./test-results/golden for a local run in the container.
# Only `<case>.actual.png` files are adopted: `<case>.against-<other>.png` (a case compared with another
# case's image) and `<case>.resolver.png` (a legacy case drawn with the font resolver) are not expected
# images of their own. The artifact is treated as data: names are checked, files must be PNGs under 8 MB,
# and nothing in it is executed.
set -euo pipefail

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

src="$1"
shift
repo="$(cd "$(dirname "$0")/.." && pwd)"
dest="$repo/packages/renderer/golden/expected"
[[ -d "$src" ]] || { echo "golden-from-artifact: $src is not a directory" >&2; exit 2; }
[[ -d "$dest" ]] || { echo "golden-from-artifact: $dest is missing" >&2; exit 2; }

declare -A wanted=()
for name in "$@"; do
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,80}$ ]] || { echo "golden-from-artifact: bad case name '$name'" >&2; exit 2; }
  wanted["$name"]=1
done

declare -A seen=()
copied=0
while IFS= read -r -d '' file; do
  base="$(basename "$file")"
  name="${base%.actual.png}"
  if ! [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,80}$ ]]; then
    echo "golden-from-artifact: skipping $base (not a case name)" >&2
    continue
  fi
  if [[ ${#wanted[@]} -gt 0 && -z "${wanted[$name]:-}" ]]; then continue; fi
  if [[ -n "${seen[$name]:-}" ]]; then
    echo "golden-from-artifact: $name.actual.png appears twice in $src; unzip one artifact per directory" >&2
    exit 1
  fi
  seen["$name"]=1
  size="$(stat -c %s "$file")"
  if (( size > 8 * 1024 * 1024 )); then
    echo "golden-from-artifact: $base is $size bytes, not a golden image" >&2
    exit 1
  fi
  if [[ "$(head -c 8 "$file" | od -An -tx1 | tr -d ' \n')" != "89504e470d0a1a0a" ]]; then
    echo "golden-from-artifact: $base is not a PNG" >&2
    exit 1
  fi
  if [[ -f "$dest/$name.png" ]]; then verb="replaced"; else verb="added"; fi
  cp -- "$file" "$dest/$name.png"
  echo "  $name.png: $verb"
  copied=$((copied + 1))
done < <(find "$src" -type f -path '*/golden/*.actual.png' -print0 | sort -z)

for name in "${!wanted[@]}"; do
  [[ -n "${seen[$name]:-}" ]] || { echo "golden-from-artifact: no $name.actual.png in $src" >&2; exit 1; }
done
if (( copied == 0 )); then
  echo "golden-from-artifact: no test-results/golden/*.actual.png under $src" >&2
  exit 1
fi
echo "golden-from-artifact: $copied image(s) copied into packages/renderer/golden/expected/."
echo "Review them (git diff --stat; the artifact's *.diff.png), commit them, and let CI's golden job confirm."
