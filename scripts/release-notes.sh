#!/usr/bin/env bash
# Prints the CHANGELOG sections for VERSION from both plugins (empty if none).
set -euo pipefail
VERSION="${1:?usage: release-notes.sh X.Y.Z}"
VERSION="${VERSION#v}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
section() {
  awk -v v="$VERSION" '
    /^## / { if (found) exit; if ($2 == v) { found = 1; next } }
    found { print }
  ' "$1"
}
APP="$(section "$ROOT/augur-app/CHANGELOG.md")"
DS="$(section "$ROOT/augur-datasource/CHANGELOG.md")"
if [ -n "$APP" ]; then printf '### Augur app (augur-assistant-app)\n%s\n\n' "$APP"; fi
if [ -n "$DS" ]; then printf '### Claude (Augur) datasource (augur-claude-datasource)\n%s\n\n' "$DS"; fi
cat <<MD
### Install
1. Download both zips below and unzip them into your Grafana plugins directory (Grafana 12.0+).
2. Unsigned builds need \`allow_loading_unsigned_plugins = augur-assistant-app,augur-claude-datasource\`.
3. Verify downloads with \`sha256sum -c SHA256SUMS\` and, optionally, \`gh attestation verify <zip> --repo AniAIApps/augur\`.
MD
