const form = document.getElementById('settingsForm');
const modeInput = document.getElementById('mode');
const endpointInput = document.getElementById('endpoint');
const modelInput = document.getElementById('model');
const apiKeyInput = document.getElementById('apiKey');
const statusElement = document.getElementById('settingsStatus');
const saveBtn = document.getElementById('saveBtn');

function showStatus(message, isError = false) {
  statusElement.textContent = message;
  statusElement.classList.toggle('error', isError);
}

function refreshMode() {
  const custom = modeInput.value === 'custom';
  document.getElementById('modelLabel').hidden = custom;
  document.getElementById('modelHint').hidden = custom;
  modelInput.hidden = custom;
  modelInput.required = !custom;
  document.getElementById('modeHint').textContent = custom
    ? 'POST { question, bookmarks: { export_date, total_manemarks, snapshots }, history }; response { answer: "..." }. Your server can do retrieval before calling the LLM.'
    : 'POST OpenAI-style { model, messages }; the complete Manemark JSON is included as reference context in the user message.';
  if (!endpointInput.value.trim()) {
    endpointInput.placeholder = custom ? 'https://your-server.example/api/chat' : 'https://api.openai.com/v1/chat/completions';
  }
}

modeInput.addEventListener('change', refreshMode);
document.getElementById('toggleKey').addEventListener('click', (event) => {
  apiKeyInput.type = apiKeyInput.type === 'password' ? 'text' : 'password';
  event.target.textContent = apiKeyInput.type === 'password' ? 'Show' : 'Hide';
});

chrome.storage.local.get('apiSettings').then(result => {
  const settings = result.apiSettings || {};
  modeInput.value = settings.mode === 'custom' ? 'custom' : 'openai';
  endpointInput.value = settings.endpoint || 'https://api.openai.com/v1/chat/completions';
  modelInput.value = settings.model || 'gpt-4o-mini';
  apiKeyInput.value = settings.apiKey || '';
  refreshMode();
}).catch(error => showStatus(error.message, true));

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (saveBtn.disabled) return;
  let url;
  try { url = new URL(endpointInput.value.trim()); }
  catch { showStatus('Enter a valid endpoint URL.', true); return; }
  const loopback = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    showStatus('Use HTTPS, or HTTP only for localhost.', true); return;
  }
  if (url.username || url.password || url.hash) {
    showStatus('Remove credentials and #fragments from the endpoint URL.', true); return;
  }
  if (modeInput.value === 'openai' && !modelInput.value.trim()) {
    showStatus('Enter the model name.', true); return;
  }

  // This request must happen as part of the user's Save click.
  saveBtn.disabled = true;
  showStatus('Requesting permission for the API host…');
  try {
    const approved = await chrome.permissions.request({ origins: [`${url.origin}/*`] });
    if (!approved) { showStatus('Permission denied; the extension cannot call this API host.', true); return; }
    await chrome.storage.local.set({
      apiSettings: {
        mode: modeInput.value,
        endpoint: url.href,
        model: modelInput.value.trim(),
        apiKey: apiKeyInput.value.trim()
      }
    });
    showStatus('Settings saved. Return to Manemark and ask a question.');
  } catch (error) {
    showStatus('Could not save: ' + error.message, true);
  } finally {
    saveBtn.disabled = false;
  }
});
