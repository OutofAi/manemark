# Manemark 1.2.21 — first-use model downloads

## Behaviour

MiniLM weights download when semantic indexing or a search first needs them.
htmlsift's manifest, tokenizer and two ONNX files download on first AI extraction.
All downloads use fixed, revision-pinned Hugging Face URLs in model-cache.mjs.
Small existing MiniLM configuration/tokenizer files remain bundled.

The existing offscreen page owns background indexing and extraction workers,
so closing the popup does not cancel those jobs. Query-only inference still uses a popup-owned worker, but model downloads are
now delegated to the offscreen page. Closing the popup does not cancel them.
A subsequent request retries any incomplete file. Completed files are reused.

Model files are stored separately in Cache Storage, under manemark-model-data-v1.
Computed document embeddings and the IVF index retain their existing IndexedDB
stores. Requests for a shared file are serialized with Web Locks. Failed HTTP
responses, truncated transfers and obvious non-model payloads are not committed.
Basic format checks are not cryptographic integrity verification.

No page text is sent to Hugging Face. It receives requests for public model files.
JavaScript, ONNX Runtime, WASM and worker modules remain packaged in vendor/.
Generic Transformers.js remote loading remains disabled; its custom cache adapter
only supplies explicitly allowlisted model data. No remote eval/import is added.

## Permissions

Hugging Face and its hf.co download hosts are allowed for model retrieval.
unlimitedStorage protects model/cache storage from ordinary quota limits and
browser eviction. Uninstalling the extension or explicitly clearing its data
still removes the cache. These added permissions should be reflected in the
Chrome Web Store listing/privacy disclosures. Store approval is not guaranteed.

## Try it in Chrome

1. Unzip, then use chrome://extensions → Developer mode → Load unpacked.
   When updating an existing unpacked install, retain its directory/extension ID
   to retain saved data. Back up saved pages before changing installations.
2. With internet access, enable Semantic Search and save a page. Close/reopen the
   popup while indexing. Confirm it completes and search returns saved pages.
3. Save a page with AI extraction enabled and allow the initial htmlsift download.
4. Once both features have completed, go offline, restart Chrome, and repeat
   extraction and search. The models should load from the persistent cache.
5. Test a first download interrupted by losing connectivity; retry online.

## Validation performed

13 automated tests pass: existing ranking/IVF behaviour and new cache tests for
concurrent requests, offline reuse after a loader restart, failed/invalid downloads,
retry, and the model-data allowlist. Worker syntax checks pass.
The htmlsift manifest URL and MiniLM pinned revision were verified live.
Full downloads, actual ONNX inference and Chrome permission/redirect behaviour
have not been exercised in a running Chrome extension in this environment.


## Download progress in 1.2.21

A separate download bar is stacked above indexing, so both can appear together.
It says “One-time model download”, identifies AI extraction / semantic search,
and shows the current active transfers' combined byte progress where the server
supplies sizes. Unknown sizes show an indeterminate bar and received megabytes.
Percentages describe active files, not a predicted whole-model bundle size.
Each file completes only after validation and the cache write succeed.
Completion is shown briefly; cached loads do not show download progress.
Failures show a retry hint. Progress is throttled and saved in session storage,
so reopening the popup restores it even if the background service worker sleeps.
Downloads run in the offscreen page independently of disposable inference workers.
The one-time wording applies while these model revisions remain cached.

Tests additionally cover simultaneous downloads alongside indexing, unknown
sizes, completion/error display, byte progress and quiet cache hits. Syntax
checks pass. Visual Chrome testing was unavailable because the browser executable
is not installed; the HTML uses the existing footer styling for both stacked bars.
