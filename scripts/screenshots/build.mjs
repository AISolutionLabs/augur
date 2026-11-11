// Bundles the real Augur components with @grafana/ui for screenshots (@grafana/runtime is mocked).
import { build } from 'esbuild';
import { cpSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const app = path.resolve(here, '../../augur-app');
const out = path.join(here, 'out');
const require = createRequire(path.join(app, 'package.json'));

mkdirSync(out, { recursive: true });
const icons = path.join(out, 'public/build/img/icons/unicons');
if (!existsSync(icons)) {
  mkdirSync(icons, { recursive: true });
  cpSync(path.join(here, 'node_modules/@iconscout/unicons/svg/line'), icons, { recursive: true });
}

await build({
  entryPoints: [path.join(here, 'entry.tsx')],
  bundle: true,
  outfile: path.join(out, 'bundle.js'),
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.HARNESS_ENV ?? 'production'), global: 'window' },
  loader: { '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.png': 'dataurl', '.ttf': 'dataurl', '.css': 'empty' },
  alias: { '@grafana/runtime': path.join(here, 'runtime-mock.tsx') },
  nodePaths: [path.join(app, 'node_modules')],
  resolveExtensions: ['.tsx', '.ts', '.mjs', '.js', '.json'],
  logLevel: 'warning',
  minify: process.env.HARNESS_ENV !== 'development',
});

for (const [scene, slow] of [['investigation', false], ['actions', false], ['investigation-slow', true]]) {
  const sceneName = scene.replace('-slow', '');
  writeFileSync(
    path.join(out, `${scene}.html`),
    `<!doctype html><html><head><meta charset="utf-8"><title>Augur ${scene}</title>
<style>html,body{margin:0;background:#111217;font-family:Inter,Helvetica,Arial,sans-serif}</style>
<script>window.__SCENE__=${JSON.stringify(sceneName)};window.__SLOW__=${slow};window.__grafana_public_path__='/public/';</script></head>
<body><div id="root"></div><script type="module" src="bundle.js"></script></body></html>`
  );
}
console.log('built', out, require.resolve('@grafana/ui') ? '' : '');
