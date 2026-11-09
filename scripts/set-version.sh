#!/usr/bin/env bash
# Sets the version of both plugins (package.json drives plugin.json at build time).
set -euo pipefail
VERSION="${1:?usage: set-version.sh X.Y.Z[-pre]}"
VERSION="${VERSION#v}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid semver: $VERSION" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for p in augur-app augur-datasource; do
  (cd "$ROOT/$p" && npm version "$VERSION" --no-git-tag-version --allow-same-version >/dev/null)
done
echo "$VERSION"
