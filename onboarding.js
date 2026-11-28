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
 *   3. Speech provider choice (local voice / Azure / Skip)
 *   4. Local voice model download (local voice only)
 *   5. Summary
 *
 * The local voice path has 5 steps; the others have 4.
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

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
    speechProvider: null, // 'whisper' (local voice) | 'azure' | 'skip'
    azureKey: '',
    azureRegion: '',
    // Local voice: main's get-voice-status answer, cleaned.
    voiceStatus: null,
    voiceChecking: false,
    voiceError: '',
    voiceChoice: null, // a model id, or 'python' to keep Python Whisper
    // id -> { phase: 'downloading' | 'cancelling' | 'cancelled' | 'failed', received, total, error }
    downloads: {},
    activeDownload: null, // the one model downloading, if any
    voiceSaving: false,
    voiceSaved: null, // { engine, model } once main has it
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
    backBtn.disabled = false;
    nextBtn.disabled = false;
    nextBtn.classList.remove('oc-btn--success');
    nextBtn.classList.add('oc-btn--primary');
    // The primary action label changes by step
    if (name === 'welcome') nextBtn.innerHTML = 'Get started <i class="fas fa-arrow-right"></i>';
    else if (name === 'finish') nextBtn.innerHTML = 'Finish <i class="fas fa-check"></i>';
    else if (name === 'voice-model') refreshVoiceButton();
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

  // Order depends on choices: local voice adds the model screen.
  function computeScreenOrder() {
    const out = ['welcome', 'provider', 'speech'];
    if (state.speechProvider === 'whisper') out.push('voice-model');
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
      case 'voice-model':
        return !state.activeDownload && !state.voiceSaving;
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
    setResult(testResult, kind, text);
  }

  // A status line (.test-result): kind is idle | testing | success | error.
  function setResult(node, kind, text) {
    node.className = node.className.replace(/\s*\b(idle|testing|success|error)\b/g, '');
    node.classList.add(kind || 'idle');
    node.textContent = '';
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
    node.append(icon, span);
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
      // The choice sets the path length (local voice adds the model screen).
      refreshStepper();
    });
  });

  $('#azureKey').addEventListener('input', (e) => { state.azureKey = e.target.value.trim(); });
  $('#azureRegion').addEventListener('input', (e) => { state.azureRegion = e.target.value.trim(); });

  // ── Wire up: Local voice model screen ─────────────────────────────
  // Built-in whisper.cpp: pick a model, download it once (with progress,
  // Cancel and Retry), and Continue saves the choice through main.
  const RELEASES_URL = 'https://github.com/ankit1324/cuewell/releases/latest';
  const OFFLINE_TEXT = 'You are offline. Connect to the internet, then retry.';
  const OLD_BUILD_TEXT = 'This version of Cuewell cannot set up local voice.';
  // How the built-in models read here; main's label covers any other id.
  const MODEL_TEXT = {
    'small-q5_1': { name: 'Small', tag: 'Recommended', note: 'Best for Hindi and Hinglish' },
    'base-q5_1': { name: 'Base', tag: '', note: 'Faster, smaller' },
  };
  // A Cancel this soon after Download is a double click, not a choice.
  const CANCEL_GRACE_MS = 600;
  // A cancel main never confirms gives the Cancel button back.
  const CANCEL_STUCK_MS = 10000;

  const voiceList = $('#voiceModelChoices');
  const voiceProblem = $('#voiceProblem');
  const voiceStatusLine = $('#voiceModelStatus');

  const hasApi = (name) => !!(window.electronAPI && typeof window.electronAPI[name] === 'function');
  const voiceModels = () => (state.voiceStatus ? state.voiceStatus.models : []);
  const findVoiceModel = (id) => voiceModels().find((m) => m.id === id) || null;
  const voiceModelName = (m) => (m && MODEL_TEXT[m.id] ? MODEL_TEXT[m.id].name : (m && m.label) || 'the model');
  const builtInRuns = () => !!state.voiceStatus && state.voiceStatus.platformSupported && state.voiceStatus.binaryAvailable;
  const pythonOffered = () => !!state.voiceStatus && state.voiceStatus.pythonConfigured;

  /** Bytes as decimal megabytes: 190085487 -> "190 MB", or "190.1 MB" with digits 1. */
  function formatMB(bytes, digits = 0) {
    return `${(Math.max(0, Number(bytes) || 0) / 1e6).toFixed(digits)} MB`;
  }

  function progressPercent(received, total) {
    if (!(total > 0)) return 0;
    return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
  }

  /** "45.2 MB of 190.1 MB · 23%", or "45.2 MB" while the size is unknown. */
  function progressText(received, total) {
    if (!(total > 0)) return formatMB(received, 1);
    return `${formatMB(received, 1)} of ${formatMB(total, 1)} · ${progressPercent(received, total)}%`;
  }

  function lastLine(text) {
    const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
  }

  /** Keep only well-formed fields from main's answer. */
  function cleanVoiceStatus(raw) {
    const models = Array.isArray(raw.models) ? raw.models
      .filter((m) => m && typeof m.id === 'string' && m.id && typeof m.label === 'string')
      .map((m) => ({ id: m.id, label: m.label, bytes: Number(m.bytes) || 0, downloaded: !!m.downloaded }))
      : [];
    return {
      engine: raw.engine === 'python' ? 'python' : 'whispercpp',
      binaryAvailable: !!raw.binaryAvailable,
      platformSupported: raw.platformSupported !== false,
      models,
      selectedModel: typeof raw.selectedModel === 'string' ? raw.selectedModel : '',
      pythonConfigured: !!raw.pythonConfigured,
    };
  }

  /** True when Continue can save the current choice as it is. */
  function voiceChoiceReady() {
    if (state.voiceChoice === 'python') return pythonOffered();
    const m = findVoiceModel(state.voiceChoice);
    return !!m && m.downloaded && builtInRuns();
  }

  /** The chosen model when it still has to be downloaded, else null. */
  function choiceNeedingDownload() {
    const m = findVoiceModel(state.voiceChoice);
    return m && !m.downloaded && builtInRuns() ? m : null;
  }

  function defaultVoiceChoice(status) {
    if (status.engine === 'python' && status.pythonConfigured) return 'python';
    if (!(status.platformSupported && status.binaryAvailable)) return status.pythonConfigured ? 'python' : null;
    const ids = status.models.map((m) => m.id);
    if (ids.includes(status.selectedModel)) return status.selectedModel;
    return ids[0] || null;
  }

  let voiceCheckToken = 0;
  async function loadVoiceStatus() {
    if (!hasApi('getVoiceStatus')) {
      renderVoiceScreen();
      return;
    }
    const token = ++voiceCheckToken;
    state.voiceChecking = true;
    renderVoiceScreen();
    let status = null;
    try {
      const raw = await window.electronAPI.getVoiceStatus();
      if (raw && typeof raw === 'object') status = cleanVoiceStatus(raw);
    } catch (_) { /* reported below */ }
    if (token !== voiceCheckToken) return;
    state.voiceChecking = false;
    if (status) {
      state.voiceStatus = status;
      state.voiceError = '';
      const known = state.voiceChoice === 'python' ? status.pythonConfigured : status.models.some((m) => m.id === state.voiceChoice);
      if (!known) state.voiceChoice = defaultVoiceChoice(status);
    } else if (!state.voiceStatus) {
      state.voiceError = 'Cuewell could not check local voice.';
    }
    renderVoiceScreen();
  }

  function enterVoiceScreen() {
    if (!state.voiceStatus && !state.voiceChecking) loadVoiceStatus();
    else renderVoiceScreen();
  }

  function externalLink(text, url) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = text;
    return a;
  }

  /** Why built-in voice cannot run here: { parts, retry }, or null. */
  function voiceProblemInfo() {
    const s = state.voiceStatus;
    const later = pythonOffered()
      ? ' You can keep your Python Whisper setup below.'
      : ' Go back to choose Azure Speech, or set it up later in Settings.';
    if (!hasApi('getVoiceStatus')) return { parts: [`${OLD_BUILD_TEXT} Go back to choose Azure Speech, or set it up later in Settings.`] };
    if (!s) return state.voiceError ? { parts: [`${state.voiceError} Check your setup and try again.`], retry: true } : null;
    if (!s.platformSupported) return { parts: [`Built-in voice does not run on this system.${later}`] };
    if (!s.binaryAvailable) {
      return { parts: ['Voice is not available in this build. To use it, install Cuewell from ', externalLink('the release download', RELEASES_URL), `.${later}`] };
    }
    return null;
  }

  function renderVoiceProblem() {
    const info = voiceProblemInfo();
    voiceProblem.hidden = !info;
    voiceProblem.textContent = '';
    if (!info) return;
    const icon = document.createElement('i');
    icon.className = 'fas fa-circle-xmark';
    icon.setAttribute('aria-hidden', 'true');
    const span = document.createElement('span');
    info.parts.forEach((part) => span.append(part));
    voiceProblem.append(icon, span);
    if (info.retry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'oc-btn';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => {
        state.voiceError = '';
        loadVoiceStatus();
      });
      voiceProblem.append(retry);
    }
  }

  function elem(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  }

  function faIcon(name) {
    const i = elem('i', `fas fa-${name}`);
    i.setAttribute('aria-hidden', 'true');
    return i;
  }

  // One card per model, plus "Keep Python Whisper" for setups that have it.
  function buildVoiceCard(entry, index) {
    const card = elem('div', 'model-card oc-card');
    card.dataset.choice = entry.id;
    const radioId = `voiceChoice${index}`;
    const pick = elem('label', 'model-pick');
    pick.htmlFor = radioId;
    const radio = elem('input', 'sr-only');
    radio.type = 'radio';
    radio.name = 'voiceModel';
    radio.id = radioId;
    radio.value = entry.id;
    radio.setAttribute('aria-describedby', `${radioId}State`);
    const iconBox = elem('div', 'choice-icon');
    iconBox.append(faIcon(entry.python ? 'terminal' : 'microphone-lines'));
    const textBox = elem('div', 'choice-text');
    const title = elem('div', 'choice-title', entry.name);
    if (entry.tag) title.append(elem('span', 'oc-chip oc-chip--accent tag', entry.tag));
    textBox.append(title, elem('div', 'choice-desc', entry.desc));
    const ring = elem('div', 'choice-radio');
    ring.setAttribute('aria-hidden', 'true');
    pick.append(radio, ring, iconBox, textBox);

    const side = elem('div', 'model-side');
    const stateText = elem('span', 'model-state');
    stateText.id = `${radioId}State`;
    side.append(stateText);
    card.append(pick, side);
    if (!entry.python) {
      const button = elem('button', 'oc-btn');
      button.type = 'button';
      button.dataset.act = 'download';
      side.append(button);
      const progress = elem('div', 'model-progress');
      progress.hidden = true;
      const meter = elem('div', 'meter');
      meter.setAttribute('role', 'progressbar');
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', '100');
      meter.setAttribute('aria-label', `Downloading ${entry.name}`);
      meter.append(elem('span'));
      const progressLabel = elem('span', 'model-progress-text');
      progressLabel.setAttribute('aria-hidden', 'true');
      progress.append(meter, progressLabel);
      const msg = elem('div', 'model-msg');
      msg.setAttribute('role', 'status');
      card.append(progress, msg);
    }
    return card;
  }

  function voiceEntries() {
    const entries = builtInRuns() ? voiceModels().map((m) => {
      const text = MODEL_TEXT[m.id] || { name: m.label, tag: '', note: '' };
      return { id: m.id, name: text.name, tag: text.tag, desc: [text.note, m.bytes ? formatMB(m.bytes) : ''].filter(Boolean).join(' · ') };
    }) : [];
    if (pythonOffered()) {
      entries.push({ id: 'python', python: true, name: 'Keep Python Whisper (advanced)', tag: '', desc: 'Use the Python Whisper setup you already have.' });
    }
    return entries;
  }

  function setActionButton(button, act, html, disabled) {
    button.hidden = !act;
    if (!act) return;
    // Same button, new action: keyboard focus stays on it.
    if (button.dataset.act !== act || button.dataset.html !== html) {
      button.dataset.act = act;
      button.dataset.html = html;
      button.innerHTML = html;
    }
    button.disabled = !!disabled;
  }

  function paintProgress(card, d) {
    const box = card.querySelector('.model-progress');
    if (!box) return;
    box.hidden = !d;
    if (!d) return;
    const percent = progressPercent(d.received, d.total);
    const text = progressText(d.received, d.total);
    const meter = box.querySelector('.meter');
    meter.setAttribute('aria-valuenow', String(percent));
    meter.setAttribute('aria-valuetext', text);
    meter.firstElementChild.style.width = `${percent}%`;
    box.querySelector('.model-progress-text').textContent = text;
  }

  function updateVoiceCard(card) {
    const id = card.dataset.choice;
    const radio = card.querySelector('input[name="voiceModel"]');
    radio.checked = state.voiceChoice === id;
    const stateText = card.querySelector('.model-state');
    if (id === 'python') {
      stateText.className = 'model-state ok';
      stateText.replaceChildren(faIcon('circle-check'), document.createTextNode('Set up'));
      return;
    }
    const m = findVoiceModel(id);
    if (!m) return;
    const d = state.downloads[id] || null;
    const phase = d ? d.phase : '';
    const running = phase === 'downloading' || phase === 'cancelling';
    stateText.className = `model-state${m.downloaded ? ' ok' : ''}`;
    if (m.downloaded) stateText.replaceChildren(faIcon('circle-check'), document.createTextNode('Ready'));
    else stateText.textContent = running ? 'Downloading' : 'Not downloaded';

    const button = card.querySelector('button[data-act]');
    const busyElsewhere = !!state.activeDownload && state.activeDownload !== id;
    if (m.downloaded) setActionButton(button, null);
    else if (phase === 'downloading') setActionButton(button, 'cancel', '<i class="fas fa-xmark" aria-hidden="true"></i> Cancel');
    else if (phase === 'cancelling') setActionButton(button, 'cancel', '<span class="spinner"></span> Cancelling…', true);
    else if (phase === 'failed') setActionButton(button, 'retry', '<i class="fas fa-rotate-right" aria-hidden="true"></i> Retry', busyElsewhere || state.voiceSaving);
    else setActionButton(button, 'download', '<i class="fas fa-download" aria-hidden="true"></i> Download', busyElsewhere || state.voiceSaving);

    const msg = card.querySelector('.model-msg');
    const text = phase === 'failed' ? d.error : phase === 'cancelled' ? 'Download cancelled.' : '';
    if (msg.dataset.text !== text) {
      msg.dataset.text = text;
      msg.className = `model-msg${phase === 'failed' ? ' error' : ' info'}`;
      msg.textContent = text;
    }
    paintProgress(card, running ? d : null);
  }

  function renderVoiceScreen() {
    renderVoiceProblem();
    const entries = voiceEntries();
    const key = entries.map((e) => e.id).join('|');
    if (voiceList.dataset.key !== key) {
      voiceList.dataset.key = key;
      voiceList.querySelectorAll('.model-card').forEach((card) => card.remove());
      entries.forEach((entry, i) => voiceList.append(buildVoiceCard(entry, i)));
    }
    voiceList.hidden = entries.length === 0;
    voiceList.querySelectorAll('.model-card').forEach(updateVoiceCard);
    if (state.voiceChecking && !state.voiceStatus) setResult(voiceStatusLine, 'testing', 'Checking voice setup…');
    else if (voiceStatusLine.classList.contains('testing')) setResult(voiceStatusLine, 'idle', '');
    $('#voiceLanguageHint').hidden = !builtInRuns();
    refreshVoiceButton();
  }

  // Continue on this screen: Download (the chosen model still needs it),
  // Continue (ready to save), or plain Continue (nothing to set up here).
  function refreshVoiceButton() {
    if (currentScreenName() !== 'voice-model') return;
    nextBtn.classList.remove('oc-btn--success');
    nextBtn.classList.add('oc-btn--primary');
    const busy = !!state.activeDownload || state.voiceSaving;
    backBtn.disabled = busy;
    if (state.activeDownload) {
      nextBtn.disabled = true;
      nextBtn.innerHTML = '<span class="spinner"></span> Downloading…';
    } else if (state.voiceSaving) {
      nextBtn.disabled = true;
      nextBtn.innerHTML = '<span class="spinner"></span> Saving…';
    } else if (choiceNeedingDownload()) {
      nextBtn.disabled = false;
      const failed = state.downloads[state.voiceChoice] && state.downloads[state.voiceChoice].phase === 'failed';
      nextBtn.innerHTML = failed
        ? '<i class="fas fa-rotate-right"></i> Retry download'
        : '<i class="fas fa-download"></i> Download';
    } else if (voiceChoiceReady()) {
      nextBtn.disabled = false;
      nextBtn.classList.remove('oc-btn--primary');
      nextBtn.classList.add('oc-btn--success');
      nextBtn.innerHTML = '<i class="fas fa-check-circle"></i> Continue';
    } else {
      nextBtn.disabled = state.voiceChecking && !state.voiceStatus;
      nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
    }
    refreshSkipVisibility();
  }

  voiceList.addEventListener('change', (e) => {
    const radio = e.target.closest('input[name="voiceModel"]');
    if (!radio || !radio.checked) return;
    state.voiceChoice = radio.value;
    setResult(voiceStatusLine, 'idle', '');
    renderVoiceScreen();
  });

  voiceList.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-act]');
    const card = button && button.closest('.model-card');
    if (!card || button.disabled) return;
    if (button.dataset.act === 'cancel') cancelVoiceDownload(card.dataset.choice);
    else startVoiceDownload(card.dataset.choice);
  });

  if (hasApi('onVoiceModelProgress')) {
    window.electronAPI.onVoiceModelProgress((data) => {
      if (!data || typeof data.id !== 'string') return;
      const d = state.downloads[data.id];
      if (!d || (d.phase !== 'downloading' && d.phase !== 'cancelling')) return;
      const received = Number(data.received);
      const total = Number(data.total);
      if (Number.isFinite(received) && received >= 0) d.received = received;
      if (Number.isFinite(total) && total > 0) d.total = total;
      // At most one repaint per frame, however often main reports.
      if (d.frame) return;
      d.frame = requestAnimationFrame(() => {
        d.frame = 0;
        const card = Array.from(voiceList.querySelectorAll('.model-card')).find((c) => c.dataset.choice === data.id);
        if (card && state.downloads[data.id] === d) paintProgress(card, d);
      });
    });
  }

  // Low-level network and disk errors, in plain words.
  const NETWORK_ERROR = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|network)\b/i;
  const DISK_FULL_ERROR = /\b(ENOSPC|EDQUOT)\b/;

  function downloadError(raw) {
    if (navigator.onLine === false) return OFFLINE_TEXT;
    const text = lastLine(raw);
    if (DISK_FULL_ERROR.test(text)) return 'There is not enough free disk space. Free up some space, then retry.';
    if (!text || NETWORK_ERROR.test(text)) return 'Could not reach the download server. Check your internet connection, then retry.';
    return text;
  }

  /** The focused button went away or was disabled: put focus back on its card. */
  function refocusCard(id) {
    const card = Array.from(voiceList.querySelectorAll('.model-card')).find((c) => c.dataset.choice === id);
    if (!card) return;
    // Chromium moves focus off a hidden or disabled button a frame later.
    const active = document.activeElement;
    const lost = !active || active === document.body ||
      (card.contains(active) && (active.hidden || active.disabled));
    if (!lost) return;
    const target = card.querySelector('button[data-act]:not([hidden]):not(:disabled)') || card.querySelector('input');
    if (target) target.focus({ preventScroll: true });
  }

  /**
   * Download one model. With thenContinue (Continue started it), move on
   * once it is ready, unless the user picked something else meanwhile.
   */
  async function startVoiceDownload(id, { thenContinue = false } = {}) {
    const m = findVoiceModel(id);
    if (!m || m.downloaded || state.activeDownload || state.voiceSaving) return;
    setResult(voiceStatusLine, 'idle', '');
    if (!hasApi('downloadVoiceModel')) {
      state.downloads[id] = { phase: 'failed', error: `${OLD_BUILD_TEXT} Set it up later in Settings.` };
      renderVoiceScreen();
      return;
    }
    if (navigator.onLine === false) {
      state.downloads[id] = { phase: 'failed', error: OFFLINE_TEXT };
      renderVoiceScreen();
      return;
    }
    const d = { phase: 'downloading', received: 0, total: m.bytes, startedAt: Date.now(), frame: 0 };
    state.downloads[id] = d;
    state.activeDownload = id;
    renderVoiceScreen();
    let result;
    try {
      result = await window.electronAPI.downloadVoiceModel(id);
    } catch (_) {
      result = { success: false, error: '' };
    }
    state.activeDownload = null;
    if (d.frame) cancelAnimationFrame(d.frame);
    let ready = false;
    if (result && result.success) {
      delete state.downloads[id];
      const current = findVoiceModel(id);
      if (current) current.downloaded = true;
      ready = true;
      // A finished model becomes the choice unless another ready one is.
      if (!voiceChoiceReady()) state.voiceChoice = id;
      setResult(voiceStatusLine, 'success', `${voiceModelName(m)} is ready.`);
    } else if (d.phase === 'cancelling') {
      state.downloads[id] = { phase: 'cancelled' };
    } else {
      state.downloads[id] = { phase: 'failed', error: downloadError(result && result.error) };
    }
    renderVoiceScreen();
    refocusCard(id);
    if (ready && thenContinue && currentScreenName() === 'voice-model' && state.voiceChoice === id && !nextBtn.disabled) {
      nextBtn.click();
    }
  }

  async function cancelVoiceDownload(id) {
    const d = state.downloads[id];
    if (!d || d.phase !== 'downloading' || Date.now() - d.startedAt < CANCEL_GRACE_MS) return;
    if (!hasApi('cancelVoiceModelDownload')) {
      setResult(voiceStatusLine, 'error', 'This version of Cuewell cannot cancel the download. It keeps going.');
      return;
    }
    d.phase = 'cancelling';
    renderVoiceScreen();
    setTimeout(() => {
      if (state.downloads[id] === d && d.phase === 'cancelling') {
        d.phase = 'downloading';
        renderVoiceScreen();
      }
    }, CANCEL_STUCK_MS);
    try {
      await window.electronAPI.cancelVoiceModelDownload(id);
    } catch (_) { /* the download's own result reports */ }
  }

  /** Save the ready choice through main. Resolves true to move on. */
  async function saveVoiceChoice() {
    // Nothing usable chosen (for example no voice in this build): move on.
    if (!voiceChoiceReady()) return true;
    if (!hasApi('setVoiceEngine')) {
      setResult(voiceStatusLine, 'error', `${OLD_BUILD_TEXT} Choose Set up later, then use Settings > Voice.`);
      return false;
    }
    const engine = state.voiceChoice === 'python' ? 'python' : 'whispercpp';
    const model = engine === 'whispercpp' ? state.voiceChoice : undefined;
    state.voiceSaving = true;
    renderVoiceScreen();
    let result;
    try {
      result = await window.electronAPI.setVoiceEngine(engine, model);
    } catch (e) {
      result = { success: false, error: e && e.message };
    }
    state.voiceSaving = false;
    renderVoiceScreen();
    if (result && result.success) {
      state.voiceSaved = { engine, model };
      return true;
    }
    setResult(voiceStatusLine, 'error', (result && result.error) || 'Could not save your voice choice. Try again, or choose Set up later.');
    return false;
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
      const saved = state.voiceSaved;
      let value = 'Local voice (set up later in Settings)';
      if (saved && saved.engine === 'python') value = 'Python Whisper';
      else if (saved) value = `Local voice · ${voiceModelName(findVoiceModel(saved.model))}`;
      rows.push({ icon: 'fa-microphone', label: 'Speech', value, cls: saved ? 'ok' : 'skip' });
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

    // Local voice: Continue downloads the chosen model first if it needs
    // it (moving on once it is ready), then saves the choice.
    if (name === 'voice-model') {
      if (choiceNeedingDownload()) {
        await startVoiceDownload(state.voiceChoice, { thenContinue: true });
        return;
      }
      const saved = await saveVoiceChoice();
      if (!saved || currentScreenName() !== 'voice-model') return;
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

    // Move forward along the path for the current choices
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const nextName = order[idx + 1];
    if (!nextName) return;

    // Compute new step index
    state.step = orderScreenToStep(nextName);
    showScreen(nextName);
    if (nextName === 'voice-model') enterVoiceScreen();
    if (nextName === 'finish') populateSummary();

    // Re-render stepper with new total
    refreshStepper();
  });

  backBtn.addEventListener('click', () => {
    if (backBtn.disabled) return;
    const name = currentScreenName();
    const order = computeScreenOrder();
    const idx = order.indexOf(name);
    const prevName = order[idx - 1];
    if (!prevName) return;
    state.step = orderScreenToStep(prevName);
    showScreen(prevName);
    if (prevName === 'voice-model') enterVoiceScreen();
  });

  // "Set up later": on the voice screen while the chosen model still needs
  // a download, so a slow or failed download never blocks the wizard.
  function refreshSkipVisibility() {
    const show = currentScreenName() === 'voice-model' && !state.activeDownload &&
      !state.voiceSaving && !!choiceNeedingDownload();
    skipBtn.style.display = show ? 'inline-flex' : 'none';
  }

  // Hook into showScreen to keep skip visibility in sync
  const _origShowScreen = showScreen;
  showScreen = function (name) {
    _origShowScreen(name);
    refreshSkipVisibility();
    refreshStepper();
  };

  skipBtn.addEventListener('click', () => {
    if (state.activeDownload || state.voiceSaving) return;
    // Jump to finish; voice can be set up later in Settings.
    const order = computeScreenOrder();
    const finishName = order[order.length - 1];
    state.step = orderScreenToStep(finishName);
    showScreen(finishName);
    populateSummary();
  });

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
