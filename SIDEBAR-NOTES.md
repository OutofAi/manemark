# Sidebar presentation — 1.2.23

The new SVG button immediately left of Settings opens Manemark in Chrome's
native side panel and closes the toolbar popup after the panel opens. In the
panel, an alternate SVG button opens the toolbar popup and closes the panel.
Both presentations use popup.html, the same local library, settings and background
progress. The sidebar fills the available panel width and viewport height.
Chrome chooses which side of the browser contains its panel.

The chosen presentation is saved in Chrome local storage. In sidebar mode the
toolbar popup is removed and Chrome natively toggles the sidebar on toolbar clicks.
Closing the sidebar does not reset the mode. The explicit return-to-popup button
restores the toolbar popup. The preference is restored when the service worker
starts, including after restarting Chrome. Open settings, scroll position and other transient UI state
are not transferred between the two views.

## Publishing

Requires Chrome 141+ for sidePanel.close(). Adds the sidePanel permission.
Suggested permission justification:
“Manemark uses the sidePanel permission to let users open their saved webpage
library, search and capture controls alongside the current webpage. Users switch
between the toolbar popup and the sidebar using an explicit button.”
Add sidePanel to the privacy policy's permission list when publishing this build.
No new network hosts or data sharing are introduced.

## Validation

19 automated tests pass, including popup-to-sidebar invocation order,
sidebar-to-popup requests, correct window targeting and recoverable failures.
JavaScript syntax checks pass. SVGs are original local vector assets.
The native browser transition and visual layout still require a manual test in
Chrome, because no runnable Chrome installation is available in this environment.

Test both buttons in Chrome 141+, resize the sidebar, verify dark/light mode,
and check saved-page search and simultaneous indexing/download bars. Keep the
same unpacked extension directory/ID when updating to preserve existing data.
Chrome's existing activeTab restrictions still apply to webpage capture: opening
the panel does not grant permanent access to every tab. After changing tabs or
navigating, invoking the extension's toolbar action may be needed to grant access
before capturing the new page.

The new regression tests cover persisted toolbar configuration, restoration after
worker restart, switching back to popup, and retaining sidebar mode on failure.
