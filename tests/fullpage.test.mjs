import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { renderMarkdown, safeLink } from '../markdown-renderer.mjs';
const source = (await readFile(new URL('../fullpage.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
function element() {
 return {hidden:false,attributes:{},handlers:{},classes:new Set(),dataset:{},textContent:'',innerHTML:'',
 setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},
 addEventListener(event,handler){this.handlers[event]=handler;},replaceChildren(){this.innerHTML='';},
 classList:{toggle(){}},closest(){return null;},matches(){return false;}};
}
async function setup() {
 const parts=new Map(); const part=s=>{if(!parts.has(s))parts.set(s,element());return parts.get(s);};
 const viewer=element();viewer.querySelector=part;
 const rows=['1','2'].map(id=>{const row=element();row.dataset.snapshotId=id;row.querySelector=()=>({textContent:'Document '+id});row.matches=()=>true;return row;});
 const list=element();list.querySelectorAll=()=>rows;
 const docs=[{id:1,title:'First',url:'https://example.com',text:'# Heading\n\n**Original text**'},{id:2,title:'Second',text:'Other text'}];
 const events={};const copies=[];
 const context=vm.createContext({URLSearchParams,location:{search:'?view=page'},renderMarkdown,safeLink,
 document:{createElement:()=>viewer,body:{append(){}},getElementById:()=>list},
 window:{addEventListener:(event,handler)=>events[event]=handler},sessionStorage:{getItem:()=>null,setItem(){}},
 navigator:{clipboard:{writeText:async text=>copies.push(text)}},setTimeout:()=>1,clearTimeout(){},
 chrome:{storage:{local:{get:async()=>({snapshots:docs})}}}});
 vm.runInContext(source,context);await new Promise(resolve=>setImmediate(resolve));
 return {part,list,rows,docs,copies,events,click(i){list.handlers.click({target:{closest:s=>s==='a,button,input'?null:rows[i]}});}};
}
test('full-page selection renders markdown; raw and copy preserve original text',async()=>{
 const ui=await setup();ui.click(0);
 assert.equal(ui.part('.viewer-title').textContent,'First');
 assert.match(ui.part('.viewer-markdown').innerHTML,/<h1>Heading<\/h1>/);
 ui.part('#rawViewBtn').handlers.click();
 assert.equal(ui.part('.viewer-raw').hidden,false);
 assert.equal(ui.part('.viewer-markdown').hidden,true);
 assert.equal(ui.part('.viewer-raw').textContent,ui.docs[0].text);
 await ui.part('#viewerCopyBtn').handlers.click();assert.equal(ui.copies[0],ui.docs[0].text);
 ui.list.handlers.keydown({key:'Enter',target:ui.rows[1],preventDefault(){}});
 assert.equal(ui.part('.viewer-title').textContent,'Second');
});
test('live deletion clears viewer; nested item controls do not change selection',async()=>{
 const ui=await setup();ui.click(0);
 ui.list.handlers.click({target:{closest:()=>({})}});
 assert.equal(ui.part('.viewer-title').textContent,'First');
 ui.events['manemark-library-rendered']({detail:{snapshots:[]}});
 assert.equal(ui.part('.viewer-empty').hidden,false);
 assert.equal(ui.part('#viewerCopyBtn').disabled,true);
 assert.equal(ui.part('.viewer-raw').textContent,'');
});
