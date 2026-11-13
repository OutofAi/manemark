import test from 'node:test';
import assert from 'node:assert/strict';
const saved = new Map();
globalThis.caches = { async open() { return {
  async match(url) { return saved.get(url)?.clone(); },
  async put(url, response) { saved.set(url, response.clone()); }
}; } };
let calls = 0;
globalThis.fetch = async () => { calls++; return new Response(new Uint8Array(2048)); };
const { getModelAsset, configureModelCache, MODEL_ASSETS } = await import('../model-cache.mjs');
const weight = 'Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx';
test('concurrent downloads are deduplicated and cached across loader restarts, offline', async () => {
  const responses = await Promise.all([getModelAsset(weight), getModelAsset(weight)]);
  assert.equal(calls, 1);
  assert.equal((await responses[0].arrayBuffer()).byteLength, 2048);
  assert.equal((await responses[1].arrayBuffer()).byteLength, 2048);
  globalThis.fetch = async () => { throw new Error('offline'); };
  const restarted = await import('../model-cache.mjs?restart');
  assert.equal((await (await restarted.getModelAsset(weight)).arrayBuffer()).byteLength, 2048);
});
test('failed or invalid downloads are not cached and can be retried', async () => {
  const path = 'htmlsift-mini/mini-head-fABC.onnx';
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  await assert.rejects(getModelAsset(path), /503/);
  assert.equal(saved.has(MODEL_ASSETS[path]), false);
  globalThis.fetch = async () => new Response('version https://git-lfs.github.com/spec/v1');
  await assert.rejects(getModelAsset(path), /Invalid or incomplete/);
  assert.equal(saved.has(MODEL_ASSETS[path]), false);
  globalThis.fetch = async () => new Response(new Uint8Array(2048));
  await getModelAsset(path);
  assert.equal(saved.has(MODEL_ASSETS[path]), true);
});
test('only named data assets are fetched; local runtime is not routed remotely', async () => {
  await assert.rejects(getModelAsset('vendor/runtime.wasm'), /not allowlisted/);
  const env = {};
  configureModelCache(env);
  assert.equal(env.allowRemoteModels, false);
  assert.equal(await env.customCache.match(env.localModelPath + '../vendor/runtime.wasm'), undefined);
  assert.equal(await env.customCache.match(env.localModelPath + 'Xenova/all-MiniLM-L6-v2/config.json'), undefined);
  const response = await env.customCache.match(env.localModelPath + weight);
  assert.equal((await response.arrayBuffer()).byteLength, 2048);
});
