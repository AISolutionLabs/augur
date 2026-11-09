#!/usr/bin/env bash
# Type-checks both plugins against the oldest supported Grafana (12.0) packages and React 18 types,
# so APIs that only exist in Grafana 13 / React 19 are caught before release.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
npm init -y >/dev/null
npm i --no-audit --no-fund --legacy-peer-deps \
  @grafana/data@12.0.0 @grafana/ui@12.0.0 @grafana/runtime@12.0.0 @grafana/schema@12.0.0 \
  @types/react@18 @types/react-dom@18 react@18 react-dom@18 react-router-dom@6 rxjs@7 @emotion/css@11 typescript@5 >/dev/null
for p in augur-app augur-datasource; do
  mkdir -p "$p"
  cp -r "$ROOT/$p/src" "$p/"
  find "$p/src" -name '*.test.ts*' -delete
  rm -f "$p/src/agent/testUtils.ts"
  cat > "$p/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "ES2020", "module": "esnext", "moduleResolution": "bundler", "jsx": "react-jsx",
    "strict": true, "noEmit": true, "skipLibCheck": true, "esModuleInterop": true, "resolveJsonModule": true,
    "lib": ["dom", "dom.iterable", "es2022"], "typeRoots": ["../node_modules/@types"], "baseUrl": ".",
    "paths": {
      "react": ["../node_modules/@types/react"], "react/*": ["../node_modules/@types/react/*"],
      "react-dom": ["../node_modules/@types/react-dom"], "*": ["../node_modules/*", "../node_modules/@types/*"]
    }
  },
  "include": ["src"]
}
JSON
  echo "Type-checking $p against Grafana 12.0…"
  (cd "$p" && ../node_modules/.bin/tsc -p .)
done
echo "OK: compatible with Grafana 12.0 APIs"
