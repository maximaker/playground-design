import './lib/session.mjs';
const d = (await (await fetch(`http://localhost:4000/api/documents/${process.argv[2]}`)).json()).document;
for (const id of process.argv.slice(3)) {
  const n = d.nodes[id];
  console.log(id, n.type, n.tag, JSON.stringify(n.styles), 'text=', JSON.stringify(n.text), 'children', n.children.length);
}
