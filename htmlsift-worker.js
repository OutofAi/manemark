// htmlsift Mini inference: INT8 token-embedding ONNX table -> mean pooling per
// rendered line -> structural features -> BiGRU ONNX head -> sigmoid / 0.5.
// Model assets are deliberately NOT shipped. See models/htmlsift-mini/README.
// Uses the same ONNX Runtime WASM already embedded in Transformers.js.
import {
  AutoTokenizer, env, ManemarkOrtSession, ManemarkOrtTensor, ManemarkOrtEnv
} from './vendor/transformers.min.js';

const DIR = './models/htmlsift-mini/';
const url = name => new URL(DIR+name, import.meta.url).href;
const MAX_BLOCKS = 5000;
const MAX_TOKENS = 60000;
let modelPromise;
let chain = Promise.resolve();

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.useBrowserCache = false;
env.localModelPath = new URL('./models/', import.meta.url).href;
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;
ManemarkOrtEnv.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
ManemarkOrtEnv.wasm.numThreads = 1;

async function getAsset(name) {
  const response = await fetch(url(name));
  if (!response.ok) throw new Error(`Missing htmlsift Mini file: models/htmlsift-mini/${name}. Download all four model files from Hugging Face and reload the extension.`);
  return response;
}

async function loadModel() {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    // Test every asset BEFORE initiating a large ONNX session allocation.
    const manifest = await (await getAsset('config.json')).json();
    if (manifest.mode !== 'mini') throw new Error('htmlsift config.json must be for the mini model.');
    // tokenizers.json is the actual training tokenizer. The small
    // tokenizer_config.json file in this extension tells Transformers.js how
    // to instantiate its generic fast-tokenizer-compatible implementation.
    const tokenizer = await AutoTokenizer.from_pretrained('htmlsift-mini', {
      local_files_only: true
    });
    const tableBuffer = await (await getAsset('mini-table-int8.onnx')).arrayBuffer();
    const headBuffer = await (await getAsset('mini-head-fABC.onnx')).arrayBuffer();
    if (tableBuffer.byteLength < 1024 || headBuffer.byteLength < 1024) {
      throw new Error('htmlsift ONNX files are incomplete. Download the original Mini release files.');
    }
    const opts = { executionProviders: ['wasm'], intraOpNumThreads: 1, interOpNumThreads: 1 };
    const table = await ManemarkOrtSession.create(tableBuffer, opts);
    const head = await ManemarkOrtSession.create(headBuffer, opts);
    if (!table.inputNames.includes('ids') || !head.inputNames.includes('x')) {
      throw new Error('Unexpected htmlsift graph inputs: expected ids and x.');
    }
    return { manifest, tokenizer, table, head };
  })().catch(e => { modelPromise = null; throw e; });
  return modelPromise;
}

function featureIndices(groups) {
  const idx=[];
  if (groups.includes('A')) for (let j=0;j<30;j++) idx.push(j);
  if (groups.includes('B')) idx.push(30,31);
  if (groups.includes('C')) idx.push(32);
  return idx;
}
function buildFeatures(flat, n, manifest) {
  const groups = manifest.feats || '';
  if (!groups) return { indices: [], values: null };
  const indices = featureIndices(groups);
  const featureWidth = indices.length;
  const result = new Float32Array(n * featureWidth);
  const scalarCols = [30,32].filter(col => indices.includes(col));
  const mean=manifest.zscore?.mean ?? [];
  const std=manifest.zscore?.std ?? [];
  if (mean.length !== scalarCols.length || std.length !== scalarCols.length) {
    throw new Error('Invalid htmlsift feature normalization stats.');
  }
  for (let i=0;i<n;i++) {
    for (let j=0;j<indices.length;j++) {
      const col=indices[j];
      let v=flat[i*33+col];
      const k=scalarCols.indexOf(col);
      if (k!==-1) v=(v-mean[k])/(std[k] || 1);
      result[i*featureWidth+j]=v;
    }
  }
  return { values:result, width:featureWidth };
}

function prepTokens(blocks, tok, cap) {
  // Mini is a bag-of-token-embeddings model, so it does NOT need the encoder's
  // full-page token windows. Tokenizing each line individually preserves mean
  // pooled line content without relying on offset-mapping APIs (unavailable in
  // Transformers.js). Differences at line boundaries can cause small drift
  // relative to the Python tokenizer's joined-page tokenization.
  const ids = []; const members=[];
  for (const block of blocks) {
    const blockIds=tok.encode(block,{add_special_tokens:false});
    const take=cap>0?Math.min(blockIds.length,cap):blockIds.length;
    const mem=[];
    for (let j=0;j<take;j++) {
      mem.push(ids.length);
      ids.push(BigInt(blockIds[j]));
    }
    members.push(mem);
    if (ids.length > MAX_TOKENS) throw new Error(`Page has too many tokens (over ${MAX_TOKENS}).`);
  }
  return {ids:BigInt64Array.from(ids),members};
}

function pool(emb, members, hidden) {
  const pooled=new Float32Array(members.length*hidden);
  for (let i=0;i<members.length;i++) {
    const mem=members[i];
    if (!mem.length) continue;
    for (const id of mem) {
      const p=id*hidden; const q=i*hidden;
      for (let k=0;k<hidden;k++) pooled[q+k]+=emb[p+k];
    }
    const q=i*hidden;
    for (let k=0;k<hidden;k++) pooled[q+k]/=mem.length;
  }
  return pooled;
}

async function predict(blocks, features) {
  if (blocks.length>MAX_BLOCKS) throw new Error(`Page has more than ${MAX_BLOCKS} rendered lines.`);
  const { manifest, tokenizer, table, head }=await loadModel();
  const { ids, members }=prepTokens(blocks,tokenizer,manifest.cap || 0);
  if (!ids.length) return {text:'',blocks:0};
  const result = await table.run({ids:new ManemarkOrtTensor('int64',ids,[ids.length])});
  const emb=result.out;
  if (!emb || emb.dims.length!==2 || emb.dims[0]!==ids.length) throw new Error('Unexpected htmlsift table output shape.');
  const hidden=emb.dims[1];
  const pooled=pool(emb.data,members,hidden);
  const normalized=buildFeatures(features,blocks.length,manifest);
  const width=hidden+(normalized.width || 0);
  const x=new Float32Array(blocks.length*width);
  for (let i=0;i<blocks.length;i++) {
    x.set(pooled.subarray(i*hidden,(i+1)*hidden),i*width);
    if (normalized.values) x.set(normalized.values.subarray(i*normalized.width,(i+1)*normalized.width),i*width+hidden);
  }
  const scored=await head.run({x:new ManemarkOrtTensor('float32',x,[1,blocks.length,width])});
  const logits=scored.logits;
  if (!logits || logits.data.length!==blocks.length) throw new Error('Unexpected htmlsift head logits shape.');
  const selected=[];
  for (let i=0;i<blocks.length;i++) {
    const prob=1/(1+Math.exp(-Number(logits.data[i])));
    if (prob>0.5) selected.push(blocks[i]);
  }
  return {text:selected.join('\n'),blocks:selected.length};
}

self.onmessage=({data})=>{
  if (data?.type!=='extract') return;
  chain=chain.catch(()=>{}).then(async()=>{
    try {
      const result=await predict(data.blocks,data.features);
      postMessage({type:'extract-result',id:data.id,...result});
    } catch(error) {
      console.error('Manemark htmlsift Mini:',error);
      postMessage({type:'extract-error',id:data.id,message:error?.message || String(error)});
    }
  });
};
