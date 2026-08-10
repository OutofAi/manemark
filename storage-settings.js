const chooseFolderBtn = document.getElementById('chooseFolderBtn');
const usePathBtn = document.getElementById('usePathBtn');
const reconnectBtn = document.getElementById('reconnectBtn');
const useChromeBtn = document.getElementById('useChromeBtn');
const modeText = document.getElementById('modeText');
const folderText = document.getElementById('folderText');
const fileText = document.getElementById('fileText');
const helperText = document.getElementById('helperText');
const folderPathInput = document.getElementById('folderPathInput');
const extensionId = document.getElementById('extensionId');
const message = document.getElementById('message');

extensionId.textContent = chrome.runtime.id;

function setMessage(text, type = 'ok') {
  message.textContent = text;
  message.className = type;
}

async function getCachedSnapshotsForSettings() {
  const result = await chromeStorageGet(['snapshots']);
  return result.snapshots || [];
}

async function getHelperStatus() {
  try {
    const response = await pingManemarkNativeHost();
    return { ok: true, platform: response.platform || 'connected' };
  } catch (error) {
    return { ok: false, error };
  }
}

async function refreshStorageStatus() {
  const settings = await getManemarkStorageSettings();
  const helper = await getHelperStatus();

  modeText.textContent = settings.mode === 'native' ? 'Custom folder' : 'Chrome local storage';
  folderText.textContent = settings.folderPath || '—';
  fileText.textContent = MANEMARK_DATA_FILE;
  helperText.textContent = helper.ok ? `Connected (${helper.platform})` : 'Not installed / not connected';
  helperText.className = helper.ok ? 'ok' : 'error';

  if (!folderPathInput.value && settings.folderPath) {
    folderPathInput.value = settings.folderPath;
  }

  chooseFolderBtn.disabled = !helper.ok;
  usePathBtn.disabled = !helper.ok;
  reconnectBtn.disabled = !helper.ok || settings.mode !== 'native' || !settings.folderPath;
}

async function useSelectedFolderPath(folderPath) {
  const cleanPath = String(folderPath || '').trim();
  if (!cleanPath) throw new Error('Enter or choose a folder first.');

  await pingManemarkNativeHost();

  const localSnapshots = await getCachedSnapshotsForSettings();
  let existing;
  try {
    existing = await readManemarkNativeFile(cleanPath);
  } catch (error) {
    // A new path may not exist yet. Writing creates it, so treat a missing path
    // as empty unless the helper reports another specific error.
    existing = { ok: true, exists: false, snapshots: [] };
  }

  if (existing.exists && existing.snapshots.length > 0) {
    let useFolderData = localSnapshots.length === 0;

    if (localSnapshots.length > 0) {
      useFolderData = confirm(
        `This folder already contains ${existing.snapshots.length} Manemark(s).\n\n` +
        `OK: use the data already in this folder\n` +
        `Cancel: replace the folder file with the ${localSnapshots.length} Manemark(s) currently in Chrome`
      );
    }

    if (useFolderData) {
      await chromeStorageSet({ snapshots: existing.snapshots });
      setMessage(`Using ${existing.snapshots.length} Manemark(s) from ${cleanPath}.`);
    } else {
      await writeManemarkNativeFile(cleanPath, localSnapshots);
      setMessage(`Storage changed to ${cleanPath}; current Manemarks were copied there.`);
    }
  } else {
    await writeManemarkNativeFile(cleanPath, localSnapshots);
    setMessage(`Storage changed to ${cleanPath}.`);
  }

  await setManemarkStorageSettings({ mode: 'native', folderPath: cleanPath });
  folderPathInput.value = cleanPath;
  await refreshStorageStatus();
}

chooseFolderBtn.addEventListener('click', async () => {
  setMessage('');
  try {
    const settings = await getManemarkStorageSettings();
    const response = await chooseManemarkNativeFolder(settings.folderPath || folderPathInput.value || '');
    if (response?.canceled) return;
    if (!response?.path) throw new Error('No folder was returned by the local helper.');
    await useSelectedFolderPath(response.path);
  } catch (error) {
    console.error(error);
    setMessage(error?.message || 'Could not select that folder.', 'error');
    await refreshStorageStatus();
  }
});

usePathBtn.addEventListener('click', async () => {
  setMessage('');
  try {
    await useSelectedFolderPath(folderPathInput.value);
  } catch (error) {
    console.error(error);
    setMessage(error?.message || 'Could not use that folder path.', 'error');
    await refreshStorageStatus();
  }
});

reconnectBtn.addEventListener('click', async () => {
  setMessage('');
  try {
    const settings = await getManemarkStorageSettings();
    if (!settings.folderPath) throw new Error('No custom folder is configured.');

    await pingManemarkNativeHost();
    const external = await readManemarkNativeFile(settings.folderPath);
    const localSnapshots = await getCachedSnapshotsForSettings();

    if (external.exists && external.snapshots.length > 0) {
      const useExternal = confirm(
        `The storage file contains ${external.snapshots.length} Manemark(s).\n\n` +
        `OK: load the folder copy into Chrome\n` +
        `Cancel: keep Chrome's ${localSnapshots.length} Manemark(s) and write them to the folder`
      );
      if (useExternal) {
        await chromeStorageSet({ snapshots: external.snapshots });
        setMessage(`Connected and loaded ${external.snapshots.length} Manemark(s) from the folder.`);
      } else {
        await writeManemarkNativeFile(settings.folderPath, localSnapshots);
        setMessage(`Connected and synced ${localSnapshots.length} Manemark(s) to the folder.`);
      }
    } else {
      await writeManemarkNativeFile(settings.folderPath, localSnapshots);
      setMessage(`Connected and synced ${localSnapshots.length} Manemark(s) to the folder.`);
    }

    await refreshStorageStatus();
  } catch (error) {
    console.error(error);
    setMessage(error?.message || 'Could not connect to the custom storage folder.', 'error');
    await refreshStorageStatus();
  }
});

useChromeBtn.addEventListener('click', async () => {
  setMessage('');
  try {
    const settings = await getManemarkStorageSettings();
    if (settings.mode === 'native' && settings.folderPath) {
      try {
        const external = await readManemarkNativeFile(settings.folderPath);
        if (external.ok && external.exists) {
          await chromeStorageSet({ snapshots: external.snapshots });
        }
      } catch (error) {
        console.warn('Could not import external data before switching to Chrome storage:', error);
      }
    }

    await setManemarkStorageSettings({ mode: 'chrome', folderPath: '' });
    setMessage('Manemark is now using Chrome local storage only.');
    folderPathInput.value = '';
    await refreshStorageStatus();
  } catch (error) {
    console.error(error);
    setMessage(error?.message || 'Could not change the storage mode.', 'error');
  }
});

refreshStorageStatus().catch((error) => {
  console.error(error);
  setMessage('Could not read the current storage settings.', 'error');
});
