/* eslint-disable no-undef */
/**
 * Onboarding wizard controller.
 *
 * Drives the flow rendered in onboarding.html and persists everything
 * via the electronAPI bridge exposed by preload.js. computeScreenOrder()
 * decides which screens the current path shows:
 *
 *   1. Welcome
 *   2. AI provider choice, key / model / Ollama URL + Test connection
 *   3. Speech provider choice (Whisper / Azure / Skip)
 *   4. Whisper detect + (optional) install (Whisper only)
 *   5. Whisper model download (Whisper only)
 *   6. Summary
 *
 * The Whisper path has 6 steps; the others have 4.
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // Quote the executable portion of a command string if it contains spaces.
  // This keeps Windows user profile paths (e.g. C:\Users\CANDAN SINGH\...) intact.
  function quoteCommandIfNeeded(cmd) {
    if (!cmd) return cmd;
    const firstSpace = cmd.indexOf(' ');
    if (firstSpace === -1) return cmd;
    const exe = cmd.slice(0, firstSpace);
    const rest = cmd.slice(firstSpace + 1);
    if (exe.startsWith('"') || rest.startsWith('"')) return cmd;
    return `"${exe}" ${rest}`;
  }

  const screens = $$('.screen');
  const stepper = $('#stepper');
  const stepBadge = $('#stepBadge');
  const backBtn = $('#backBtn');
  const nextBtn = $('#nextBtn');
  const skipBtn = $('#skipBtn');
  const nav = $('#wizard .nav'); // the centered nav container

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    step: 0,
    provider: 'gemini',
    apiKey: '',
    model: '',
    baseUrl: 'http://localhost:11434', // Ollama only
    savedProvider: null, // provider whose key is already in .env, from a prior run
    savedProviderConfigured: false,
    geminiConfigured: false,
    testing: false,
    testedSignature: null, // inputs of the last successful test
    speechProvider: null, // 'whisper' | 'azure' | 'skip'
    azureKey: '',
    azureRegion: '',
    whisperCmd: null,
    whisperDetected: false,
    skippingWhisper: false,
    modelDownloadChoice: null, // 'now' | 'later'
    modelDownloading: false,
    modelDownloaded: false,
    modelDownloadFailed: false,
    finished: false,
  };

  // ── Step rendering ────────────────────────────────────────────────
  // The "Step n of total" label and the progress bars both follow
  // computeScreenOrder(), the sequence navigation walks, so they always
  // match the screens on the current path. Welcome counts as step 1.
  function refreshStepper() {
    const order = computeScreenOrder();
    const total = order.length;
    const index = Math.max(0, order.indexOf(currentScreenName()));
    stepBadge.textContent = `Step ${index + 1} of ${total}`;

    // One bar per screen on the path.
    while (stepper.children.length < total) {
      const dot = document.createElement('div');
      dot.className = 'step-dot';
      stepper.appendChild(dot);
    }
    while (stepper.children.length > total) {
      stepper.lastElementChild.remove();
    }
    Array.from(stepper.children).forEach((dot, i) => {
      dot.classList.toggle('done', i < index);
      dot.classList.toggle('active', i === index);
    });
  }

  function showScreen(name) {
    screens.forEach((s) => {
      s.classList.toggle('active', s.dataset.screen === name);
    });
    // Welcome screen uses an inline hero CTA — hide the regular nav row.
    const wizardEl = document.getElementById('wizard');
    if (wizardEl) {
      wizardEl.classList.toggle('welcome-active', name === 'welcome');
    }
    refreshStepper();
    backBtn.style.visibility = state.step === 0 ? 'hidden' : 'visible';
    // Reset next button state unless we're actively downloading a model
    if (name !== 'model-download' || !state.modelDownloading) {
      nextBtn.disabled = false;
      nextBtn.classList.remove('oc-btn--success');
      nextBtn.classList.add('oc-btn--primary');
    }
    // The primary action label changes by step
    if (name === 'welcome') nextBtn.innerHTML = 'Get started <i class="fas fa-arrow-right"></i>';
    else if (name === 'finish') nextBtn.innerHTML = 'Finish <i class="fas fa-check"></i>';
    else if (name === 'model-download') refreshModelDownloadButton();
    else nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
    // Continue on the AI step waits for a passing test of the current inputs.
    if (name === 'provider') nextBtn.disabled = !providerTestPassed();
  }

  function navigate(direction) {
    const order = computeScreenOrder();
    const idx = order.indexOf(currentScreenName());
    const next = direction === 'next' ? idx + 1 : idx - 1;
    if (next < 0 || next >= order.length) return;
    state.step = orderScreenToStep(order[next]);
    showScreen(order[next]);
  }

  function currentScreenName() {
    const active = Array.from(screens).find((s) => s.classList.contains('active'));
    return active ? active.dataset.screen : 'welcome';
  }

  // Order depends on choices — e.g. whisper path inserts the install screen.
  function computeScreenOrder() {
    const out = ['welcome', 'provider', 'speech'];
    if (state.speechProvider === 'whisper') out.push('whisper');
    if (state.speechProvider === 'whisper') out.push('model-download');
    out.push('finish');
    return out;
  }

  // Map a screen name to its position in the stepper (0..n).
  function orderScreenToStep(name) {
    return computeScreenOrder().indexOf(name);
  }

  // ── Validation gates before "Continue" ───────────────────────────
  function canAdvance() {
    const name = currentScreenName();
    switch (name) {
      case 'welcome':
        return true;
      case 'provider':
        return providerTestPassed();
      case 'speech':
        if (state.speechProvider === 'azure') {
          return !!state.azureKey.trim() && !!state.azureRegion.trim();
        }
        return !!state.speechProvider;
      case 'whisper':
        // Allow advancing whether whisper is detected OR user skipped
        return state.whisperDetected || state.skippingWhisper;
      case 'model-download':
        return !!state.modelDownloadChoice && !state.modelDownloading;
      case 'finish':
        return true;
      default:
        return true;
    }
  }

  // ── Wire up: AI provider ──────────────────────────────────────────
  // Mirrors src/services/providers/index.js (labels, default models) and the
  // save-settings field names in main.js.
  const PROVIDERS = {
    gemini: {
      label: 'Google Gemini', company: 'Google', keyField: 'geminiKey', modelField: 'geminiModel',
      defaultModel: 'gemini-3.1-flash-lite', keyPlaceholder: 'AIza…',
      keyUrl: 'https://aistudio.google.com/apikey', keyUrlText: 'aistudio.google.com/apikey',
    },
    anthropic: {
      label: 'Anthropic Claude', company: 'Anthropic', keyField: 'anthropicKey', modelField: 'anthropicModel',
      defaultModel: 'claude-sonnet-5-5', keyPlaceholder: 'sk-ant-…',
      keyUrl: 'https://console.anthropic.com/settings/keys', keyUrlText: 'console.anthropic.com',
    },
    openai: {
      label: 'OpenAI', company: 'OpenAI', keyField: 'openaiKey', modelField: 'openaiModel',
      defaultModel: 'gpt-5-mini', keyPlaceholder: 'sk-…',
      keyUrl: 'https://platform.openai.com/api-keys', keyUrlText: 'platform.openai.com/api-keys',
    },
    openrouter: {
      label: 'OpenRouter', company: 'OpenRouter', keyField: 'openrouterKey', modelField: 'openrouterModel',
      defaultModel: 'openrouter/auto', keyPlaceholder: 'sk-or-…',
      keyUrl: 'https://openrouter.ai/keys', keyUrlText: 'openrouter.ai/keys',
    },
    groq: {
      label: 'Groq', company: 'Groq', keyField: 'groqKey', modelField: 'groqModel',
      defaultModel: 'llama-3.3-70b-versatile', keyPlaceholder: 'gsk_…',
      keyUrl: 'https://console.groq.com/keys', keyUrlText: 'console.groq.com/keys',
    },
    deepseek: {
      label: 'DeepSeek', company: 'DeepSeek', keyField: 'deepseekKey', modelField: 'deepseekModel',
      defaultModel: 'deepseek-chat', keyPlaceholder: 'sk-…',
      keyUrl: 'https://platform.deepseek.com/api_keys', keyUrlText: 'platform.deepseek.com',
    },
    ollama: {
      label: 'Ollama', company: null, keyField: null, modelField: 'ollamaModel',
      defaultModel: 'llama3.2-vision', noKey: true,
    },
  };
  const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

  const providerInputs = $$('#providerChoices input[name="provider"]');
  const keyField = $('#keyField');
  const keyInput = $('#providerKey');
  const keyLabel = $('#providerKeyLabel');
  const keyLink = $('#keyLink');
  const keyProviderName = $('#keyProviderName');
  const baseUrlField = $('#baseUrlField');
  const baseUrlInput = $('#providerBaseUrl');
  const modelInput = $('#providerModel');
  const testBtn = $('#testBtn');
  const testResult = $('#testResult');
  const toggleVis = $('#toggleVis');
  const TEST_BTN_HTML = testBtn.innerHTML;

  // Ollama's OpenAI-compatible API lives under /v1. Accept the bare server
  // address people copy from Ollama's docs and add the path.
  function normalizeOllamaUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    return /^https?:\/\/[^/?#]+\/?$/i.test(value) ? `${value.replace(/\/$/, '')}/v1` : value;
  }

  // What Test connection and Continue send for the current inputs.
  function providerRequest() {
    const p = PROVIDERS[state.provider];
    const req = { provider: state.provider, model: state.model };
    if (p.noKey) req.baseUrl = normalizeOllamaUrl(state.baseUrl || OLLAMA_DEFAULT_URL);
    else req.apiKey = state.apiKey;
    return req;
  }

  function providerSignature() {
    return JSON.stringify(providerRequest());
  }

  function providerTestPassed() {
    return !state.testing && state.testedSignature !== null && state.testedSignature === providerSignature();
  }

  function setTestResult(kind, text) {
    testResult.className = `test-result ${kind}`;
    testResult.textContent = '';
    if (!text) return;
    const icon = document.createElement('i');
    icon.setAttribute('aria-hidden', 'true');
    icon.className = {
      testing: 'fas fa-circle-notch fa-spin',
      success: 'fas fa-check-circle',
      error: 'fas fa-circle-xmark',
    }[kind] || 'fas fa-circle-info';
    const span = document.createElement('span');
    span.textContent = text;
    testResult.append(icon, span);
  }

  // Any change to the inputs voids an earlier passing test.
  function onProviderInputChanged() {
    if (state.testedSignature !== null && state.testedSignature !== providerSignature()) {
      state.testedSignature = null;
      setTestResult('idle', '');
    }
    if (currentScreenName() === 'provider') nextBtn.disabled = !providerTestPassed();
  }

  function keyAlreadySaved(id) {
    if (id === 'gemini' && state.geminiConfigured) return true;
    return state.savedProviderConfigured && state.savedProvider === id;
  }

  function renderProviderFields() {
    const id = state.provider;
    const p = PROVIDERS[id];
    providerInputs.forEach((input) => { input.checked = input.value === id; });

    keyField.hidden = !!p.noKey;
    baseUrlField.hidden = !p.noKey;
    if (!p.noKey) {
      keyLabel.textContent = `${p.label} API key`;
      keyInput.placeholder = keyAlreadySaved(id) ? '•••••••••••••••• (already saved)' : p.keyPlaceholder;
      keyLink.href = p.keyUrl;
      keyLink.textContent = p.keyUrlText;
      keyProviderName.textContent = p.company;
    }
    // Keys and models are per provider: clear them when switching.
    keyInput.value = state.apiKey;
    modelInput.value = state.model;
    modelInput.placeholder = p.defaultModel;
    baseUrlInput.value = state.baseUrl;
    baseUrlInput.placeholder = OLLAMA_DEFAULT_URL;
  }

  providerInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked || input.value === state.provider) return;
      state.provider = input.value;
      state.apiKey = '';
      state.model = '';
      state.testedSignature = null;
      setTestResult('idle', '');
      renderProviderFields();
      onProviderInputChanged();
    });
  });

  keyInput.addEventListener('input', () => {
    state.apiKey = keyInput.value.trim();
    onProviderInputChanged();
  });
  modelInput.addEventListener('input', () => {
    state.model = modelInput.value.trim();
    onProviderInputChanged();
  });
  baseUrlInput.addEventListener('input', () => {
    state.baseUrl = baseUrlInput.value.trim();
    onProviderInputChanged();
  });
  // Enter in any field runs the test.
  [keyInput, modelInput, baseUrlInput].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        runProviderTest();
      }
    });
  });

  async function runProviderTest() {
    if (state.testing) return;
    const p = PROVIDERS[state.provider];
    if (!p.noKey && !state.apiKey && !keyAlreadySaved(state.provider)) {
      setTestResult('error', `Enter your ${p.label} API key first.`);
      keyInput.focus();
      return;
    }
    const signature = providerSignature();
    state.testing = true;
    state.testedSignature = null;
    testBtn.disabled = true;
    testBtn.innerHTML = '<span class="spinner"></span> Testing…';
    nextBtn.disabled = true;
    setTestResult('testing', `Contacting ${p.label}…`);
    let result;
    try {
      result = await window.electronAPI.testProvider(providerRequest());
    } catch (e) {
      result = { ok: false, message: (e && e.message) || 'Connection test failed.' };
    }
    state.testing = false;
    testBtn.disabled = false;
    testBtn.innerHTML = TEST_BTN_HTML;
    // The inputs changed while the test ran: that result is for old values.
    if (signature !== providerSignature()) {
      setTestResult('idle', '');
      onProviderInputChanged();
      return;
    }
    if (result && result.ok) {
      state.testedSignature = signature;
      setTestResult('success', result.message || 'Connected.');
    } else {
      setTestResult('error', (result && result.message) || 'Connection test failed.');
    }
    if (currentScreenName() === 'provider') nextBtn.disabled = !providerTestPassed();
  }

  testBtn.addEventListener('click', runProviderTest);

  toggleVis.addEventListener('click', () => {
    const showing = keyInput.type === 'text';
    keyInput.type = showing ? 'password' : 'text';
    toggleVis.innerHTML = showing
      ? '<i class="fas fa-eye" aria-hidden="true"></i>'
      : '<i class="fas fa-eye-slash" aria-hidden="true"></i>';
  });

  // Save exactly what passed the test. Empty key or model keeps the saved one.
  async function saveProvider() {
    const p = PROVIDERS[state.provider];
    const req = providerRequest();
    const payload = { llmProvider: state.provider };
    if (p.keyField && req.apiKey) payload[p.keyField] = req.apiKey;
    if (req.model) payload[p.modelField] = req.model;
    if (p.noKey) payload.ollamaBaseUrl = req.baseUrl;
    try {
      const r = await window.electronAPI.saveSettings(payload);
      if (r && r.success === false) {
        setTestResult('error', r.error || 'Could not save these settings.');
        return false;
      }
      return true;
    } catch (e) {
      setTestResult('error', (e && e.message) || 'Could not save these settings.');
      return false;
    }
  }

  // ── Wire up: Speech choices ───────────────────────────────────────
  $$('#speechChoices input[name="speech"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      const value = input.value;
      state.speechProvider = value;
      const azurePanel = $('#azurePanel');
      azurePanel.style.display = value === 'azure' ? 'block' : 'none';
      if (value !== 'azure') {
        state.azureKey = '';
        state.azureRegion = '';
      }
      // The choice sets the path length (Whisper adds two screens).
      refreshStepper();
    });
  });

  $('#azureKey').addEventListener('input', (e) => { state.azureKey = e.target.value.trim(); });
  $('#azureRegion').addEventListener('input', (e) => { state.azureRegion = e.target.value.trim(); });

  // ── Wire up: Whisper screen ───────────────────────────────────────
  const installLog = $('#installLog');
  const detectCmd = $('#detectCmd');
  const detectStatus = $('#detectStatus');
  const installList = $('#installList');
  const installCardTitle = $('#installCardTitle');

  function appendLog(line) {
    installLog.textContent += (installLog.textContent ? '\n' : '') + line;
    installLog.scrollTop = installLog.scrollHeight;
  }

  function setDetectStatus(state_, text) {
    detectStatus.className = `oc-chip status-pill ${state_}`;
    const icon = detectStatus.querySelector('i');
    if (state_ === 'success') icon.className = 'fas fa-check-circle';
    else if (state_ === 'error') icon.className = 'fas fa-circle-xmark';
    else if (state_ === 'idle') icon.className = 'fas fa-circle-info';
    else icon.className = 'fas fa-circle-notch fa-spin';
    detectStatus.querySelector('.text').textContent = text;
  }

  async function runWhisperDetect() {
    detectCmd.textContent = 'scanning…';
    setDetectStatus('testing', 'Probing');
    try {
      const r = await window.electronAPI.detectWhisper();
      if (r.found) {
        state.whisperDetected = true;
        state.whisperCmd = r.command;
        detectCmd.textContent = r.command;
        setDetectStatus('success', `Found v${r.version || '?'}`);
        appendLog(`✓ Detected Whisper CLI: ${r.command}`);
      } else {
        detectCmd.textContent = 'not found';
        setDetectStatus('error', 'Not installed');
        appendLog('✗ No Whisper CLI detected on PATH or in known venvs');
      }
    } catch (e) {
      setDetectStatus('error', 'Probe failed');
      appendLog(`! Detection error: ${e.message || e}`);
    }
  }

  async function runWhisperInstall() {
    const btn = document.getElementById('installWhisperBtn');
    installLog.textContent = '';
    setDetectStatus('testing', 'Installing');
    appendLog('Starting install…');

    // Lock the button while installing so the user can't double-click
    // and spawn parallel installs. Change the label to "Installing…"
    // with a spinner so they see real progress.
    if (btn) {
      btn.disabled = true;
      btn.dataset.originalHtml = btn.dataset.originalHtml || btn.innerHTML;
      btn.innerHTML = '<span class="spinner"></span> Installing…';
    }

    // Subscribe to streamed progress lines from the main process.
    // `installWhisper()` only returns once install completes; live
    // output comes through `onInstallProgress` events.
    let stopProgress = null;
    if (window.electronAPI && window.electronAPI.onInstallProgress) {
      stopProgress = window.electronAPI.onInstallProgress((line) => appendLog(line));
    }

    try {
      const r = await window.electronAPI.installWhisper();
      if (r.ok) {
        state.whisperDetected = true;
        state.whisperCmd = r.command;
        detectCmd.textContent = r.command;
        setDetectStatus('success', 'Installed');
        appendLog(`\n✓ ${r.message}`);
        if (btn) {
          // Keep button disabled — install is done. Show a checkmark
          // so the user sees the final state at a glance.
          btn.innerHTML = '<i class="fas fa-check-circle"></i> Installed';
          btn.classList.remove('oc-btn--primary');
          btn.classList.add('oc-btn--success');
        }
      } else {
        setDetectStatus('error', 'Install failed');
        appendLog(`\n✗ ${r.message}`);
        // Restore the button so the user can retry.
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = btn.dataset.originalHtml || '<i class="fas fa-download"></i> Install Whisper now';
        }
      }
    } catch (e) {
      setDetectStatus('error', 'Install error');
      appendLog(`\n! ${e.message || e}`);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = btn.dataset.originalHtml || '<i class="fas fa-download"></i> Install Whisper now';
      }
    } finally {
      if (typeof stopProgress === 'function') {
        try { stopProgress(); } catch (_) { /* ignore */ }
      }
    }
  }

  // Whisper screen logic
  let whisperInitialized = false;
  function enterWhisperScreen() {
    if (whisperInitialized) return;
    whisperInitialized = true;
    // The venv goes in Cuewell's app data folder (Electron userData), where
    // main.js points the Whisper installer; never in the app's own folder.
    const hints = {
      win32: {
        title: 'Cuewell installs Whisper in its own Python environment',
        steps: [
          'Needs Python 3.10 or newer (3.12 recommended), from python.org or <code>winget install Python.Python.3.12</code>.',
          'Creates a <code>.venv-whisper</code> folder in the Cuewell app data folder (under <code>%APPDATA%</code>).',
          'Installs Whisper there with pip. No admin rights needed. Uses about 3 to 5 GB of disk.',
          'Then downloads the <code>small</code> model (about 461 MB), now or on first use.',
        ],
      },
      darwin: {
        title: 'Cuewell installs Whisper in its own Python environment',
        steps: [
          'Needs Python 3.10 or newer (3.12 recommended), from python.org or <code>brew install python@3.12</code>.',
          'Creates a <code>.venv-whisper</code> folder in the Cuewell app data folder (under <code>~/Library/Application Support</code>).',
          'Installs Whisper there with pip. No <code>sudo</code> needed. Uses about 3 to 5 GB of disk.',
          'Then downloads the <code>small</code> model (about 461 MB), now or on first use.',
        ],
      },
      other: {
        title: 'Cuewell installs Whisper in its own Python environment',
        steps: [
          'Needs Python 3.10 or newer with venv. On Debian and Ubuntu: <code>sudo apt install python3-venv</code>.',
          'Creates a <code>.venv-whisper</code> folder in the Cuewell app data folder (under <code>~/.config</code>).',
          'Installs Whisper there with pip. No <code>sudo</code> needed. Uses about 3 to 5 GB of disk.',
          'Recording needs <code>arecord</code> (alsa-utils) or <code>sox</code>.',
          'Then downloads the <code>small</code> model (about 461 MB), now or on first use.',
        ],
      },
    };
    // html[data-platform] comes from preload.js; navigator is the fallback.
    const platformName = document.documentElement.dataset.platform ||
      (navigator.platform.toLowerCase().includes('win') ? 'win32'
        : navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'linux');
    const plat = platformName === 'win32' || platformName === 'darwin' ? platformName : 'other';
    const h = hints[plat];
    installCardTitle.textContent = h.title;
    installList.innerHTML = h.steps.map((s) => `<li>${s}</li>`).join('');
    runWhisperDetect();
  }

  // ── Wire up: Model Download screen ───────────────────────────────
  const modelDownloadLog = $('#modelDownloadLog');
  const modelDownloadChoices = $('#modelDownloadChoices');

  function appendModelLog(line) {
    modelDownloadLog.textContent += (modelDownloadLog.textContent ? '\n' : '') + line;
    modelDownloadLog.scrollTop = modelDownloadLog.scrollHeight;
  }

  // Selecting a card only records the choice; arrow keys move the radio
  // selection, so a download must not start on selection. With "now"
  // chosen, Continue starts the download, then moves on once it is done.
  function refreshModelDownloadButton() {
    if (state.modelDownloading) {
      nextBtn.disabled = true;
      nextBtn.innerHTML = '<span class="spinner"></span> Downloading…';
      return;
    }
    nextBtn.classList.remove('oc-btn--success');
    nextBtn.classList.add('oc-btn--primary');
    if (state.modelDownloaded) {
      nextBtn.classList.remove('oc-btn--primary');
      nextBtn.classList.add('oc-btn--success');
      nextBtn.innerHTML = '<i class="fas fa-check-circle"></i> Continue';
    } else if (state.modelDownloadChoice === 'now' && !state.modelDownloadFailed) {
      nextBtn.innerHTML = '<i class="fas fa-download"></i> Download';
    } else {
      nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
    }
    nextBtn.disabled = !state.modelDownloadChoice;
  }

  $$('#modelDownloadChoices input[name="modelDownload"]').forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked || state.modelDownloading) return;
      state.modelDownloadChoice = input.value;
      refreshModelDownloadButton();
    });
  });

  function enterModelDownloadScreen() {
    $$('#modelDownloadChoices input[name="modelDownload"]').forEach((input) => {
      input.checked = input.value === state.modelDownloadChoice;
    });
    refreshModelDownloadButton();
  }

  async function startModelDownload() {
    state.modelDownloading = true;
    state.modelDownloadFailed = false;
    nextBtn.disabled = true;
    nextBtn.innerHTML = '<span class="spinner"></span> Downloading…';
    $$('#modelDownloadChoices input').forEach((input) => { input.disabled = true; });

    appendModelLog('Starting model download…');

    let stopProgress = null;
    if (window.electronAPI && window.electronAPI.onInstallProgress) {
      stopProgress = window.electronAPI.onInstallProgress((line) => appendModelLog(line));
    }

    try {
      const r = await window.electronAPI.downloadWhisperModel('small');
      if (r.ok) {
        state.modelDownloaded = true;
        appendModelLog(`\n✓ Model downloaded successfully: ${r.path}`);
      } else {
        // Let the user continue anyway; the model downloads on first use.
        state.modelDownloadFailed = true;
        appendModelLog(`\n✗ Download failed: ${r.message}`);
      }
    } catch (e) {
      state.modelDownloadFailed = true;
      appendModelLog(`\n! Error: ${e.message || e}`);
    } finally {
      state.modelDownloading = false;
      $$('#modelDownloadChoices input').forEach((input) => { input.disabled = false; });
      if (typeof stopProgress === 'function') {
        try { stopProgress(); } catch (_) { /* ignore */ }
      }
      if (currentScreenName() === 'model-download') refreshModelDownloadButton();
    }
  }

  // ── Wire up: Finish screen ────────────────────────────────────────
  function populateSummary() {
    const rows = [];
    const p = PROVIDERS[state.provider];
    const model = state.model || p.defaultModel;
    rows.push({
      icon: 'fa-wand-magic-sparkles',
      label: 'AI provider',
      value: state.testedSignature !== null ? `${p.label} · ${model}` : `${p.label} (not tested)`,
      cls: state.testedSignature !== null ? 'ok' : 'skip',
    });
    if (state.speechProvider === 'whisper') {
      rows.push({
        icon: 'fa-microphone',
        label: 'Speech',
        value: state.whisperDetected ? `Whisper (${state.whisperCmd || 'cli'})` : 'Whisper (not installed)',
        cls: state.whisperDetected ? 'ok' : 'skip',
      });
    } else if (state.speechProvider === 'azure') {
      rows.push({ icon: 'fa-cloud', label: 'Speech', value: 'Azure', cls: 'ok' });
    } else {
      rows.push({ icon: 'fa-microphone', label: 'Speech', value: 'Skipped (configure later)', cls: 'skip' });
    }
    rows.push({ icon: 'fa-file-lines', label: 'Config saved to', value: '.env', cls: 'ok' });
    // Linux cannot hide windows from screen capture; say so before the
    // first interview rather than let the user assume privacy mode works.
    if (document.documentElement.dataset.platform === 'linux') {
      rows.push({ icon: 'fa-eye', label: 'Screen-capture protection', value: 'Not available on Linux', cls: 'skip' });
    }

    const list = $('#summaryList');
    list.textContent = '';
    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'summary-row';
      const label = document.createElement('div');
      label.className = 'label';
      const icon = document.createElement('i');
      icon.className = `fas ${r.icon}`;
      icon.setAttribute('aria-hidden', 'true');
      label.append(icon, document.createTextNode(` ${r.label}`));
      const value = document.createElement('div');
      value.className = `value ${r.cls}`;
      value.textContent = r.value;
      value.title = r.value;
      row.append(label, value);
      list.appendChild(row);
    });
  }

  // ── Wire up: Hero CTA (welcome screen) ────────────────────────────
  // The big inline "Get Started" button on the welcome screen reuses
  // the existing nav-button handler so all validation, persistence,
  // and navigation logic stays in one place.
  const heroCtaBtn = $('#heroCtaBtn');
  if (heroCtaBtn) {
    heroCtaBtn.addEventListener('click', () => nextBtn.click());
  }

  // ── Wire up: nav buttons ──────────────────────────────────────────
  nextBtn.addEventListener('click', async () => {
    const name = currentScreenName();
    if (!canAdvance()) {
      // Lightly nudge the user
      if (name === 'provider' && !state.testing) setTestResult('error', 'Test the connection before continuing.');
      return;
    }

    // Save the tested provider so the app uses it right away.
    if (name === 'provider') {
      nextBtn.disabled = true;
      const saved = await saveProvider();
      nextBtn.disabled = false;
      if (!saved) return;
    }
    // "Skip for now" saves nothing: no speech provider is chosen.
    if (name === 'speech' && state.speechProvider !== 'skip' && window.electronAPI) {
      try {
        const payload = { speechProvider: state.speechProvider };
        if (state.speechProvider === 'azure') {
          payload.azureKey = state.azureKey;
          payload.azureRegion = state.azureRegion;
        }
        if (state.speechProvider === 'whisper' && state.whisperCmd) {
          payload.whisperCommand = quoteCommandIfNeeded(state.whisperCmd);
        }
        const r = await window.electronAPI.saveSettings(payload);
        // Main rejected a value the user typed: show it on that field and stay.
        const rejected = r && r.success === false && Array.isArray(r.errors)
          ? r.errors.find((e) => e.field === 'azureKey' || e.field === 'azureRegion')
          : null;
        if (rejected) {
          const input = document.getElementById(rejected.field);
          if (input && typeof input.setCustomValidity === 'function') {
            input.setCustomValidity(rejected.error);
            input.reportValidity();
            input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
          }
          return;
        }
      } catch (_) { /* surfaced elsewhere */ }
    }

    // Whisper screen: kick off detection on entry
    if (name === 'speech' && state.speechProvider === 'whisper') {
      // (deferred: will run via enterWhisperScreen)
    }

    // Whisper screen "Continue" — if user wants to skip install, mark and proceed
    if (name === 'whisper') {
      // Persist whatever whisper command we found (could be empty if skipped)
      if (window.electronAPI && state.whisperCmd) {
        try {
          const r = await window.electronAPI.saveSettings({ whisperCommand: quoteCommandIfNeeded(state.whisperCmd) });
          if (r && r.success === false) {
            setDetectStatus('error', 'Not saved');
            appendLog(`\n✗ ${r.error || 'Could not save the Whisper command'}`);
            return;
          }
        } catch (_) { /* ignore */ }
      }
    }

    // Model download screen: "Download now" downloads first, then continues.
    if (name === 'model-download' && state.modelDownloadChoice === 'now' &&
        !state.modelDownloaded && !state.modelDownloadFailed) {
      await startModelDownload();
      // Failed: the log says why and Continue now moves on. Also stay put if
      // the user went Back while it downloaded.
      if (!state.modelDownloaded || currentScreenName() !== 'model-download') return;
    }
    if (name === 'model-download') {
      if (window.electronAPI && state.modelDownloadChoice) {
        try {
          await window.electronAPI.saveSettings({ whisperModelDownload: state.modelDownloadChoice });
        } catch (_) { /* ignore */ }
      }
    }

    // Finish: close onboarding
    if (name === 'finish') {
      try {
        await window.electronAPI.completeFirstRun();
      } catch (_) { /* ignore */ }
      try {
        await window.electronAPI.closeOnboarding();
      } catch (_) { /* ignore */ }
      state.finished = true;
      return;
    }

    // Move forward, with whisper-screen insertion handled by order logic
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const nextName = order[idx + 1];
    if (!nextName) return;

    // Compute new step index
    state.step = orderScreenToStep(nextName);
    showScreen(nextName);
    if (nextName === 'whisper') enterWhisperScreen();
    if (nextName === 'model-download') enterModelDownloadScreen();
    if (nextName === 'finish') populateSummary();

    // Re-render stepper with new total
    refreshStepper();
  });

  backBtn.addEventListener('click', () => {
    const name = currentScreenName();
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const prevName = order[idx - 1];
    if (!prevName) return;
    state.step = orderScreenToStep(prevName);
    showScreen(prevName);
  });

  // Skip button: only shown on the whisper screen, lets user skip install
  // even if the CLI isn't present (they can configure later).
  function refreshSkipVisibility() {
    skipBtn.style.display = currentScreenName() === 'whisper' && !state.whisperDetected
      ? 'inline-flex'
      : 'none';
  }

  // Hook into showScreen to keep skip visibility in sync
  const _origShowScreen = showScreen;
  showScreen = function (name) {
    _origShowScreen(name);
    refreshSkipVisibility();
    refreshStepper();
  };

  skipBtn.addEventListener('click', () => {
    state.skippingWhisper = true;
    // Jump to finish without installing
    const order = computeScreenOrder();
    const finishName = order[order.length - 1];
    state.step = orderScreenToStep(finishName);
    showScreen(finishName);
    populateSummary();
  });

  // ── Manual install button (added dynamically) ─────────────────────
  function addManualInstallButton() {
    if (document.getElementById('installWhisperBtn')) return;
    const btn = document.createElement('button');
    btn.id = 'installWhisperBtn';
    btn.type = 'button';
    btn.className = 'oc-btn oc-btn--primary';
    btn.style.marginTop = '12px';
    btn.innerHTML = '<i class="fas fa-download"></i> Install Whisper now';
    btn.addEventListener('click', runWhisperInstall);
    document.querySelector('[data-screen="whisper"]').appendChild(btn);
  }

  // Show install button after detection runs and finds nothing
  const _origDetect = runWhisperDetect;
  runWhisperDetect = async function () {
    await _origDetect();
    if (!state.whisperDetected) addManualInstallButton();
  };

  // ── Boot ──────────────────────────────────────────────────────────
  showScreen('welcome');

  // Accurate wording for the welcome badge.
  const deviceName = $('#deviceName');
  if (deviceName && document.documentElement.dataset.platform === 'darwin') {
    deviceName.textContent = 'this Mac';
  }

  renderProviderFields();

  // Start on the provider already in .env, if any. Keys never leave the
  // main process; the status only says whether one is saved, so the user
  // can test and continue without retyping it.
  if (window.electronAPI && window.electronAPI.getFirstRunStatus) {
    window.electronAPI.getFirstRunStatus().then((s) => {
      if (!s) return;
      state.geminiConfigured = !!s.geminiConfigured;
      if (s.llmProvider && PROVIDERS[s.llmProvider]) {
        state.savedProvider = s.llmProvider;
        state.savedProviderConfigured = !!s.llmConfigured;
        // Only switch while the user has not started on the step.
        if (!state.apiKey && !state.model && state.testedSignature === null && !state.testing) {
          state.provider = s.llmProvider;
        }
      }
      renderProviderFields();
      onProviderInputChanged();
    }).catch(() => {});
  }
})();
