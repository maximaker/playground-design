/**
 * Bundles the server into a single Vercel function.
 *
 * Vercel's Node builder transpiles the entry file but will not follow `.ts`
 * imports into a workspace package, so the server has to arrive as one file.
 * Bundling also keeps the function small, which matters for cold starts.
 */

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('api', { recursive: true });

await build({
  entryPoints: ['server-entry/index.ts'],
  outfile: 'api/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Optional at runtime and heavy; both are loaded through dynamic imports that
  // fail softly when absent.
  external: ['playwright', 'node:sqlite'],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
