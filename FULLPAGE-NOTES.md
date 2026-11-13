# Full-page workspace — 1.2.25

The monitor icon now opens the local extension page popup.html?view=page in a
browser tab, instead of manemark.com. The workspace fills the tab and uses the
existing local library, import/export controls, settings, semantic search and
stacked model-download/indexing bars in a left column. The right column is a
large document viewer.

Click an item's card (or focus it and press Enter/Space) to select it. Its own
source link and Copy/Delete buttons keep their existing actions. The selected
card is highlighted. Selection is remembered within the workspace tab's session.
Markdown renders headings, lists, tables, blockquotes and code blocks. Raw shows
the exact stored text; Copy copies that exact text in either view. Switching
views does not rewrite saved content. Deleting a selected item clears the viewer.
Open views refresh when snapshots change in extension storage.

Markdown parsing is bundled locally using Marked 17.0.5 (MIT license included).
Embedded HTML is escaped, executable URL schemes are rejected, and image syntax
becomes a clickable image link rather than an automatic external image request.
Saved HTML in Raw capture mode is displayed as source, never executed.
No CDN scripts, new network hosts or additional permissions are used.

The full-page view is a library/reading workspace. Its page-capture controls
are hidden so it cannot accidentally capture its own extension tab. Capture
webpages using the existing popup or sidebar, then read them in this workspace.
Opening a workspace tab does not change the remembered sidebar/popup mode.
The layout supports light/dark themes and adapts to narrower windows.

Validation: 24 automated tests pass, including Markdown safety, click/keyboard
selection, Raw/Copy fidelity, selection clearing, caching, indexing and mode
switching regressions. JavaScript syntax checked. A live visual browser test
was attempted but Chromium launch was blocked by the environment's socket
restrictions. Visual layout and native extension integration need checking in
Chrome. Update the existing unpacked folder/extension ID to preserve data.

In 1.2.25, wide-screen headers share a 120px baseline: the 72px library
heading plus 48px action row align with the compact reader header. Reader
spacing is reduced; long titles still expand naturally. Layouts at 850px
and below retain their existing responsive spacing.
