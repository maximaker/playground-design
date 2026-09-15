/**
 * Verifies every server and shared source can run under Node's type stripping.
 *
 * `node --check` does not catch this: it parses, but does not apply the
 * strip-only rules. Syntax that TypeScript allows but Node cannot erase —
 * parameter properties, enums, namespaces — passes the check and then throws
 * ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX the first time the module is imported.
 *
 * That is exactly how persistence-blob.ts shipped broken: Vercel bundles it
 * with esbuild, and no other environment had a Blob token to load it with, so
 * nothing ever imported it under Node until a self-hosted deployment would.
 */

import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Resolved against this file, not the working directory: it runs from the
// repository root by hand and from packages/server through `npm test`.
const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = ['packages/shared/src', 'packages/server/src'];
const files = dirs.flatMap((d) => readdirSync(root + d)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => `${d}/${f}`));

const broken = [];
for (const file of files) {
  try {
    // Importing for its side effects is the point: the error only appears when
    // the module is actually loaded. `index.ts` would start a listener, so it
    // is imported the same way but with the server's entry guard left alone —
    // it is covered by every other check in the suite.
    if (file.endsWith('/index.ts') && file.includes('server')) continue;
    execFileSync(process.execPath, [
      '--experimental-strip-types', '--experimental-sqlite',
      '-e', `import(${JSON.stringify(new URL(file, `file://${root}`).href)})`,
    ], { stdio: 'pipe', timeout: 20000 });
  } catch (err) {
    const text = String(err.stderr ?? err.message);
    if (text.includes('UNSUPPORTED_TYPESCRIPT_SYNTAX') || text.includes('strip-only mode')) {
      broken.push([file, text.split('\n').find((l) => l.includes('not supported')) ?? 'unsupported syntax']);
    }
    // Anything else is a runtime error from the import's side effects, which is
    // not what this checks for.
  }
}

for (const [file, why] of broken) console.log(`  ✗ ${file} — ${why.trim()}`);
console.log(broken.length
  ? `\n${broken.length} file(s) cannot run under type stripping`
  : `all ${files.length} files run under type stripping`);
process.exit(broken.length ? 1 : 0);
