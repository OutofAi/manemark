# Manemark 1.2.19 — local IVF search and hover fix

This update is based on Manemark_copy_feedback_CSP_fix(1).zip and retains its copy feedback and CSP fix.

## Behaviour

- Fewer than 512 indexed chunks: existing exhaustive cosine search.
- At least 512 chunks: local spherical KMeans clusters with 4–64 partitions, scaled by chunk count. Search probes roughly one third of partitions.
- Candidate pages are ranked using their best score across all their chunks, preserving the existing page scoring rule. Pages outside the selected partitions can be omitted. This is approximate search; the popup labels it accordingly.
- Existing result threshold, export behaviour, local MiniLM embeddings and model settings are unchanged.
- Cluster metadata is cached in a separate IndexedDB database, reused across popup opens, and rebuilt when indexed document membership or fingerprints change. Existing embeddings do not need to be regenerated.
- Small collections use exact search; a clustering failure also falls back to exact search. Cache read/write failures do not prevent searching.
- No network requests, remote services, new permissions or dependencies were added.

## Installation

Extract the ZIP. For an existing unpacked installation, update that installation's folder and click Reload at chrome://extensions. Keep the existing extension identity to retain its browser data. Back up saved pages before switching installations.

The uploaded source ZIP does NOT contain models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx. This update does not supply those model weights. Retain that file from your working installation, or supply the compatible local MiniLM checkpoint before testing semantic search. The HTML extraction model assets are also incomplete in the source ZIP; see its existing README-MODEL-FILES.txt.

## Validation and limits

Run: node --test tests/*.test.mjs

Seven tests cover exact-search fallback, exhaustive-probe equivalence, candidate page scoring, approximate retrieval on synthetic clustered vectors, degenerate vectors, cache identity and a mocked worker/IndexedDB integration including persistence, edits and deletes. Syntax checks passed for the modified worker and popup.

The synthetic fixture reached 100% Recall@10 while scoring 25% of chunks with two of eight partitions. This is not a measured result on real saved pages or a guarantee of recall. No end-to-end Chrome/model inference test was possible with the missing weights.

Initial clustering adds work to the first search after the index changes. Training is bounded to 2,048 samples and six iterations; assignment covers every chunk. Work yields between batches. Large collections still load all stored embeddings into the worker; this change reduces similarity scoring, not IndexedDB read volume. Multi-topic pages may touch many clusters, reducing the speed benefit because every candidate page's chunks are rescored.

Tuning defaults are in semantic-ivf.mjs (IVF_MIN_CHUNKS, partition count, probe count). Probe all partitions for exhaustive-equivalent results. Measure recall against rankChunks() and end-to-end latency on representative saved pages before changing the defaults.

## 1.2.19 visual fix

Removed an accidentally duplicated block of copy-feedback styles from the dark-mode media query. Its selector applied 16px width and height directly to .btn-copy:hover, shrinking the button and moving its neighbouring delete button. Hover now changes only colour. Shared spinner and success styles remain in place. Static inspection verified the selector correction; a live hover check was blocked because Chromium could not launch in the execution sandbox.
