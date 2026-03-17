import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { rmSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, 'out');

// Keep packaging clean: remove stale JS files from older builds.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [resolve(__dirname, 'src/extension.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  outfile: resolve(__dirname, 'out/extension.js'),
  external: ['vscode'],
});
