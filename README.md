# Manemark 1.2.8 — optional AI extraction or raw HTML capture

This is the original **Manemark 1.2.2** extension with an optional, locally supplied **htmlsift Mini** content-extraction model integrated into the Save and Copy page actions. The original MiniLM semantic-search model and snapshot/highlight storage are unchanged. **No htmlsift weights are included** in this archive.

## Manual model download for AI extraction (four files)

Open the [htmlsift Mini model directory on Hugging Face](https://huggingface.co/koivualeksi/htmlsift-release/tree/main/mini) and download **all four** files below. Put them, unchanged, next to the provided `tokenizer_config.json` in `models/htmlsift-mini/`:

| Expected path | Direct official file |
|---|---|
| `models/htmlsift-mini/manifest.json` | [manifest.json](https://huggingface.co/koivualeksi/htmlsift-release/resolve/main/mini/manifest.json?download=true) |
| `models/htmlsift-mini/tokenizer.json` | [tokenizer.json](https://huggingface.co/koivualeksi/htmlsift-release/resolve/main/mini/tokenizer.json?download=true) |
| `models/htmlsift-mini/mini-table-int8.onnx` | [mini-table-int8.onnx](https://huggingface.co/koivualeksi/htmlsift-release/resolve/main/mini/mini-table-int8.onnx?download=true) |
| `models/htmlsift-mini/mini-head-fABC.onnx` | [mini-head-fABC.onnx](https://huggingface.co/koivualeksi/htmlsift-release/resolve/main/mini/mini-head-fABC.onnx?download=true) |

The official package pins model revision `73ac2b978aef356e9e5772640a0c9444f2b67705`, so you can also [download the pinned files](https://huggingface.co/koivualeksi/htmlsift-release/tree/73ac2b978aef356e9e5772640a0c9444f2b67705/mini) rather than the moving `main` branch. Don't download the `base/` bundle, another quantization, or Git LFS/Xet **pointer text** instead of real ONNX files.

The supplied `tokenizer_config.json` is a compatibility shim for the bundled Transformers.js tokenizer. Do not overwrite the four original model artifacts with it.

## Load the extension

1. Unzip the archive to a permanent folder.
2. Copy the four model files above into `models/htmlsift-mini/`.
3. Open **Chrome → chrome://extensions**, enable **Developer mode**, click **Load unpacked**, and choose the directory with `manifest.json`.
4. On an ordinary HTTP(S) article, click **Manemark**. The first extraction must load the ONNX files into memory and may be substantially slower than subsequent saves.
5. The **Copy page text** button uses the same AI content-extraction route, without saving the result.
6. Existing selected-text highlight saves, local snapshot storage, import/export, and MiniLM semantic search remain in place.

In the default AI mode, if the model weights have not been installed, clicking **Manemark** or **Copy page text** displays a missing-file error; it will not silently change your selected mode. To capture raw HTML without the model, open the settings cog and uncheck **AI content extraction**. After copying/replacing the model assets for AI mode, reload the extension from `chrome://extensions`.

## How it works

```text
content.js (DOM outerHTML)
  → popup.js → background.js (queues a short-lived extraction request)
  → offscreen.js (DOMParser + HTML-to-line renderer + 33 DOM features)
  → htmlsift-worker.js (tokenize → mini-table-int8.onnx → mean-pool →
                        normalized features → mini-head-fABC.onnx → sigmoid)
  → background.js (saves only lines with probability > 0.5)
  → offscreen.js (sends completion event to popup; no long-lived message port)
```

All inference is local in Chrome, on the **CPU via ONNX Runtime Web (WebAssembly)**. The extension uses the already bundled ONNX Runtime 1.21 runtime rather than introducing a second WASM runtime. The existing semantic worker continues to use its bundled MiniLM model. No Python, network service, remotely hosted JavaScript, API key, or external inference endpoint is required. Download the checkpoint manually, before running the extension.

## Important limitations / test status

- **Checkpoint integration has not been validated with actual htmlsift weights in this build**, since the four model files were deliberately not included. JavaScript syntax and the bundled ONNX Runtime / tokenizer module exports were checked. Test the extraction on real pages after placing the weights; if a session fails, inspect `chrome://extensions` → Inspect views → offscreen document and its worker console.
- This is a browser-DOM **port** of htmlsift's preprocessing, not the published Python package. htmlsift Python tokenizes all lines as one string with offset mapping; this port tokenizes each line separately because Transformers.js does not expose that offset mapping API. The results can differ, especially for some token boundaries. The DOM renderer is also an adaptation of lxml to DOMParser. **Do not assume the published accuracy figures hold for this port** without testing.
- The model needs a lot of RAM even when the checkpoint is quantized. Chrome may reject very large or complex pages. Input is capped at 8 million HTML characters, 5,000 rendered lines, or 60,000 input tokens, whichever comes first.
- In AI mode this saves extracted **plain text** in the existing snapshots format; raw mode saves full HTML markup as text. It doesn't currently save sanitized article HTML or Markdown. It captures the live DOM, including SPA-rendered text, but it won't traverse closed shadow DOM roots.
- AI content extraction is used for page saves and page-text copying. Highlight-link saves intentionally remain exact selections; semantic search remains unchanged.
- Save continues in the offscreen document if the popup closes; the popup must stay open to receive a Copy result. The first ONNX load can take time on slower devices.

## Licensing

htmlsift source and [release model weights](https://huggingface.co/koivualeksi/htmlsift-release) are licensed **Apache-2.0**; trained on **WebMainBench**, which the authors ask users to attribute. Review the upstream repository and licensing/attribution terms before redistribution. This extension does not include their weights or vendored source verbatim.

Upstream: https://github.com/koivualeksi/htmlsift

## Fix in version 1.2.4: closed message ports

The previous build chained `chrome.tabs.sendMessage` and `chrome.runtime.sendMessage` calls through a content script, a background worker, and an offscreen document, waiting for neural inference before replying. A long ONNX initialization could therefore close an intermediate message channel and produce Chrome's unhelpful `The message port closed before a response was received` error.

Save and Copy now capture the DOM directly from the popup, queue an extraction job with an immediate acknowledgement, and receive completion in a separate `htmlsiftJobComplete` event. Saves are committed by the offscreen document even if the popup closes. Model-file and runtime errors are displayed explicitly. A 3-minute worker watchdog handles a stuck model.

After replacing the extension files, open `chrome://extensions`, choose **Reload** for Manemark, then reopen the popup. Preserve your `models/htmlsift-mini/` files when updating.

## Fix in version 1.2.5: search text persists when reopening popup

When you search saved Manemarks and open a result link, Chrome closes the popup.
The popup now saves the search query synchronously to extension-local browser
storage on each input, and restores it before rendering the list the next
time you open Manemark. Search results are recalculated from the saved query.
Clearing the search box also clears the saved filter. The query is kept
across Chrome restarts until you clear it, and stays on the current device.

## Fix in version 1.2.6: focus the current page after restoring search

The popup now waits until semantic results have rendered before automatically
scrolling the list to the Manemark for the active tab and highlighting it in
orange. This works with a remembered query even when the search worker returns
asynchronously. If an older search excludes the current page, the current
Manemark is shown separately and labeled **Current page**; it is not counted
as a search match. Scrolling happens once, so subsequent background updates
should not repeatedly pull the list away from manual scrolling. The search
text still persists when reopening the popup.

## New in version 1.2.7: export only search results

While a semantic search query is active, **Export → SEARCH** appears alongside
JSON and ZIP. Once the results finish loading, SEARCH downloads a standard,
importable JSON file (`manemark-search-YYYY-MM-DD.json`) containing only the
ranked, threshold-qualified search hits, plus the search query as metadata.
It deliberately excludes any extra **Current page** item shown solely to
indicate the active tab. When there is no query, SEARCH is hidden; while
results are loading or there are no matches, it is visible but disabled.
The existing full-library JSON and ZIP exports are unchanged.

## New in version 1.2.8: AI extraction toggle and footer settings

The library footer now stays visible with **left-aligned library statistics** and a **settings cog on the right** (using `assets/cog.svg`). Click the cog to open Settings in the popup, and use **← Back** or click the cog again to return to the library.

**AI content extraction** is checked by default. With it checked, Manemark and Copy page use the existing local htmlsift model to extract the main text (as before). Uncheck it to save or copy the **unfiltered page HTML markup** (DOM `outerHTML`, with the doctype where available), retaining tags, attributes, and other markup instead of running htmlsift. This also works without htmlsift checkpoint files. The selection is stored in `chrome.storage.local` under `aiExtractionEnabled` and persists across popup reopenings and restarts. Changing the option affects *new* Save/Copy jobs, not existing saved Manemarks, selection highlights, or semantic search.

**Note:** Raw HTML is stored as text in the existing Manemark library format. The extension never executes that HTML when showing previews; do not mistake this for an offline webpage archive with embedded resources.
