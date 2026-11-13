import { configureModelCache, getModelAsset } from './model-cache.mjs';
// htmlsift Mini inference: INT8 token-embedding ONNX table -> mean pooling per
// rendered line -> structural features -> BiGRU ONNX head -> sigmoid / 0.5.
// Model assets are deliberately NOT shipped. Downloaded on first use by model-cache.mjs.
// Uses the same ONNX Runtime WASM already embedded in Transformers.js.
import {
  AutoTokenizer, env, ManemarkOrtSession, ManemarkOrtTensor, ManemarkOrtEnv
} from './vendor/transformers.min.js';

const MAX_BLOCKS = 5000;
const MAX_TOKENS = 60000;
// Avoid materialising a whole long page's token embeddings at once. The ONNX
// embedding table accepts a 1-D ids tensor, so batches produce the same pooled
// line vectors while keeping intermediate tensors bounded.
const TABLE_BATCH_TOKENS = 2048;
let modelPromise;
let chain = Promise.resolve();

configureModelCache(env);
env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;
ManemarkOrtEnv.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
ManemarkOrtEnv.wasm.numThreads = 1;

const getAsset = name => getModelAsset('htmlsift-mini/' + name);

async function loadModel() {
  if (modelPromise) return modelPromise;
  modelPromise = (async () => {
    // Test every asset BEFORE initiating a large ONNX session allocation.
    const manifest = await (await getAsset('manifest.json')).json();
    if (manifest.mode !== 'mini') throw new Error('htmlsift manifest.json must be for the mini model.');
    // tokenizers.json is the actual training tokenizer. The small
    // tokenizer_config.json file in this extension tells Transformers.js how
    // to instantiate its generic fast-tokenizer-compatible implementation.
    await getAsset('tokenizer.json');
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
  const ids = [];
  const lengths = [];
  for (const block of blocks) {
    const blockIds = tok.encode(block, { add_special_tokens: false });
    const take = cap > 0 ? Math.min(blockIds.length, cap) : blockIds.length;
    if (ids.length + take > MAX_TOKENS) {
      throw new Error(`Page has too many tokens (over ${MAX_TOKENS}).`);
    }
    lengths.push(take);
    for (let j = 0; j < take; j++) ids.push(BigInt(blockIds[j]));
  }
  return { ids: BigInt64Array.from(ids), lengths };
}

async function poolTokenBatches(table, ids, lengths) {
  let pooled = null;
  let hidden = 0;
  let line = 0;
  let tokensInLine = 0;
  for (let start = 0; start < ids.length; start += TABLE_BATCH_TOKENS) {
    const batch = ids.subarray(start, Math.min(ids.length, start + TABLE_BATCH_TOKENS));
    const result = await table.run({ ids: new ManemarkOrtTensor('int64', batch, [batch.length]) });
    const emb = result.out;
    try {
      if (!emb || emb.dims.length !== 2 || emb.dims[0] !== batch.length) {
        throw new Error('Unexpected htmlsift table output shape.');
      }
      if (!pooled) {
        hidden = emb.dims[1];
        pooled = new Float32Array(lengths.length * hidden);
      } else if (emb.dims[1] !== hidden) {
        throw new Error('htmlsift table returned inconsistent embedding widths.');
      }
      // Token order is preserved across batches; empty lines have zero length.
      // Accumulate directly into line vectors, not a page-sized embedding array.
      for (let t = 0; t < batch.length; t++) {
        while (line < lengths.length && tokensInLine >= lengths[line]) {
          line++;
          tokensInLine = 0;
        }
        if (line >= lengths.length) throw new Error('htmlsift token alignment failed.');
        const source = t * hidden;
        const target = line * hidden;
        for (let k = 0; k < hidden; k++) pooled[target + k] += emb.data[source + k];
        tokensInLine++;
      }
    } finally {
      // Release the inference output instead of waiting for garbage collection.
      emb?.dispose?.();
    }
  }
  for (let lineIndex = 0; lineIndex < lengths.length; lineIndex++) {
    const count = lengths[lineIndex];
    if (!count) continue;
    const offset = lineIndex * hidden;
    for (let k = 0; k < hidden; k++) pooled[offset + k] /= count;
  }
  return { pooled, hidden };
}

async function predict(blocks, features) {
  if (blocks.length>MAX_BLOCKS) throw new Error(`Page has more than ${MAX_BLOCKS} rendered lines.`);
  const { manifest, tokenizer, table, head }=await loadModel();
  const { ids, lengths }=prepTokens(blocks,tokenizer,manifest.cap || 0);
  if (!ids.length) return {text:'',blocks:0};
  const { pooled, hidden } = await poolTokenBatches(table, ids, lengths);
  const normalized=buildFeatures(features,blocks.length,manifest);
  const width=hidden+(normalized.width || 0);
  const x=new Float32Array(blocks.length*width);
  for (let i=0;i<blocks.length;i++) {
    x.set(pooled.subarray(i*hidden,(i+1)*hidden),i*width);
    if (normalized.values) x.set(normalized.values.subarray(i*normalized.width,(i+1)*normalized.width),i*width+hidden);
  }
  const scored=await head.run({x:new ManemarkOrtTensor('float32',x,[1,blocks.length,width])});
  const logits=scored.logits;
  try {
    if (!logits || logits.data.length!==blocks.length) throw new Error('Unexpected htmlsift head logits shape.');
    const selected=[];
    for (let i=0;i<blocks.length;i++) {
      const prob=1/(1+Math.exp(-Number(logits.data[i])));
      if (prob>0.5) selected.push(blocks[i]);
    }
    return {text:selected.join('\n'),blocks:selected.length};
  } finally {
    logits?.dispose?.();
  }
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
