MANEMARK NATIVE STORAGE HELPER
==============================

Why this exists
---------------
Chrome's normal extension storage is controlled by Chrome, and the File System
Access folder picker is not reliably exposed to chrome-extension:// pages.
This small helper gives Manemark explicit access to one folder path selected by
you. It communicates with the extension using Chrome Native Messaging.

Windows
-------
1. Load/update Manemark in chrome://extensions.
2. Open Manemark > Storage settings and copy the Extension ID shown there.
3. Run install-windows.bat and paste the ID when prompted.
4. Return to Storage settings. "Local helper" should show Connected.
5. Click Choose folder.

macOS
-----
1. Load/update Manemark and copy the Extension ID from Storage settings.
2. Run install-macos.command and paste the ID.
3. Return to Storage settings and click Choose folder.

Linux (64-bit Intel/AMD)
------------------------
1. Load/update Manemark and copy the Extension ID from Storage settings.
2. Run: ./install-linux.sh
3. Paste the extension ID.
4. Return to Storage settings and click Choose folder.
   If neither zenity nor kdialog is installed, type an absolute path into the
   Storage settings page and click "Use typed path".

Data file
---------
The selected folder contains:
  manemark-data.json

Chrome storage is retained as a fallback cache so captures are not lost if an
external drive is disconnected or the helper is temporarily unavailable.

Security
--------
The installer registers the helper only for the exact extension ID you provide.
The helper accepts local file operations only through Chrome's Native Messaging
connection and writes only the Manemark JSON file in the folder path requested
by the extension.
