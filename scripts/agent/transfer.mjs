/**
 * Copies a document from one Playground instance to another.
 *
 *   node scripts/agent/transfer.mjs <fromBase> <docId> <toBase> [name]
 *
 * Goes through the document bundle rather than HTML, so tokens, components and
 * assets arrive with it instead of being flattened away.
 */
import '../lib/session.mjs';
import { writeFileSync } from 'node:fs';

const [from, docId, to, name] = process.argv.slice(2);
if (!from || !docId || !to) {
  console.log('usage: transfer.mjs <fromBase> <docId> <toBase> [name]');
  process.exit(1);
}

const res = await fetch(`${from}/api/documents/${docId}/bundle`);
if (!res.ok) {
  console.error(`  export failed (${res.status}):`, (await res.text()).slice(0, 200));
  process.exit(1);
}
const bundle = await res.json();
const bytes = JSON.stringify(bundle).length;
console.log(`  exported "${bundle.document.name}" — ${Object.keys(bundle.document.nodes).length} nodes, ` +
  `${bundle.document.tokens?.length ?? 0} tokens, ` +
  `${Object.keys(bundle.document.components ?? {}).length} component(s), ` +
  `${bundle.assets.length} asset(s), ${(bytes / 1024).toFixed(0)}KB`);

// Kept on disk as well: the transfer is also a backup, and if the import is
// refused there is something to inspect rather than a lost round trip.
const file = `/tmp/${docId}.playground.json`;
writeFileSync(file, JSON.stringify(bundle, null, 2));
console.log('  saved to', file);

const imported = await fetch(`${to}/api/documents/import${name ? `?name=${encodeURIComponent(name)}` : ''}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bundle),
});
const body = await imported.json();
if (!imported.ok) {
  console.error(`  import refused (${imported.status}):`, body.error);
  for (const p of body.problems ?? []) console.error('   -', p);
  process.exit(1);
}
for (const note of body.notes ?? []) console.log('  note:', note);
console.log(`  imported — ${body.assets} asset(s) re-stored`);
console.log('\n ', body.url);
