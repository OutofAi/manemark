// Shared storage helper for Manemark.
// Chrome storage remains a working cache/fallback. When native storage is
// enabled, manemark-data.json in the user-selected folder is the durable copy.

const MANEMARK_DATA_FILE = 'manemark-data.json';
const MANEMARK_STORAGE_SETTINGS_KEY = 'storageSettings';
const MANEMARK_NATIVE_HOST = 'com.manemark.storage';

function chromeStorageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result);
    });
  });
}

function chromeStorageSet(values) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

async function getManemarkStorageSettings() {
  const result = await chromeStorageGet([MANEMARK_STORAGE_SETTINGS_KEY]);
  const saved = result[MANEMARK_STORAGE_SETTINGS_KEY] || {};
  const mode = saved.mode === 'native' ? 'native' : 'chrome';
  return {
    mode,
    folderPath: saved.folderPath || '',
    fileName: MANEMARK_DATA_FILE
  };
}

async function setManemarkStorageSettings(settings) {
  await chromeStorageSet({
    [MANEMARK_STORAGE_SETTINGS_KEY]: {
      mode: settings.mode === 'native' ? 'native' : 'chrome',
      folderPath: settings.folderPath || '',
      fileName: MANEMARK_DATA_FILE
    }
  });
}

function nativePortError(prefix = 'Native storage helper') {
  const detail = chrome.runtime.lastError?.message;
  return new Error(detail ? `${prefix}: ${detail}` : `${prefix} is not connected.`);
}

function nativeSingleRequest(message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let port;

    try {
      port = chrome.runtime.connectNative(MANEMARK_NATIVE_HOST);
    } catch (error) {
      reject(error);
      return;
    }

    port.onMessage.addListener((response) => {
      if (settled) return;
      settled = true;
      if (response?.ok === false) {
        reject(new Error(response.error || 'Native storage helper reported an error.'));
      } else {
        resolve(response || { ok: true });
      }
      try { port.disconnect(); } catch (_) {}
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      reject(nativePortError());
    });

    try {
      port.postMessage(message);
    } catch (error) {
      settled = true;
      try { port.disconnect(); } catch (_) {}
      reject(error);
    }
  });
}

async function pingManemarkNativeHost() {
  const response = await nativeSingleRequest({ action: 'ping' });
  return response;
}

async function chooseManemarkNativeFolder(initialPath = '') {
  return nativeSingleRequest({ action: 'chooseFolder', initialPath });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function readManemarkNativeFile(folderPath) {
  return new Promise((resolve, reject) => {
    let port;
    let settled = false;
    let exists = false;
    let expectedChunks = null;
    const chunks = [];

    try {
      port = chrome.runtime.connectNative(MANEMARK_NATIVE_HOST);
    } catch (error) {
      reject(error);
      return;
    }

    const finishError = (error) => {
      if (settled) return;
      settled = true;
      try { port.disconnect(); } catch (_) {}
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    port.onMessage.addListener((message) => {
      if (settled) return;
      if (message?.ok === false) {
        finishError(new Error(message.error || 'Could not read external Manemark data.'));
        return;
      }

      if (message?.type === 'readStart') {
        exists = !!message.exists;
        expectedChunks = Number(message.chunks || 0);
        return;
      }

      if (message?.type === 'readChunk') {
        chunks[Number(message.index || 0)] = message.data || '';
        return;
      }

      if (message?.type === 'readEnd') {
        try {
          if (!exists) {
            settled = true;
            try { port.disconnect(); } catch (_) {}
            resolve({ ok: true, exists: false, snapshots: [] });
            return;
          }

          if (expectedChunks !== null && chunks.filter((v) => typeof v === 'string').length !== expectedChunks) {
            throw new Error('External data transfer was incomplete.');
          }

          const byteArrays = chunks.map(base64ToBytes);
          const total = byteArrays.reduce((sum, bytes) => sum + bytes.length, 0);
          const all = new Uint8Array(total);
          let offset = 0;
          for (const bytes of byteArrays) {
            all.set(bytes, offset);
            offset += bytes.length;
          }

          const text = new TextDecoder().decode(all);
          const parsed = text.trim() ? JSON.parse(text) : { snapshots: [] };
          const snapshots = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed.snapshots) ? parsed.snapshots : null);

          if (!snapshots) throw new Error('The external Manemark data file has an invalid format.');

          settled = true;
          try { port.disconnect(); } catch (_) {}
          resolve({ ok: true, exists: true, snapshots });
        } catch (error) {
          finishError(error);
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      finishError(nativePortError());
    });

    try {
      port.postMessage({ action: 'read', folderPath });
    } catch (error) {
      finishError(error);
    }
  });
}

async function writeManemarkNativeFile(folderPath, snapshots) {
  const payload = {
    format: 'manemark-storage',
    version: 2,
    updatedAt: new Date().toISOString(),
    snapshots: Array.isArray(snapshots) ? snapshots : []
  };

  const response = await nativeSingleRequest({
    action: 'write',
    folderPath,
    fileName: MANEMARK_DATA_FILE,
    content: JSON.stringify(payload, null, 2)
  });

  return { ok: true, ...response };
}

async function readSnapshotsFromConfiguredFolder() {
  const settings = await getManemarkStorageSettings();
  if (settings.mode !== 'native') {
    return { ok: false, reason: 'chrome-mode' };
  }
  if (!settings.folderPath) {
    return { ok: false, reason: 'missing-path' };
  }

  try {
    const result = await readManemarkNativeFile(settings.folderPath);
    if (result.ok && result.exists === false) {
      return { ok: false, reason: 'missing-file', settings };
    }
    return { ...result, settings };
  } catch (error) {
    console.error('Failed to read Manemark native storage file:', error);
    return { ok: false, reason: 'native-unavailable', error, settings };
  }
}

async function writeSnapshotsToConfiguredFolder(snapshots) {
  const settings = await getManemarkStorageSettings();
  if (settings.mode !== 'native') {
    return { ok: false, reason: 'chrome-mode' };
  }
  if (!settings.folderPath) {
    return { ok: false, reason: 'missing-path' };
  }

  try {
    const result = await writeManemarkNativeFile(settings.folderPath, snapshots);
    return {
      ok: true,
      folderPath: settings.folderPath,
      fileName: MANEMARK_DATA_FILE,
      ...result
    };
  } catch (error) {
    console.error('Failed to write Manemark native storage file:', error);
    return { ok: false, reason: 'native-unavailable', error };
  }
}
