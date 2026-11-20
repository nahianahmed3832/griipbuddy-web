#!/usr/bin/env bash
set -euo pipefail

revision=${1:?Usage: bash deploy/build-images.sh GIT_REVISION}
case "$revision" in
  *[!0-9a-f]*|"") printf '%s\n' 'Use a hexadecimal source revision.' >&2; exit 2 ;;
esac
if [ "${#revision}" -lt 12 ] || [ "${#revision}" -gt 64 ]; then
  printf '%s\n' 'Use a source revision between 12 and 64 characters.' >&2
  exit 2
fi

cd "$(dirname "$0")/.."
node_image=${STAGE_NODE_IMAGE:-node:22.22.3-bookworm-slim}
profile=${2:-staging}
case "$profile" in
  staging) image=griipbuddy-storefront-stage ;;
  production) image=griipbuddy-storefront-prod ;;
  *) printf '%s\n' 'Use staging or production.' >&2; exit 2 ;;
esac
for target in operator runtime; do
  tag=$image
  if [ "$target" = operator ]; then tag="$image-operator"; fi
  docker build --build-arg "NODE_IMAGE=$node_image" \
    --label "org.opencontainers.image.revision=$revision" --target "$target" --tag "$tag:$revision" .
done
