import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(__dirname, 'src/extension.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  outfile: resolve(__dirname, 'out/extension.js'),
  external: ['vscode'],
});
