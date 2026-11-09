// Bundles the headless runner into one dependency-free ESM file for Node 20+.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
await build({
  entryPoints: [new URL('../src/headless/main.ts', import.meta.url).pathname],
  outfile: new URL('../dist-headless/augur-headless.mjs', import.meta.url).pathname,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  define: { 'process.env.AUGUR_VERSION': JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
});
console.log(`dist-headless/augur-headless.mjs (${version})`);
