/** Build a button component with size and tone variants, the way an agent would. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE='http://localhost:4000';
const doc = await (await fetch(`${BASE}/api/documents`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({template:'clean',name:'Variants'})})).json();
const docId = doc.document.id;
const conn = await (await fetch(`${BASE}/api/documents/${docId}/connections`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'Variant Agent'})})).json();
const client = new Client({name:'v',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(conn.url)));
const call=async(n,a={})=>{const r=await client.callTool({name:n,arguments:a});const t=r.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');if(r.isError)throw new Error(`${n}: ${t}`);return t;};

const info = JSON.parse(await call('get_basic_info'));
const board = JSON.parse(await call('create_artboard',{name:'Buttons',width:900,height:420}));
const shell = JSON.parse(await call('write_html',{targetId:board.id,mode:'replace-children',html:`
  <div style="display:flex;flex-direction:column;gap:28px;padding:48px;background:var(--color-bg);font-family:Inter,sans-serif;height:100%">
    <span style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--color-muted)">Button variants</span>
    <div style="display:flex;flex-direction:row;gap:16px;align-items:center;flex-wrap:wrap"></div>
  </div>`}));

const rowId = JSON.parse(await call('get_children',{id:shell.roots[0].id}))[1].id;
const seed = JSON.parse(await call('write_html',{targetId:rowId, html:`
  <div style="display:flex;align-items:center;justify-content:center;padding:12px 20px;border-radius:8px;background:var(--color-brand);color:var(--color-on-brand);font-size:15px;font-weight:600;width:fit-content"><span>Button</span></div>`}));

const cmp = JSON.parse(await call('create_component',{id:seed.roots[0].id,name:'Button'}));
await call('set_component_props',{componentId:cmp.componentId,props:[
  {name:'size',values:['sm','md','lg'],default:'md'},
  {name:'tone',values:['brand','neutral','danger'],default:'brand'},
]});

const inst = JSON.parse(await call('get_instance',{id:cmp.instanceId}));
const labelId = inst.overridableParts.find(p=>p.type==='text').defId;
const rootId = cmp.definitionRoot;

await call('set_variant',{componentId:cmp.componentId,match:{size:'sm'},overrides:[{defId:rootId,styles:{padding:'7px 12px','font-size':'13px','border-radius':'6px'}}]});
await call('set_variant',{componentId:cmp.componentId,match:{size:'lg'},overrides:[{defId:rootId,styles:{padding:'16px 30px','font-size':'18px','border-radius':'11px'}}]});
await call('set_variant',{componentId:cmp.componentId,match:{tone:'neutral'},overrides:[{defId:rootId,styles:{background:'transparent',color:'var(--color-fg)',border:'1px solid var(--color-border)'}}]});
await call('set_variant',{componentId:cmp.componentId,match:{tone:'danger'},overrides:[{defId:rootId,styles:{background:'#dc2626',color:'#fff'}}]});
await call('set_variant',{componentId:cmp.componentId,match:{size:'lg',tone:'danger'},overrides:[{defId:labelId,text:'Delete everything'}]});

// One instance per combination.
const parentId = rowId;
const combos=[['sm','brand'],['md','brand'],['lg','brand'],['sm','neutral'],['md','neutral'],['lg','danger']];
const created=JSON.parse(await call('insert_instance',{componentId:cmp.componentId,parentId,count:combos.length}));
await call('set_instance_props',{updates:created.created.map((id,i)=>({instanceId:id,props:{size:combos[i][0],tone:combos[i][1]}}))});
await call('delete_nodes',{ids:[cmp.instanceId]});

const list=JSON.parse(await call('list_components'));
console.log('component:',JSON.stringify(list.components[0].props));
console.log('variants:',JSON.stringify(list.components[0].variants));
console.log('instances:',list.components[0].instances);
console.log('URL:',`${BASE}/d/${docId}`);
console.log('ARTBOARD:',board.id, 'DOC:', docId);
await client.close();
