#!/usr/bin/env bash
# Run the renderer's golden steps in the pinned golden container, as CI's "Goldens (pinned container)" job
# does (design/23 "Golden images"): the only place where the expected PNGs are drawn and compared.
#
#   tools/golden-docker.sh                        # golden --strict, late-font, golden:compositor
#   tools/golden-docker.sh golden                 # one step (golden, late-font or golden:compositor)
#   tools/golden-from-artifact.sh test-results    # then adopt the pictures it drew, if intended
#
# Needs Docker and the network (the image, apt and the npm registry). The working tree (without
# node_modules, dist, golden-pptx, test-results and .git) is copied into the container, so uncommitted
# changes are tested and nothing in the tree is written but ./test-results/golden and
# ./test-results/compositor-golden. Keep IMAGE and FONTS in step with .github/workflows/ci.yml.
set -euo pipefail

IMAGE="mcr.microsoft.com/playwright:v1.63.0-noble"
FONTS="fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation2 fonts-noto-core fonts-inter fonts-dejavu-core fonts-freefont-ttf fonts-ipafont-gothic"

repo="$(cd "$(dirname "$0")/.." && pwd)"
steps=("$@")
if [[ ${#steps[@]} -eq 0 ]]; then steps=(golden late-font golden:compositor); fi
for s in "${steps[@]}"; do
  case "$s" in golden | late-font | golden:compositor) ;; *) echo "golden-docker: unknown step '$s'" >&2; exit 2 ;; esac
done
mkdir -p "$repo/test-results"
rm -rf "$repo/test-results/golden" "$repo/test-results/compositor-golden"

tar -C "$repo" -cf - \
  --exclude=./.git --exclude=./golden-pptx --exclude=./test-results --exclude=./playwright-report \
  --exclude=node_modules --exclude=dist --exclude='.e2e-data*' . |
  docker run --rm -i --ipc=host -e CI=true -e STEPS="${steps[*]}" -e FONTS="$FONTS" \
    -v "$repo/test-results:/out" "$IMAGE" bash -euo pipefail -c '
      mkdir -p /work && tar -xf - -C /work && cd /work
      apt-get update -qq && apt-get install -y -qq --no-install-recommends $FONTS > /dev/null
      npm install -g pnpm@10.28.0 > /dev/null
      pnpm install --frozen-lockfile > /dev/null
      status=0
      for s in $STEPS; do
        if [ "$s" = golden ]; then pnpm --filter @ordo/renderer golden --strict || status=1
        else pnpm --filter @ordo/renderer "$s" || status=1; fi
      done
      for d in golden compositor-golden; do [ -d "test-results/$d" ] && cp -r "test-results/$d" /out/; done
      exit $status'
