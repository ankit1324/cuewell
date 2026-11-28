'use strict';

// Settings window (settings.html). Every change is sent to main.js, which
// validates and saves it; this page only shows the result. Saved keys come
// back masked ({ set, last4 }) and are never sent to this page.

(() => {
    const api = window.electronAPI || null;
    const $ = (id) => document.getElementById(id);

    const SECTION_TITLES = {
        general: 'General',
        ai: 'AI provider',
        you: 'About you',
        context: 'Interview context',
        voice: 'Voice',
        shortcuts: 'Shortcuts',
        privacy: 'Privacy & appearance',
        about: 'About'
    };

    // Where to get a key for each provider. Ollama needs none.
    const PROVIDER_KEY_HELP = {
        gemini: { text: 'Get a key in Google AI Studio', url: 'https://aistudio.google.com/apikey' },
        anthropic: { text: 'Get a key in the Anthropic Console', url: 'https://console.anthropic.com/settings/keys' },
        openai: { text: 'Get a key on the OpenAI platform', url: 'https://platform.openai.com/api-keys' },
        openrouter: { text: 'Get a key on OpenRouter', url: 'https://openrouter.ai/keys' },
        groq: { text: 'Get a key in the Groq console', url: 'https://console.groq.com/keys' },
        deepseek: { text: 'Get a key on the DeepSeek platform', url: 'https://platform.deepseek.com/api_keys' }
    };

    const VISION_PROVIDERS_TEXT = 'Gemini, Claude, OpenAI, OpenRouter or Ollama';
    const SAVE_FAILED = 'Could not save. Try again.';
    const OK_STATUS_MS = 2400;
    const TEST_SLOW_MS = 8000;

    const state = {
        settings: null,
        info: null,
        section: 'general',
        query: '',
        // field -> value last confirmed by main, for text inputs
        saved: {},
        whisperCheckedAt: 0,
        whisperBusy: null,
        testToken: 0
    };

    // main's answer first; preload's html[data-platform] until it arrives.
    const platform = () => (state.info && state.info.platform) || document.documentElement.dataset.platform || '';
    const isMac = () => platform() === 'darwin';

    // ---------- Small DOM helpers ----------

    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);
        if (attrs) {
            for (const [key, value] of Object.entries(attrs)) {
                if (value === undefined || value === null || value === false) continue;
                if (key === 'class') node.className = value;
                else if (key === 'text') node.textContent = value;
                else if (key in node && typeof value !== 'string') node[key] = value;
                else node.setAttribute(key, value === true ? '' : String(value));
            }
        }
        children.flat().forEach((child) => {
            if (child === null || child === undefined || child === false) return;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        });
        return node;
    }

    /** replaceChildren that skips null/false and flattens arrays. */
    function fill(node, ...children) {
        node.replaceChildren();
        children.flat(Infinity).forEach((child) => {
            if (child === null || child === undefined || child === false || child === '') return;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        });
        return node;
    }

    // Enter or Esc that only confirms or cancels an input-method candidate.
    const composing = (e) => e.isComposing || e.keyCode === 229;

    const icon = (name, extra = '') => el('i', { class: `fas fa-${name}${extra ? ` ${extra}` : ''}`, 'aria-hidden': 'true' });

    function externalLink(text, url) {
        return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text);
    }

    // ---------- Inline status ----------

    const statusTimers = new WeakMap();
    const STATUS_ICONS = { ok: 'circle-check', error: 'circle-exclamation', warn: 'triangle-exclamation', busy: 'circle-notch', info: 'circle-info' };

    /**
     * Show `text` in a status element. kind: ok | error | warn | busy | info.
     * "ok" clears itself after a moment unless sticky.
     */
    function setStatus(node, kind, text, { sticky = false } = {}) {
        if (!node) return;
        const timer = statusTimers.get(node);
        if (timer) clearTimeout(timer);
        node.className = node.className.replace(/\s*is-\w+/g, '');
        node.replaceChildren();
        if (!text) return;
        node.classList.add(`is-${kind}`);
        const glyph = STATUS_ICONS[kind];
        if (glyph && node.classList.contains('sw-status')) {
            node.append(icon(glyph, kind === 'busy' ? 'fa-spin-fast' : ''));
        }
        node.append(el('span', null, text));
        if (kind === 'ok' && !sticky) {
            statusTimers.set(node, setTimeout(() => setStatus(node, '', ''), OK_STATUS_MS));
        }
    }

    function markInvalid(input, invalid) {
        if (!input) return;
        if (invalid) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
    }

    // ---------- Saving ----------

    const saveTokens = {};

    /**
     * Save `payload` through main. Shows "Saving…" / "Saved" / the error in
     * `status`, and marks `input` invalid on error. Resolves to
     * { ok, error }. A newer save of the same key makes older results stale.
     */
    async function save(payload, { status, input, okText = 'Saved', key } = {}) {
        const token = key ? (saveTokens[key] = (saveTokens[key] || 0) + 1) : 0;
        const stale = () => key && saveTokens[key] !== token;
        if (!api || !api.saveSettings) {
            setStatus(status, 'error', SAVE_FAILED, { sticky: true });
            return { ok: false, error: SAVE_FAILED };
        }
        setStatus(status, 'busy', 'Saving…');
        let result;
        try {
            result = await api.saveSettings(payload);
        } catch (_) {
            result = { success: false, error: SAVE_FAILED };
        }
        if (stale()) return { ok: false, stale: true };
        if (result && result.success) {
            markInvalid(input, false);
            // Applied, but the settings file could not be written.
            if (result.warning) setStatus(status, 'warn', result.warning, { sticky: true });
            else setStatus(status, 'ok', okText);
            return { ok: true };
        }
        const fields = Object.keys(payload);
        const errors = result && Array.isArray(result.errors) ? result.errors : [];
        const own = errors.find((e) => e && fields.includes(e.field));
        const message = (own && own.error) || (result && result.error) || SAVE_FAILED;
        markInvalid(input, true);
        setStatus(status, 'error', message, { sticky: true });
        return { ok: false, error: message };
    }

    // ---------- Loading ----------

    let loadToken = 0;
    async function loadSettings({ quiet = false } = {}) {
        if (!api || !api.getSettings) {
            showLoadError('Settings could not start. Quit Cuewell and open it again.', false);
            return false;
        }
        const token = ++loadToken;
        const bar = $('loadingBar');
        const slow = quiet ? setTimeout(() => { bar.hidden = false; }, 400) : null;
        if (!quiet) bar.hidden = false;
        try {
            const settings = await api.getSettings();
            if (!settings || typeof settings !== 'object') throw new Error('empty');
            // A newer request is on its way; this answer may predate a change.
            if (token !== loadToken) return true;
            state.settings = settings;
            hideLoadError();
            renderSettings();
            return true;
        } catch (_) {
            if (!state.settings) showLoadError('Settings could not be loaded.', true);
            return false;
        } finally {
            if (slow) clearTimeout(slow);
            bar.hidden = true;
        }
    }

    async function loadInfo() {
        if (!api || !api.getSettingsInfo) return;
        try {
            state.info = await api.getSettingsInfo();
        } catch (_) {
            state.info = null;
        }
        renderInfo();
        renderVoice();
    }

    function showLoadError(text, canRetry) {
        $('loadErrorText').textContent = text;
        $('loadRetry').hidden = !canRetry;
        $('loadError').hidden = false;
        document.querySelectorAll('.sw-section').forEach((section) => { section.hidden = true; });
    }

    function hideLoadError() {
        if ($('loadError').hidden) return;
        $('loadError').hidden = true;
        applyView();
    }

    // ---------- Simple fields (data-setting) ----------

    const settingInputs = Array.from(document.querySelectorAll('[data-setting]'));
    const pendingValues = {};
    const statusFor = (input) => $(`${input.id}Status`);

    function setInputValue(input, value) {
        const text = value === undefined || value === null ? '' : String(value);
        // Never overwrite what the user is typing, or a rejected value they
        // still need to fix.
        if (input.value !== (state.saved[input.dataset.setting] ?? '') &&
            (document.activeElement === input || input.getAttribute('aria-invalid') === 'true')) return;
        if (input.tagName === 'SELECT' && text && !Array.from(input.options).some((o) => o.value === text)) {
            input.append(el('option', { value: text }, text));
        }
        input.value = text;
        state.saved[input.dataset.setting] = input.value;
    }

    async function saveSettingInput(input) {
        const field = input.dataset.setting;
        const value = input.value.trim();
        if (input.tagName !== 'SELECT' && value === (state.saved[field] ?? '').trim()) return;
        // The same value is already on its way (change and Enter, or a flush).
        if (pendingValues[field] === value) return;
        pendingValues[field] = value;
        const result = await save({ [field]: value }, { status: statusFor(input), input, key: field });
        if (pendingValues[field] === value) delete pendingValues[field];
        if (result.ok) {
            state.saved[field] = value;
            if (state.settings) state.settings[field] = value;
            afterSettingSaved(field);
        }
    }

    settingInputs.forEach((input) => {
        input.addEventListener('change', () => saveSettingInput(input));
        if (input.tagName !== 'SELECT') {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !composing(e)) {
                    e.preventDefault();
                    saveSettingInput(input);
                }
            });
            input.addEventListener('input', () => markInvalid(input, false));
        }
    });

    function afterSettingSaved(field) {
        if (field === 'ollamaBaseUrl') cancelTest();
        if (field === 'whisperModel' || field === 'whisperCommand') refreshWhisperStatus();
        // A new command can make Python Whisper usable or not.
        if (field === 'whisperCommand') refreshVoiceStatus();
        if (field === 'azureRegion' || field === 'whisperCommand') loadSettings({ quiet: true });
    }

    /** Save text fields edited but not yet saved (focus left the window, or it is closing). */
    function flushTextInputs() {
        const pending = settingInputs.filter((input) => input.tagName !== 'SELECT' &&
            input.value.trim() !== (state.saved[input.dataset.setting] ?? '').trim());
        if (modelInput.value.trim() !== (state.saved[modelField()] ?? '').trim()) pending.push(modelInput);
        return Promise.all(pending.map((input) => (input === modelInput ? saveModel() : saveSettingInput(input))));
    }

    // ---------- Render everything from state.settings ----------

    function renderSettings() {
        const s = state.settings;
        if (!s) return;

        const modeSelect = $('activeSkill');
        if (Array.isArray(s.modes) && s.modes.length) {
            const current = modeSelect.value;
            modeSelect.replaceChildren(...s.modes
                .filter((m) => m && typeof m.id === 'string' && typeof m.label === 'string')
                .map((m) => el('option', { value: m.id }, m.label)));
            modeSelect.value = current;
        }

        settingInputs.forEach((input) => {
            const value = s[input.dataset.setting];
            setInputValue(input, value === undefined ? '' : value);
        });

        renderProviders();
        renderVoice();
        renderIcons();
        renderPrivacy();
        // A provider change from elsewhere can show or hide gated settings.
        if (state.query) runSearch();
    }

    // ---------- AI provider ----------

    const providerGrid = $('providerGrid');
    const modelInput = $('providerModel');
    const providerKey = createSecretField($('providerKeyField'), {
        labelId: 'providerKeyLabel',
        helpId: 'providerKeyHelp',
        name: () => (currentProvider() ? `${currentProvider().label} key` : 'key'),
        // An earlier test result no longer describes the saved key.
        onChange: () => {
            cancelTest();
            loadSettings({ quiet: true });
        }
    });

    const providers = () => (state.settings && Array.isArray(state.settings.llmProviders) ? state.settings.llmProviders : []);
    const currentProviderId = () => (state.settings && state.settings.llmProvider) || 'gemini';
    const currentProvider = () => providers().find((p) => p.id === currentProviderId()) || null;
    const keyFieldFor = (id) => (id === 'gemini' ? 'geminiKey' : `${id}Key`);
    const modelField = () => `${currentProviderId()}Model`;
    const masked = (field) => {
        const value = state.settings && state.settings[field];
        return value && typeof value === 'object' ? value : { set: false, last4: '' };
    };
    const hasKey = (p) => p.noKey || masked(keyFieldFor(p.id)).set;

    function renderProviders() {
        const list = providers();
        const activeId = currentProviderId();
        if (providerGrid.childElementCount !== list.length) {
            providerGrid.replaceChildren(...list.map((p) => el('button', {
                type: 'button',
                class: 'sw-provider',
                role: 'radio',
                'data-provider': p.id
            },
            el('span', { class: 'sw-provider-name' }, p.label),
            el('span', { class: 'sw-provider-meta' }),
            el('span', { class: 'sw-provider-check', 'aria-hidden': 'true' }, icon('check')))));
        }
        providerGrid.querySelectorAll('.sw-provider').forEach((card) => {
            const p = list.find((item) => item.id === card.dataset.provider);
            if (!p) return;
            const checked = p.id === activeId;
            card.setAttribute('aria-checked', String(checked));
            card.tabIndex = checked ? 0 : -1;
            const meta = card.querySelector('.sw-provider-meta');
            const keyState = p.noKey
                ? el('span', null, 'No key needed')
                : hasKey(p)
                    ? el('span', { class: 'is-ok' }, 'Key saved')
                    : el('span', { class: 'is-missing' }, 'No key');
            fill(meta, keyState, p.supportsImages ? null : el('span', null, 'Text only'));
            card.setAttribute('aria-label', `${p.label}, ${keyState.textContent}${p.supportsImages ? '' : ', text only'}`);
        });
        if (!providerGrid.querySelector('[tabindex="0"]') && providerGrid.firstElementChild) {
            providerGrid.firstElementChild.tabIndex = 0;
        }
        renderProviderDetail();
    }

    function renderProviderDetail() {
        const p = currentProvider();
        if (!p) return;
        $('providerDetailTitle').textContent = `${p.label} settings`;

        // Key
        $('providerKeyRow').hidden = !!p.noKey;
        if (!p.noKey) {
            const help = PROVIDER_KEY_HELP[p.id];
            const helpNode = $('providerKeyHelp');
            helpNode.replaceChildren();
            if (help) helpNode.append(externalLink(help.text, help.url), '. ');
            helpNode.append(`Saved on this computer and sent only to ${p.label}.`);
            providerKey.setField(keyFieldFor(p.id), masked(keyFieldFor(p.id)));
        }

        // Model
        const field = modelField();
        const saved = (state.settings && state.settings[field]) || '';
        if (modelInput.dataset.field !== field) {
            modelInput.dataset.field = field;
            modelInput.value = saved;
            markInvalid(modelInput, false);
            setStatus($('providerModelStatus'), '', '');
        } else if (document.activeElement !== modelInput || modelInput.value === (state.saved[field] ?? '')) {
            modelInput.value = saved;
        }
        state.saved[field] = saved;
        modelInput.placeholder = p.defaultModel || '';
        fill($('providerModelHelp'),
            'Leave empty to use the default',
            p.defaultModel ? [' (', el('code', null, p.defaultModel), ')'] : '',
            '.',
            p.id === 'ollama' ? [' Use a model you have pulled with ', el('code', null, 'ollama pull'), '.'] : ''
        );

        // Server URL (Ollama only)
        $('providerUrlRow').hidden = p.id !== 'ollama';

        // Test help
        $('providerTestHelp').textContent = p.supportsImages
            ? 'Sends one short request with these settings. Nothing is saved.'
            : `Sends one short request with these settings. Nothing is saved. ${p.label} answers text only: screenshots need ${VISION_PROVIDERS_TEXT}.`;

        // Missing key warning
        const missing = !hasKey(p);
        $('providerMissingKey').hidden = !missing;
        $('aiNavAlert').hidden = !missing;
        if (missing) {
            $('providerMissingKeyText').textContent =
                `${p.label} has no API key yet, so Cuewell cannot answer questions. Add your key below.`;
        }
    }

    async function selectProvider(id) {
        const previous = currentProviderId();
        if (id === previous || !state.settings) return;
        cancelTest();
        state.settings.llmProvider = id;
        renderProviders();
        const p = currentProvider();
        const result = await save({ llmProvider: id }, {
            status: $('llmProviderStatus'),
            key: 'llmProvider',
            okText: p ? `Now using ${p.label}` : 'Saved'
        });
        if (result.stale) return;
        if (!result.ok) {
            state.settings.llmProvider = previous;
            renderProviders();
            return;
        }
        loadSettings({ quiet: true });
    }

    providerGrid.addEventListener('click', (e) => {
        const card = e.target.closest('.sw-provider');
        if (card) selectProvider(card.dataset.provider);
    });
    providerGrid.addEventListener('keydown', (e) => radioKeys(e, providerGrid, '.sw-provider', (card) => selectProvider(card.dataset.provider)));

    /** Arrow/Home/End keys in a radio group: move focus and select. */
    function radioKeys(e, group, selector, onSelect) {
        const items = Array.from(group.querySelectorAll(selector));
        const index = items.indexOf(document.activeElement);
        if (index < 0) return;
        let next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = items[(index + 1) % items.length];
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
        else if (e.key === 'Home') next = items[0];
        else if (e.key === 'End') next = items[items.length - 1];
        if (!next) return;
        e.preventDefault();
        items.forEach((item) => { item.tabIndex = item === next ? 0 : -1; });
        next.focus();
        onSelect(next);
    }

    async function saveModel() {
        const field = modelField();
        const value = modelInput.value.trim();
        if (value === (state.saved[field] ?? '').trim()) return;
        const result = await save({ [field]: value }, { status: $('providerModelStatus'), input: modelInput, key: field });
        if (result.ok) {
            state.saved[field] = value;
            if (state.settings) state.settings[field] = value;
            cancelTest();
        }
    }
    modelInput.addEventListener('change', saveModel);
    modelInput.addEventListener('input', () => markInvalid(modelInput, false));
    modelInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !composing(e)) {
            e.preventDefault();
            saveModel();
        }
    });

    // Test connection
    const testButton = $('providerTestButton');
    const testStatus = $('providerTestStatus');
    let testSlowTimer = null;

    function cancelTest() {
        state.testToken += 1;
        clearTimeout(testSlowTimer);
        testButton.disabled = false;
        setStatus(testStatus, '', '');
    }

    async function runTest() {
        const p = currentProvider();
        if (!p || !api || !api.testProvider) return;
        const token = ++state.testToken;
        const draft = providerKey.draft();
        const input = { provider: p.id };
        if (draft && !p.noKey) input.apiKey = draft;
        const model = modelInput.value.trim();
        if (model) input.model = model;
        if (p.id === 'ollama') {
            const url = $('ollamaBaseUrl').value.trim();
            if (url) input.baseUrl = url;
        }
        if (!p.noKey && !draft && !hasKey(p)) {
            setStatus(testStatus, 'error', `Enter your ${p.label} API key first.`, { sticky: true });
            return;
        }
        testButton.disabled = true;
        setStatus(testStatus, 'busy', `Testing ${p.label}…`);
        clearTimeout(testSlowTimer);
        testSlowTimer = setTimeout(() => {
            if (token !== state.testToken) return;
            setStatus(testStatus, 'busy', p.id === 'ollama'
                ? `Still waiting for ${p.label}. A model that is not loaded yet can take up to a minute.`
                : `Still waiting for ${p.label}…`);
        }, TEST_SLOW_MS);
        let result;
        try {
            result = await api.testProvider(input);
        } catch (_) {
            result = { ok: false, message: 'Could not run the test. Try again.' };
        }
        if (token !== state.testToken) return;
        clearTimeout(testSlowTimer);
        testButton.disabled = false;
        if (result && result.ok) {
            const note = draft ? ' The key is not saved yet: choose Save key to use it.' : '';
            setStatus(testStatus, 'ok', `${result.message || 'Connected.'}${note}`, { sticky: true });
        } else {
            setStatus(testStatus, 'error', (result && result.message) || 'Connection failed.', { sticky: true });
        }
    }
    testButton.addEventListener('click', runTest);

    // ---------- Secret (key) field ----------

    /**
     * A saved-key control: shows "•••• last4 (saved)" with Replace and Remove
     * key, or an input with Save key. Remove asks for confirmation. The typed
     * key is only sent on Save key or Enter, never read back.
     */
    function createSecretField(root, { labelId, helpId, name, onChange }) {
        const inputId = `${root.id}Input`;
        const statusId = `${root.id}Status`;
        let field = null;
        let current = { set: false, last4: '' };
        let mode = 'edit';
        // True after Replace until the key is saved or Cancel is chosen.
        let replacing = false;

        const maskText = el('span');
        const savedView = el('div', { class: 'sw-key-saved' },
            el('span', { class: 'sw-key-mask' }, icon('key'), maskText),
            el('button', { type: 'button', class: 'oc-btn', 'data-act': 'replace' }, icon('pen'), 'Replace'),
            el('button', { type: 'button', class: 'oc-btn oc-btn--danger', 'data-act': 'remove' }, icon('trash-can'), 'Remove key'));

        const input = el('input', {
            type: 'password',
            class: 'oc-input',
            id: inputId,
            autocomplete: 'off',
            spellcheck: 'false',
            maxlength: '1000',
            'aria-labelledby': labelId,
            'aria-describedby': `${helpId} ${statusId}`
        });
        const reveal = el('button', {
            type: 'button',
            class: 'oc-btn oc-btn--ghost oc-icon-btn sw-key-reveal',
            'data-act': 'reveal',
            'aria-label': 'Show key',
            'aria-pressed': 'false',
            title: 'Show key'
        }, icon('eye'));
        const saveButton = el('button', { type: 'button', class: 'oc-btn oc-btn--primary', 'data-act': 'save' }, 'Save key');
        const cancelButton = el('button', { type: 'button', class: 'oc-btn oc-btn--ghost', 'data-act': 'cancel' }, 'Cancel');
        const editView = el('div', { class: 'sw-inline' },
            el('div', { class: 'sw-key-input' }, input, reveal), saveButton, cancelButton);

        const confirmText = el('p');
        const confirmView = el('div', { class: 'sw-confirm', role: 'group', 'aria-label': 'Confirm removal' },
            confirmText,
            el('div', { class: 'sw-inline' },
                el('button', { type: 'button', class: 'oc-btn oc-btn--danger', 'data-act': 'confirm-remove' }, 'Remove'),
                el('button', { type: 'button', class: 'oc-btn oc-btn--ghost', 'data-act': 'cancel' }, 'Cancel')));

        const status = el('div', { class: 'sw-status', id: statusId, role: 'status' });
        root.append(savedView, editView, confirmView, status);

        function setMode(next, { focus = false } = {}) {
            mode = next;
            savedView.hidden = mode !== 'saved';
            editView.hidden = mode !== 'edit';
            confirmView.hidden = mode !== 'confirm';
            cancelButton.hidden = !current.set;
            input.placeholder = current.set ? 'Paste a new key' : 'Paste your key';
            if (mode === 'confirm') {
                confirmText.textContent = `Remove the saved ${name()}? It is deleted from this computer.`;
            }
            if (!focus) return;
            if (mode === 'edit') input.focus();
            else if (mode === 'confirm') confirmView.querySelector('[data-act="cancel"]').focus();
            else savedView.querySelector('[data-act="replace"]').focus();
        }

        function render() {
            maskText.textContent = current.last4 ? `•••• ${current.last4} (saved)` : '•••••••• (saved)';
            if (!current.set) setMode('edit');
            else if (mode === 'confirm') setMode('confirm');
            else setMode(replacing || input.value ? 'edit' : 'saved');
        }

        function hideKey() {
            input.type = 'password';
            reveal.setAttribute('aria-pressed', 'false');
            reveal.setAttribute('aria-label', 'Show key');
            reveal.title = 'Show key';
            reveal.replaceChildren(icon('eye'));
        }

        async function saveKey() {
            const value = input.value.trim();
            if (!value) {
                markInvalid(input, true);
                setStatus(status, 'error', 'Paste a key first.', { sticky: true });
                input.focus();
                return;
            }
            if (/\s/.test(value)) {
                markInvalid(input, true);
                setStatus(status, 'error', 'Keys cannot contain spaces. Check that you copied the whole key and nothing else.', { sticky: true });
                return;
            }
            const savingField = field;
            saveButton.disabled = true;
            const result = await save({ [savingField]: value }, { status, input, okText: 'Key saved', key: savingField });
            saveButton.disabled = false;
            // The control moved to another provider meanwhile.
            if (savingField !== field) return;
            if (result.stale || !result.ok) return;
            input.value = '';
            hideKey();
            replacing = false;
            current = { set: true, last4: value.length >= 12 ? value.slice(-4) : '' };
            setMode('saved', { focus: root.contains(document.activeElement) });
            if (onChange) onChange();
        }

        async function removeKey() {
            if (!api || !api.removeSecret) return;
            setStatus(status, 'busy', 'Removing…');
            let result;
            try {
                result = await api.removeSecret(field);
            } catch (_) {
                result = { success: false, error: 'Could not remove the key. Try again.' };
            }
            if (result && result.success) {
                current = { set: false, last4: '' };
                setMode('edit', { focus: true });
                if (result.warning) setStatus(status, 'warn', result.warning, { sticky: true });
                else setStatus(status, 'ok', 'Key removed');
            } else {
                setMode('saved', { focus: true });
                setStatus(status, 'error', (result && result.error) || 'Could not remove the key. Try again.', { sticky: true });
            }
            if (onChange) onChange();
        }

        root.addEventListener('click', (e) => {
            const button = e.target.closest('[data-act]');
            if (!button) return;
            const act = button.dataset.act;
            if (act === 'replace') {
                replacing = true;
                setStatus(status, '', '');
                setMode('edit', { focus: true });
            } else if (act === 'remove') {
                setStatus(status, '', '');
                setMode('confirm', { focus: true });
            } else if (act === 'confirm-remove') {
                removeKey();
            } else if (act === 'cancel') {
                replacing = false;
                input.value = '';
                hideKey();
                markInvalid(input, false);
                setStatus(status, '', '');
                setMode(current.set ? 'saved' : 'edit', { focus: true });
            } else if (act === 'save') {
                saveKey();
            } else if (act === 'reveal') {
                const show = input.type === 'password';
                if (!show) {
                    hideKey();
                } else {
                    input.type = 'text';
                    reveal.setAttribute('aria-pressed', 'true');
                    reveal.setAttribute('aria-label', 'Hide key');
                    reveal.title = 'Hide key';
                    reveal.replaceChildren(icon('eye-slash'));
                }
                input.focus();
            }
        });

        input.addEventListener('keydown', (e) => {
            if (composing(e)) return;
            if (e.key === 'Enter') {
                e.preventDefault();
                saveKey();
            } else if (e.key === 'Escape' && current.set) {
                // Esc backs out of replacing instead of closing the window.
                e.preventDefault();
                e.stopPropagation();
                root.querySelector('[data-act="cancel"]').click();
            }
        });
        input.addEventListener('input', () => {
            markInvalid(input, false);
            if (input.value.trim()) setStatus(status, 'info', 'Not saved yet. Press Enter or choose Save key.', { sticky: true });
            else setStatus(status, '', '');
        });
        confirmView.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setMode('saved', { focus: true });
            }
        });

        return {
            /** Point the control at `nextField` (switching providers drops any typed key). */
            setField(nextField, maskedValue) {
                if (nextField !== field) {
                    field = nextField;
                    replacing = false;
                    input.value = '';
                    hideKey();
                    markInvalid(input, false);
                    setStatus(status, '', '');
                    mode = 'edit';
                }
                current = maskedValue || { set: false, last4: '' };
                render();
            },
            draft: () => input.value.trim()
        };
    }

    // ---------- About you and interview context (profile.json) ----------
    //
    // Both pages edit one profile, saved as a whole. Each group shows the
    // save state for its own edits; editing stays off until the saved
    // profile has loaded, so a failed load can never overwrite it.

    const profileInputs = Array.from(document.querySelectorAll('[data-profile-field]'));
    const aboutInputs = profileInputs.filter((input) => input.closest('[data-section="you"]'));
    const profileLoadErrors = Array.from(document.querySelectorAll('[data-profile-load-error]'));
    const profileRetryButtons = Array.from(document.querySelectorAll('[data-profile-retry]'));
    let profileLoaded = false;
    let profileLoading = false;
    let profileDirty = false;
    let profileTimer = null;
    let profileSaving = null;
    // Shown with the next "saved" state, e.g. that pasted text was cut.
    let profileNotice = '';
    let profileSeq = 0;
    // Group status elements with edits whose save has not reported yet.
    const profileStatusTargets = new Set();

    const groupStatusOf = (input) => {
        const group = input && input.closest('.sw-group');
        return group ? group.querySelector('[data-profile-status]') : null;
    };

    function updateCount(input) {
        const counter = document.querySelector(`[data-count-for="${input.id}"]`);
        if (!counter) return;
        const limit = Number(input.getAttribute('maxlength')) || 0;
        const length = input.value.length;
        counter.textContent = limit ? `${length.toLocaleString()} / ${limit.toLocaleString()}` : '';
        counter.classList.toggle('is-near', limit > 0 && length >= limit * 0.9);
    }

    function setProfileEditable(editable) {
        profileInputs.forEach((input) => { input.disabled = !editable; });
        updateClearButton();
    }

    async function loadProfile() {
        if (profileDirty || profileLoading) return;
        profileLoading = true;
        profileRetryButtons.forEach((button) => { button.disabled = true; });
        try {
            if (!api || !api.getProfile) throw new Error('unavailable');
            const result = await api.getProfile();
            // Edits made while loading win; they save on their own.
            if (profileDirty) return;
            if (!result || !result.success || !result.profile || typeof result.profile !== 'object') {
                throw new Error('failed');
            }
            const limits = { ...(result.limits || {}), ...(result.aboutLimits || {}) };
            profileInputs.forEach((input) => {
                const field = input.dataset.profileField;
                if (input.tagName !== 'SELECT' && Number(limits[field]) > 0) {
                    input.setAttribute('maxlength', String(limits[field]));
                }
                const value = typeof result.profile[field] === 'string' ? result.profile[field] : '';
                input.value = value;
                // A value this page has no option for shows as "not set".
                if (input.tagName === 'SELECT' && input.value !== value) input.value = '';
                markInvalid(input, false);
                updateCount(input);
            });
            profileLoaded = true;
            profileLoadErrors.forEach((banner) => { banner.hidden = true; });
            hideClearConfirm();
            setProfileEditable(true);
        } catch (_) {
            // After a good load the fields already match what is saved.
            if (!profileLoaded) {
                setProfileEditable(false);
                profileLoadErrors.forEach((banner) => { banner.hidden = false; });
            }
        } finally {
            profileLoading = false;
            profileRetryButtons.forEach((button) => { button.disabled = false; });
        }
    }

    /**
     * Save the whole profile if anything changed. Resolves to { ok: true },
     * { ok: false, error }, or null when a newer save took over.
     */
    function saveProfile() {
        clearTimeout(profileTimer);
        profileTimer = null;
        if (!profileDirty) return profileSaving || Promise.resolve({ ok: true });
        if (!profileLoaded || !api || !api.saveProfile) {
            profileStatusTargets.forEach((node) => setStatus(node, 'error', `Not saved: ${SAVE_FAILED}`, { sticky: true }));
            return Promise.resolve({ ok: false, error: SAVE_FAILED });
        }
        profileDirty = false;
        const seq = ++profileSeq;
        const profile = {};
        profileInputs.forEach((input) => { profile[input.dataset.profileField] = input.value; });
        profileStatusTargets.forEach((node) => setStatus(node, 'busy', 'Saving…'));
        const run = (async () => {
            let result;
            try {
                result = await api.saveProfile(profile);
            } catch (_) {
                result = { success: false, error: SAVE_FAILED };
            }
            // Only the newest save reports; newer edits save again anyway.
            if (seq !== profileSeq || profileDirty) return null;
            const targets = Array.from(profileStatusTargets);
            profileStatusTargets.clear();
            profileInputs.forEach((input) => markInvalid(input, false));
            if (result && result.success) {
                if (profileNotice) {
                    targets.forEach((node) => setStatus(node, 'warn', `Saved. ${profileNotice}`, { sticky: true }));
                    profileNotice = '';
                } else {
                    targets.forEach((node) => setStatus(node, 'ok', 'All changes saved'));
                }
                return { ok: true };
            }
            const message = (result && result.error) || SAVE_FAILED;
            const bad = result && result.field ? profileInputs.find((i) => i.dataset.profileField === result.field) : null;
            markInvalid(bad, true);
            // The group with the bad field says why too, wherever the edit was.
            const badStatus = groupStatusOf(bad);
            if (badStatus && !targets.includes(badStatus)) targets.push(badStatus);
            targets.forEach((node) => setStatus(node, 'error', `Not saved: ${message}`, { sticky: true }));
            // Try again on the next edit, and report there again.
            targets.forEach((node) => profileStatusTargets.add(node));
            profileDirty = true;
            return { ok: false, error: message };
        })();
        const tracked = run.finally(() => { if (profileSaving === tracked) profileSaving = null; });
        profileSaving = tracked;
        return tracked;
    }

    profileInputs.forEach((input) => {
        input.addEventListener('input', () => {
            profileDirty = true;
            updateCount(input);
            updateClearButton();
            const status = groupStatusOf(input);
            if (status) {
                profileStatusTargets.add(status);
                setStatus(status, 'info', 'Editing…');
            }
            clearTimeout(profileTimer);
            profileTimer = setTimeout(saveProfile, 800);
        });
        input.addEventListener('change', saveProfile);
        if (input.tagName === 'SELECT') return;
        // maxlength cuts pasted text silently; say so.
        input.addEventListener('paste', (e) => {
            const limit = Number(input.getAttribute('maxlength')) || 0;
            const pasted = e.clipboardData ? e.clipboardData.getData('text') : '';
            const selected = Math.abs((input.selectionEnd || 0) - (input.selectionStart || 0));
            const room = limit - (input.value.length - selected);
            if (limit && pasted.length > room) {
                profileNotice = `Pasted text was cut to fit the ${limit.toLocaleString()}-character limit.`;
            }
        });
    });

    profileRetryButtons.forEach((button) => button.addEventListener('click', loadProfile));

    // ---------- About you: Clear all ----------

    const clearButton = $('youClear');
    const clearConfirm = $('youClearConfirm');
    const clearStatus = $('youClearStatus');

    function updateClearButton() {
        clearButton.disabled = !profileLoaded || !aboutInputs.some((input) => input.value.trim());
        clearButton.title = clearButton.disabled && profileLoaded ? 'Nothing to clear' : '';
    }

    function hideClearConfirm({ focus = false } = {}) {
        if (clearConfirm.hidden) return;
        clearConfirm.hidden = true;
        clearButton.hidden = false;
        if (focus && !clearButton.disabled) clearButton.focus();
    }

    async function clearAbout() {
        hideClearConfirm();
        const before = aboutInputs.map((input) => input.value);
        aboutInputs.forEach((input) => {
            input.value = '';
            markInvalid(input, false);
            updateCount(input);
        });
        profileDirty = true;
        updateClearButton();
        setStatus(clearStatus, 'busy', 'Clearing…');
        const result = await saveProfile();
        if (result && result.ok) {
            setStatus(clearStatus, 'ok', 'Your details were cleared');
            aboutInputs[0].focus();
            return;
        }
        if (!result) {
            // Something was typed meanwhile; that save reports instead.
            setStatus(clearStatus, '', '');
            return;
        }
        // Put the details back unless something was typed since.
        if (aboutInputs.every((input) => !input.value)) {
            aboutInputs.forEach((input, i) => {
                input.value = before[i];
                updateCount(input);
            });
        }
        updateClearButton();
        setStatus(clearStatus, 'error', `Not cleared: ${result.error}`, { sticky: true });
        if (!clearButton.disabled) clearButton.focus();
    }

    clearButton.addEventListener('click', () => {
        if (clearButton.disabled) return;
        setStatus(clearStatus, '', '');
        clearButton.hidden = true;
        clearConfirm.hidden = false;
        $('youClearNo').focus();
    });
    $('youClearNo').addEventListener('click', () => hideClearConfirm({ focus: true }));
    $('youClearYes').addEventListener('click', clearAbout);
    clearConfirm.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // Esc backs out of clearing instead of closing the window.
            e.preventDefault();
            e.stopPropagation();
            hideClearConfirm({ focus: true });
        }
    });

    setProfileEditable(false);

    // ---------- Voice ----------

    const speechRadios = Array.from(document.querySelectorAll('input[name="speechProvider"]'));
    const engineRadios = Array.from(document.querySelectorAll('input[name="voiceEngine"]'));
    const pythonRows = Array.from(document.querySelectorAll('[data-engine="python"]'));
    const modelList = $('voiceModelList');

    const RELEASES_URL = 'https://github.com/ankit1324/cuewell/releases/latest';
    const OFFLINE_TEXT = 'You are offline. Connect to the internet, then retry.';
    const OLD_BUILD_TEXT = 'This version of Cuewell cannot set up local voice. Install the latest release.';
    // How the built-in models read here; main's label covers any other id.
    const MODEL_TEXT = {
        'small-q5_1': { name: 'Small', tag: 'Recommended', note: 'Best for Hindi and Hinglish' },
        'base-q5_1': { name: 'Base', tag: '', note: 'Faster, smaller' }
    };
    // A Cancel this soon after Download is a double click, not a choice.
    const CANCEL_GRACE_MS = 600;
    // A cancel main never confirms gives the Cancel button back.
    const CANCEL_STUCK_MS = 10000;

    const voice = {
        // Last get-voice-status answer: { engine, binaryAvailable, platformSupported,
        // models: [{ id, label, bytes, downloaded }], selectedModel, language, pythonConfigured }
        status: null,
        error: '',
        checkedAt: 0,
        // id -> { phase: 'downloading' | 'cancelling' | 'cancelled' | 'failed', received, total, error }
        downloads: {},
        // The one download running, if any.
        activeId: null,
        // An engine or model change is being saved.
        selecting: false
    };

    const hasApi = (name) => !!(api && typeof api[name] === 'function');

    function speechProvider() {
        return (state.settings && state.settings.speechProvider) || 'whisper';
    }

    const voiceModels = () => (voice.status ? voice.status.models : []);
    const findModel = (id) => voiceModels().find((m) => m.id === id) || null;
    const modelName = (m) => (m && MODEL_TEXT[m.id] ? MODEL_TEXT[m.id].name : (m && m.label) || 'the model');
    const usingPython = () => !!voice.status && voice.status.engine === 'python';
    const builtInRuns = () => !!voice.status && voice.status.platformSupported !== false && !!voice.status.binaryAvailable;

    /** Bytes as decimal megabytes: 190085487 -> "190 MB", or "190.1 MB" with digits 1. */
    function formatMB(bytes, digits = 0) {
        const mb = Math.max(0, Number(bytes) || 0) / 1e6;
        return `${mb.toFixed(digits)} MB`;
    }

    /** "45.2 MB of 190.1 MB · 23%", or "45.2 MB" while the size is unknown. */
    function progressText(received, total) {
        if (!(total > 0)) return formatMB(received, 1);
        return `${formatMB(received, 1)} of ${formatMB(total, 1)} · ${progressPercent(received, total)}%`;
    }

    function progressPercent(received, total) {
        if (!(total > 0)) return 0;
        return Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
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
            language: typeof raw.language === 'string' ? raw.language : '',
            pythonConfigured: !!raw.pythonConfigured
        };
    }

    function renderVoice() {
        const s = state.settings;
        if (!s) return;
        const provider = speechProvider();
        speechRadios.forEach((radio) => { radio.checked = radio.value === provider; });
        $('whisperGroup').hidden = provider !== 'whisper';
        $('azureGroup').hidden = provider !== 'azure';
        azureKey.setField('azureKey', masked('azureKey'));

        // CUDA needs an NVIDIA GPU, which Macs do not have (Python Whisper only).
        const cuda = $('whisperDevice').querySelector('option[value="cuda"]');
        if (cuda) cuda.disabled = isMac() && $('whisperDevice').value !== 'cuda';
        if (isMac()) $('whisperDeviceHelp').textContent = 'Macs have no NVIDIA GPU, so Whisper runs on the CPU. Auto and CPU are the same here.';

        renderLocalVoice();
        renderVoiceBanner();
        if (provider === 'whisper' && state.section === 'voice' && !state.query) maybeCheckVoice();
    }

    /** What stops built-in voice here, as { kind, title, sub }, or null. */
    function localVoiceProblem() {
        const st = voice.status;
        if (!hasApi('getVoiceStatus')) {
            return { kind: 'error', title: 'Local voice cannot be set up here', sub: ['This version of Cuewell cannot set it up. Install the latest release from ', externalLink('the release page', RELEASES_URL), '.'] };
        }
        if (!st) {
            return voice.error ? { kind: 'error', title: 'Could not check local voice', sub: `${voice.error} Choose Check again.` } : null;
        }
        const python = st.engine === 'python';
        if (st.platformSupported === false) {
            return { kind: 'warn', title: 'Built-in voice does not run on this system',
                sub: python ? 'Your Python Whisper setup keeps working. Azure Speech also works here.' : 'Use Azure Speech instead.' };
        }
        if (!st.binaryAvailable) {
            const link = externalLink('the release download', RELEASES_URL);
            return { kind: 'warn', title: 'Voice is not available in this build',
                sub: python
                    ? ['Your Python Whisper setup keeps working. For built-in voice, install Cuewell from ', link, '.']
                    : ['To use it, install Cuewell from ', link, '. Azure Speech also works.'] };
        }
        return null;
    }

    function renderLocalVoice() {
        const st = voice.status;
        const python = usingPython();
        const problem = localVoiceProblem();

        $('voiceEngineName').textContent = python ? 'Python Whisper (advanced)' : 'Built-in (whisper.cpp)';
        // Python Whisper shows only for setups that already have it.
        $('voiceEngineRow').hidden = !st || !(st.pythonConfigured || python);
        engineRadios.forEach((radio) => {
            radio.checked = radio.value === (python ? 'python' : 'whispercpp');
            // Built-in cannot be chosen where it cannot run.
            radio.disabled = voice.selecting || (radio.value === 'whispercpp' && python && !builtInRuns());
        });
        pythonRows.forEach((row) => { row.hidden = !python; });

        $('voiceUnavailableRow').hidden = !problem;
        if (problem) {
            $('voiceUnavailableDot').className = `oc-dot oc-dot--${problem.kind}`;
            fill($('voiceUnavailableText'), el('strong', null, problem.title), el('span', { class: 'sw-state-sub' }, problem.sub));
        }
        // Models show while checking and when built-in voice can run.
        $('voiceModelRow').hidden = !!problem;
        if (!problem) renderModels();
    }

    function emptyModels(text) {
        delete modelList.dataset.ids;
        fill(modelList, el('div', { class: 'sw-state sw-models-empty', role: 'status' },
            el('span', { class: 'oc-dot', 'aria-hidden': 'true' }),
            el('span', { class: 'sw-state-text' }, text)));
    }

    function renderModels() {
        const models = voiceModels();
        if (!models.length) {
            emptyModels(voice.status ? 'No voice models are listed in this build.' : 'Checking voice setup…');
            return;
        }
        // Build the cards once, then update them in place so focus stays put.
        const ids = models.map((m) => m.id).join('|');
        if (modelList.dataset.ids !== ids) {
            modelList.dataset.ids = ids;
            modelList.replaceChildren(...models.map(buildModelCard));
        }
        Array.from(modelList.querySelectorAll('.sw-model')).forEach((card) => {
            const m = findModel(card.dataset.model);
            if (m) updateModelCard(card, m);
        });
        fill($('voiceModelHelp'), usingPython()
            ? 'Downloads once, then works offline. Choosing a downloaded model switches to Built-in.'
            : 'Downloads once, then works offline. Choose a downloaded model to use it.');
    }

    function buildModelCard(m, index) {
        const text = MODEL_TEXT[m.id] || { name: m.label, tag: '', note: '' };
        const radioId = `voiceModel${index}`;
        return el('div', { class: 'sw-model', 'data-model': m.id },
            el('label', { class: 'sw-model-pick', for: radioId },
                el('input', { type: 'radio', name: 'voiceModel', id: radioId, value: m.id, 'aria-describedby': `${radioId}State` }),
                el('span', { class: 'sw-model-ring', 'aria-hidden': 'true' }),
                el('span', { class: 'sw-model-text' },
                    el('span', { class: 'sw-model-name' }, text.name,
                        text.tag ? el('span', { class: 'oc-chip oc-chip--accent sw-model-tag' }, text.tag) : null),
                    el('span', { class: 'sw-model-desc' }, [text.note, m.bytes ? formatMB(m.bytes) : ''].filter(Boolean).join(' · ')))),
            el('div', { class: 'sw-model-side' },
                el('span', { class: 'sw-model-state', id: `${radioId}State` }),
                el('button', { type: 'button', class: 'oc-btn', 'data-act': 'download' })),
            el('div', { class: 'sw-model-progress', hidden: true },
                el('div', { class: 'sw-meter', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `Downloading ${text.name}` }, el('span')),
                el('span', { class: 'sw-model-progress-text', 'aria-hidden': 'true' })),
            el('div', { class: 'sw-status', role: 'status' }));
    }

    function setActionButton(button, act, glyph, label, { disabled = false, title = '' } = {}) {
        button.hidden = !act;
        if (!act) return;
        // Same button, new action: keyboard focus stays on it.
        if (button.dataset.act !== act || button.dataset.label !== label) {
            button.dataset.act = act;
            button.dataset.label = label;
            button.replaceChildren(icon(glyph, glyph === 'circle-notch' ? 'fa-spin-fast' : ''), el('span', null, label));
        }
        button.disabled = disabled;
        button.title = title;
    }

    /** Set a card's message only when it changes, so it is announced once. */
    function setCardMessage(card, kind, text) {
        const node = card.querySelector(':scope > .sw-status');
        const key = `${kind}:${text}`;
        if (node.dataset.message === key) return;
        node.dataset.message = key;
        setStatus(node, kind, text, { sticky: true });
    }

    function updateModelCard(card, m) {
        const d = voice.downloads[m.id] || null;
        const phase = d ? d.phase : '';
        const running = phase === 'downloading' || phase === 'cancelling';
        const selected = !usingPython() && voice.status.selectedModel === m.id;
        const radio = card.querySelector('input[name="voiceModel"]');
        radio.checked = selected;
        radio.disabled = !m.downloaded || voice.selecting;
        card.classList.toggle('is-selected', selected && m.downloaded);

        const stateNode = card.querySelector('.sw-model-state');
        stateNode.classList.toggle('is-ok', m.downloaded);
        if (m.downloaded) fill(stateNode, icon('circle-check'), selected ? 'Ready, in use' : 'Ready');
        else if (running) fill(stateNode, 'Downloading');
        else fill(stateNode, 'Not downloaded');

        const button = card.querySelector('button[data-act]');
        const otherRunning = !!voice.activeId && voice.activeId !== m.id;
        if (m.downloaded) setActionButton(button, null);
        else if (phase === 'downloading') setActionButton(button, 'cancel', 'xmark', 'Cancel');
        else if (phase === 'cancelling') setActionButton(button, 'cancel', 'circle-notch', 'Cancelling…', { disabled: true });
        else if (phase === 'failed') setActionButton(button, 'retry', 'rotate-right', 'Retry', { disabled: otherRunning, title: otherRunning ? 'Wait for the other download to finish' : '' });
        else setActionButton(button, 'download', 'download', 'Download', { disabled: otherRunning, title: otherRunning ? 'Wait for the other download to finish' : '' });

        if (phase === 'failed') setCardMessage(card, 'error', d.error);
        else if (phase === 'cancelled') setCardMessage(card, 'info', 'Download cancelled.');
        else if (selected && !m.downloaded && !running) setCardMessage(card, 'info', `Download ${modelName(m)} to turn on voice input.`);
        else setCardMessage(card, '', '');

        paintProgress(card, running ? d : null);
    }

    function paintProgress(card, d) {
        const box = card.querySelector('.sw-model-progress');
        box.hidden = !d;
        if (!d) return;
        const percent = progressPercent(d.received, d.total);
        const text = progressText(d.received, d.total);
        const meter = box.querySelector('.sw-meter');
        meter.setAttribute('aria-valuenow', String(percent));
        meter.setAttribute('aria-valuetext', text);
        meter.firstElementChild.style.width = `${percent}%`;
        box.querySelector('.sw-model-progress-text').textContent = text;
    }

    const cardFor = (id) => Array.from(modelList.querySelectorAll('.sw-model')).find((card) => card.dataset.model === id) || null;

    // Low-level network and disk errors, in plain words.
    const NETWORK_ERROR = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up|network)\b/i;
    const DISK_FULL_ERROR = /\b(ENOSPC|EDQUOT)\b/;

    function downloadError(raw) {
        if (navigator.onLine === false) return OFFLINE_TEXT;
        const text = firstLine(raw);
        if (DISK_FULL_ERROR.test(text)) return 'There is not enough free disk space. Free up some space, then retry.';
        if (!text || NETWORK_ERROR.test(text)) return 'Could not reach the download server. Check your internet connection, then retry.';
        return text;
    }

    async function startVoiceDownload(id) {
        const m = findModel(id);
        if (!m || voice.activeId || m.downloaded) return;
        setStatus($('voiceModelStatus'), '', '');
        if (!hasApi('downloadVoiceModel')) {
            voice.downloads[id] = { phase: 'failed', error: OLD_BUILD_TEXT };
            renderModels();
            return;
        }
        if (navigator.onLine === false) {
            voice.downloads[id] = { phase: 'failed', error: OFFLINE_TEXT };
            renderModels();
            return;
        }
        const d = { phase: 'downloading', received: 0, total: m.bytes, startedAt: Date.now(), frame: 0 };
        voice.downloads[id] = d;
        voice.activeId = id;
        renderModels();
        $('srAnnounce').textContent = `Downloading ${modelName(m)}`;
        let result;
        try {
            result = await api.downloadVoiceModel(id);
        } catch (_) {
            result = { success: false, error: '' };
        }
        if (voice.activeId === id) voice.activeId = null;
        if (d.frame) cancelAnimationFrame(d.frame);
        if (result && result.success) {
            delete voice.downloads[id];
            // A check during the download may have replaced the status.
            const current = findModel(id);
            if (current) current.downloaded = true;
            $('srAnnounce').textContent = `${modelName(m)} is ready`;
            renderLocalVoice();
            await adoptDownloadedModel(id);
        } else if (d.phase === 'cancelling') {
            voice.downloads[id] = { phase: 'cancelled' };
            $('srAnnounce').textContent = 'Download cancelled';
            renderModels();
        } else {
            voice.downloads[id] = { phase: 'failed', error: downloadError(result && result.error) };
            $('srAnnounce').textContent = `${modelName(m)} did not download`;
            renderModels();
        }
        refocusCard(id);
        refreshVoiceStatus();
    }

    /** The focused button went away or was disabled: put focus back on its card. */
    function refocusCard(id) {
        const card = cardFor(id);
        if (!card) return;
        // Chromium moves focus off a hidden or disabled button a frame later.
        const active = document.activeElement;
        const lost = !active || active === document.body ||
            (card.contains(active) && (active.hidden || active.disabled));
        if (!lost) return;
        const target = card.querySelector('button[data-act]:not([hidden]):not(:disabled)') ||
            card.querySelector('input[name="voiceModel"]:not(:disabled)');
        if (target) target.focus({ preventScroll: true });
    }

    async function cancelVoiceDownload(id) {
        const d = voice.downloads[id];
        if (!d || d.phase !== 'downloading' || Date.now() - d.startedAt < CANCEL_GRACE_MS) return;
        if (!hasApi('cancelVoiceModelDownload')) {
            setStatus($('voiceModelStatus'), 'error', 'This version of Cuewell cannot cancel the download. It keeps going.', { sticky: true });
            return;
        }
        d.phase = 'cancelling';
        renderModels();
        setTimeout(() => {
            if (voice.downloads[id] === d && d.phase === 'cancelling') {
                d.phase = 'downloading';
                renderModels();
            }
        }, CANCEL_STUCK_MS);
        try {
            await api.cancelVoiceModelDownload(id);
        } catch (_) { /* the download's own result reports */ }
    }

    /** A finished download is used right away unless another ready model is. */
    async function adoptDownloadedModel(id) {
        const st = voice.status;
        if (!st || st.engine === 'python') return;
        const current = findModel(st.selectedModel);
        if (current && current.downloaded && current.id !== id) return;
        const m = findModel(id);
        await changeVoiceEngine('whispercpp', id, $('voiceModelStatus'), `Voice input uses ${modelName(m)}`);
    }

    /** Save the engine (and model) through main. Resolves to true on success. */
    async function changeVoiceEngine(engine, model, statusNode, okText) {
        if (!hasApi('setVoiceEngine')) {
            setStatus(statusNode, 'error', OLD_BUILD_TEXT, { sticky: true });
            renderLocalVoice();
            return false;
        }
        voice.selecting = true;
        renderLocalVoice();
        setStatus(statusNode, 'busy', 'Saving…');
        let result;
        try {
            result = await api.setVoiceEngine(engine, model);
        } catch (_) {
            result = { success: false, error: SAVE_FAILED };
        }
        voice.selecting = false;
        const ok = !!(result && result.success);
        if (ok) {
            if (voice.status) {
                voice.status.engine = engine;
                if (model) voice.status.selectedModel = model;
            }
            setStatus(statusNode, 'ok', okText);
        } else {
            setStatus(statusNode, 'error', (result && result.error) || SAVE_FAILED, { sticky: true });
        }
        renderLocalVoice();
        renderVoiceBanner();
        if (ok) {
            refreshVoiceStatus();
            loadSettings({ quiet: true });
            if (engine === 'python') {
                state.whisperCheckedAt = 0;
                refreshWhisperStatus();
            }
        }
        return ok;
    }

    engineRadios.forEach((radio) => {
        radio.addEventListener('change', () => {
            if (!radio.checked || !voice.status || radio.value === voice.status.engine) return;
            const engine = radio.value;
            changeVoiceEngine(engine, engine === 'whispercpp' ? voice.status.selectedModel || undefined : undefined,
                $('voiceEngineStatus'), engine === 'python' ? 'Using Python Whisper' : 'Using built-in voice');
        });
    });

    modelList.addEventListener('change', (e) => {
        const radio = e.target.closest('input[name="voiceModel"]');
        if (!radio || !radio.checked) return;
        const m = findModel(radio.value);
        if (!m || !m.downloaded) return;
        const switching = usingPython();
        changeVoiceEngine('whispercpp', m.id, $('voiceModelStatus'),
            switching ? `Using built-in voice with ${modelName(m)}` : `Voice input uses ${modelName(m)}`);
    });

    modelList.addEventListener('click', (e) => {
        const button = e.target.closest('button[data-act]');
        const card = button && button.closest('.sw-model');
        if (!card || button.disabled) return;
        if (button.dataset.act === 'cancel') cancelVoiceDownload(card.dataset.model);
        else startVoiceDownload(card.dataset.model);
    });

    if (hasApi('onVoiceModelProgress')) {
        api.onVoiceModelProgress((data) => {
            if (!data || typeof data.id !== 'string') return;
            const d = voice.downloads[data.id];
            if (!d || (d.phase !== 'downloading' && d.phase !== 'cancelling')) return;
            const received = Number(data.received);
            const total = Number(data.total);
            if (Number.isFinite(received) && received >= 0) d.received = received;
            if (Number.isFinite(total) && total > 0) d.total = total;
            // At most one repaint per frame, however often main reports.
            if (d.frame) return;
            d.frame = requestAnimationFrame(() => {
                d.frame = 0;
                const card = cardFor(data.id);
                if (card && voice.downloads[data.id] === d) paintProgress(card, d);
            });
        });
    }

    function maybeCheckVoice() {
        if (Date.now() - voice.checkedAt < 30000) return;
        refreshVoiceStatus();
    }

    let voiceCheckToken = 0;
    async function refreshVoiceStatus() {
        if (!hasApi('getVoiceStatus')) {
            renderLocalVoice();
            renderVoiceBanner();
            return;
        }
        const token = ++voiceCheckToken;
        voice.checkedAt = Date.now();
        $('voiceRecheck').disabled = true;
        let status = null;
        try {
            const raw = await api.getVoiceStatus();
            if (raw && typeof raw === 'object') status = cleanVoiceStatus(raw);
        } catch (_) { /* reported below */ }
        if (token !== voiceCheckToken) return;
        $('voiceRecheck').disabled = false;
        if (status) {
            voice.status = status;
            voice.error = '';
            setStatus($('voiceModelStatus'), '', '');
        } else if (voice.status) {
            // Keep what the last good check showed, and say this one failed.
            setStatus($('voiceModelStatus'), 'error', 'Could not check local voice. Choose Check again.', { sticky: true });
        } else {
            voice.error = 'The check did not finish.';
        }
        renderLocalVoice();
        renderVoiceBanner();
        if (usingPython()) maybeCheckWhisper();
    }

    function localVoiceOffMessage() {
        const st = voice.status;
        if (!hasApi('getVoiceStatus')) return `Voice input is off. ${OLD_BUILD_TEXT}`;
        if (!st) return voice.error ? 'Voice input is off: Cuewell could not check local voice. Choose Check again below.' : 'Checking local voice…';
        if (st.engine === 'python') return 'Voice input is off: Cuewell cannot run your Python Whisper. Check the Whisper command below, or switch to Built-in.';
        if (st.platformSupported === false) return 'Voice input is off: built-in voice does not run on this system. Use Azure Speech instead.';
        if (!st.binaryAvailable) return 'Voice input is off: voice is not available in this build. Install Cuewell from the release download to use it.';
        const selected = findModel(st.selectedModel);
        if (!selected || !selected.downloaded) return 'Voice input is off until you download a voice model below.';
        return 'Voice input is not on yet. If this message stays, choose Check again below, or restart Cuewell.';
    }

    function renderVoiceBanner() {
        const s = state.settings;
        const banner = $('voiceBanner');
        const iconNode = $('voiceBannerIcon');
        const text = $('voiceBannerText');
        if (!s) return;
        const keys = isMac() ? 'Option+R' : 'Alt+R';
        const provider = speechProvider();
        let kind;
        let message;
        if (s.speechAvailable) {
            kind = 'ok';
            message = `Voice input is ready. Press ${keys} or Listen on the toolbar.`;
        } else if (provider === 'azure') {
            kind = 'warn';
            message = s.azureConfigured
                ? 'Voice input is off: Azure Speech could not start. Check the key and region.'
                : 'Voice input is off until you add your Azure Speech key and region.';
        } else {
            kind = 'warn';
            message = localVoiceOffMessage();
        }
        if (platform() === 'linux' && provider === 'whisper') {
            message += ' On Linux, recording also needs arecord or sox.';
        }
        banner.className = `sw-banner sw-banner--${kind}`;
        iconNode.className = `fas fa-${kind === 'ok' ? 'circle-check' : 'triangle-exclamation'}`;
        text.textContent = message;
        banner.hidden = false;
    }

    async function saveSpeechProvider(value) {
        if (!state.settings || value === speechProvider()) return;
        const previous = speechProvider();
        state.settings.speechProvider = value;
        renderVoice();
        const result = await save({ speechProvider: value }, {
            status: $('speechProviderStatus'),
            key: 'speechProvider',
            okText: value === 'azure' ? 'Using Azure Speech' : 'Using local voice'
        });
        if (result.stale) return;
        if (!result.ok) {
            state.settings.speechProvider = previous;
            renderVoice();
            return;
        }
        loadSettings({ quiet: true });
    }

    speechRadios.forEach((radio) => {
        radio.addEventListener('change', () => { if (radio.checked) saveSpeechProvider(radio.value); });
    });

    const azureKey = createSecretField($('azureKeyField'), {
        labelId: 'azureKeyLabel',
        helpId: 'azureKeyHelp',
        name: () => 'Azure Speech key',
        onChange: () => loadSettings({ quiet: true })
    });

    // Python Whisper (advanced): status and model download, while in use.

    function setWhisperProgram(kind, title, sub) {
        $('whisperProgramDot').className = `oc-dot${kind ? ` oc-dot--${kind}` : ''}`;
        const text = $('whisperProgramText');
        fill(text, el('strong', null, title), sub ? el('span', { class: 'sw-state-sub' }, sub) : null);
    }

    function maybeCheckWhisper() {
        if (state.whisperBusy || !usingPython()) return;
        if (Date.now() - state.whisperCheckedAt < 30000) return;
        refreshWhisperStatus();
    }

    let whisperCheckToken = 0;
    async function refreshWhisperStatus() {
        if (!api || !api.getWhisperStatus || state.whisperBusy || !usingPython()) return;
        const token = ++whisperCheckToken;
        state.whisperCheckedAt = Date.now();
        setWhisperProgram('', 'Checking Python Whisper…', '');
        $('whisperModelState').textContent = '';
        $('whisperDownload').hidden = true;
        let status;
        try {
            status = await api.getWhisperStatus();
        } catch (_) {
            status = { found: false, error: 'The check did not finish.' };
        }
        if (token !== whisperCheckToken) return;
        renderWhisperStatus(status || { found: false });
    }

    function renderWhisperStatus(status) {
        if (status.busy) {
            setWhisperProgram('warn', 'Python Whisper is busy', 'A model download is in progress. Check again when it finishes.');
        } else if (status.found) {
            const parts = [status.version ? `Version ${status.version}` : null, status.command].filter(Boolean);
            setWhisperProgram('ok', 'Python Whisper found', parts.join(' · '));
        } else if (status.error) {
            setWhisperProgram('error', 'Could not check Python Whisper', status.error);
        } else {
            setWhisperProgram('warn', 'Cuewell cannot find your Python Whisper',
                'Check the Whisper command below, or switch to Built-in above. Built-in needs no Python.');
        }
        const modelState = $('whisperModelState');
        const download = $('whisperDownload');
        if (!status.found) {
            modelState.classList.remove('is-ok');
            modelState.textContent = 'Needs a working Python Whisper.';
            download.hidden = true;
        } else if (status.modelDownloaded) {
            modelState.replaceChildren(icon('circle-check'), ' Downloaded');
            modelState.classList.add('is-ok');
            download.hidden = true;
        } else {
            modelState.classList.remove('is-ok');
            modelState.textContent = 'Not downloaded yet. It downloads the first time you use voice, or now.';
            download.hidden = false;
        }
    }

    function setWhisperBusy(job) {
        state.whisperBusy = job;
        const busy = !!job;
        $('whisperDownload').disabled = busy;
        $('whisperModel').disabled = busy;
    }

    function withButtonBusy(button, label) {
        const original = Array.from(button.childNodes).map((n) => n.cloneNode(true));
        button.replaceChildren(icon('circle-notch', 'fa-spin-fast'), el('span', null, label));
        return () => button.replaceChildren(...original);
    }

    $('whisperDownload').addEventListener('click', async () => {
        if (state.whisperBusy || !api || !api.downloadWhisperModel) return;
        const model = $('whisperModel').value;
        const button = $('whisperDownload');
        setWhisperBusy('download');
        const restore = withButtonBusy(button, 'Downloading…');
        $('whisperModelState').classList.remove('is-ok');
        $('whisperModelState').textContent = `Downloading ${model}. Large models can take several minutes.`;
        let result;
        try {
            result = await api.downloadWhisperModel(model);
        } catch (_) {
            result = { ok: false, message: 'The download did not finish.' };
        }
        restore();
        setWhisperBusy(null);
        if (result && result.ok) {
            setStatus($('whisperModelStatus'), 'ok', 'Model downloaded');
            state.whisperCheckedAt = 0;
            await refreshWhisperStatus();
        } else {
            const message = (result && result.message) || 'The download failed.';
            setStatus($('whisperModelStatus'), 'error', `Download failed. ${firstLine(message)}`, { sticky: true });
            $('whisperModelState').textContent = 'Not downloaded.';
        }
    });

    $('voiceRecheck').addEventListener('click', () => {
        state.whisperCheckedAt = 0;
        refreshVoiceStatus();
        // Also re-reads whether voice input is on (speechAvailable).
        loadSettings({ quiet: true });
    });

    function firstLine(text) {
        const line = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
        return line.length > 200 ? `${line.slice(0, 200)}…` : line;
    }

    // ---------- Shortcuts, privacy, about (from get-settings-info) ----------

    const KEY_NAMES_MAC = { CommandOrControl: '⌘', Shift: '⇧', Alt: '⌥', Up: '↑', Down: '↓', Left: '←', Right: '→' };
    const KEY_NAMES_PC = { CommandOrControl: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Up: '↑', Down: '↓', Left: '←', Right: '→' };
    const KEY_SPOKEN = { CommandOrControl: null, Shift: 'Shift', Alt: null, Up: 'Up arrow', Down: 'Down arrow', Left: 'Left arrow', Right: 'Right arrow', ',': 'Comma', '\\': 'Backslash' };

    function acceleratorParts(accelerator) {
        // "CommandOrControl+Shift+\" and "CommandOrControl+," split on "+".
        return String(accelerator).split('+').filter(Boolean);
    }

    function keysCell(accelerator) {
        const names = isMac() ? KEY_NAMES_MAC : KEY_NAMES_PC;
        const parts = acceleratorParts(accelerator);
        const spoken = parts.map((part) => {
            if (part === 'CommandOrControl') return isMac() ? 'Command' : 'Control';
            if (part === 'Alt') return isMac() ? 'Option' : 'Alt';
            return KEY_SPOKEN[part] || part;
        }).join(' ');
        return el('span', { class: 'oc-kbd-group', role: 'img', 'aria-label': spoken },
            parts.map((part) => el('span', { class: 'oc-kbd', 'aria-hidden': 'true' }, names[part] || part)));
    }

    function renderInfo() {
        const info = state.info;
        const body = $('shortcutsBody');
        if (!info) {
            body.replaceChildren(el('tr', null, el('td', { colspan: '3' },
                el('span', { class: 'sw-scope is-warn' }, 'The shortcut list could not be loaded. Close and reopen Settings to try again.'))));
            $('aboutVersion').textContent = 'Version unknown';
            renderPrivacy();
            return;
        }

        const rows = (Array.isArray(info.shortcuts) ? info.shortcuts : [])
            .filter((s) => s && typeof s.accelerator === 'string' && s.action)
            .map((s) => {
                let works;
                if (s.registered === false) {
                    works = el('span', { class: 'sw-scope is-warn' }, 'Not working: another app uses these keys');
                } else if (s.scope === 'global') {
                    works = el('span', { class: 'sw-scope is-global' }, 'Everywhere');
                } else {
                    works = el('span', { class: 'sw-scope' }, 'When Cuewell has focus');
                }
                return el('tr', null,
                    el('td', null, s.action),
                    el('td', { class: 'sw-keys' }, keysCell(s.accelerator)),
                    el('td', null, works));
            });
        rows.push(el('tr', null,
            el('td', null, 'Close Settings'),
            el('td', { class: 'sw-keys' }, el('span', { class: 'oc-kbd-group', role: 'img', 'aria-label': 'Escape' },
                el('span', { class: 'oc-kbd', 'aria-hidden': 'true' }, 'Esc'))),
            el('td', null, el('span', { class: 'sw-scope' }, 'In Settings'))));
        body.replaceChildren(...rows);

        $('aboutVersion').textContent = info.version ? `Version ${info.version}` : 'Version unknown';
        const paths = info.paths || {};
        $('aboutEnvPath').textContent = paths.settingsFile || 'Unknown';
        $('aboutProfilePath').textContent = paths.profile || 'Unknown';
        $('aboutLogsPath').textContent = paths.logs || 'Unknown';
        const v = info.versions || {};
        $('aboutRuntime').textContent = [
            v.electron && `Electron ${v.electron}`,
            v.chrome && `Chromium ${v.chrome}`,
            v.node && `Node.js ${v.node}`
        ].filter(Boolean).join(' · ') || 'Unknown';
        renderPrivacy();
    }

    function renderPrivacy() {
        const p = platform();
        const supported = state.info ? !!state.info.contentProtection : (p === 'darwin' || p === 'win32');
        const chip = $('protectionChip');
        chip.className = `oc-chip ${supported ? 'oc-chip--accent' : 'oc-chip--live'}`;
        chip.textContent = supported ? 'On' : 'Not available';
        let text;
        if (supported) {
            text = `${p === 'darwin' ? 'On this Mac' : 'On this PC'}, Cuewell windows are hidden from most screen sharing and recording tools. ` +
                'Some browser-based sharing and older capture methods can still show them, and anyone looking at your screen, or a camera pointed at it, still sees them. ' +
                (p === 'win32' ? 'Windows older than Windows 10 version 2004 shows a black box in their place. ' : '') +
                'Treat it as a convenience, not a guarantee.';
        } else if (p === 'linux') {
            text = 'Not available on Linux. Linux has no way to hide a window from screen capture, so Cuewell windows always show in screen shares and recordings. Hide them with Ctrl+Shift+V before you share your screen.';
        } else {
            text = `Not available on this computer, so Cuewell windows show in screen shares and recordings. Hide them with ${isMac() ? '⌘⇧V' : 'Ctrl+Shift+V'} before you share your screen.`;
        }
        $('protectionText').textContent = text;
        renderKeyStorage();
        document.querySelectorAll('[data-platform-row]').forEach((row) => {
            const first = row.firstElementChild;
            const existing = first.querySelector('.sw-here');
            if (existing) existing.remove();
            if (row.dataset.platformRow === p) first.append(el('span', { class: 'oc-chip sw-here' }, 'This computer'));
        });
    }

    // Where API keys are kept: main sends booleans and labels only, never a key.
    function renderKeyStorage() {
        const storage = state.info && state.info.keyStorage;
        const chip = $('keyStorageChip');
        if (!storage) {
            chip.hidden = true;
            return;
        }
        chip.hidden = false;
        chip.className = `oc-chip ${storage.encrypted ? 'oc-chip--accent' : 'oc-chip--live'}`;
        chip.textContent = storage.encrypted ? 'Encrypted' : 'Not encrypted';
        const parts = [storage.encrypted && storage.label ? `${storage.message} (${storage.label}).` : `${storage.message}.`];
        if (storage.unreadable) {
            parts.push('Keys saved earlier with secure storage cannot be read right now, so new keys go to the settings file. The saved keys are kept and work again once they can be read, for example after you unlock your keyring and restart Cuewell.');
        }
        if (storage.plainTextKeys) {
            parts.push(storage.projectEnv
                ? 'Running from source: keys set in the project .env file are used as written there, in plain text.'
                : storage.encrypted
                    ? 'Some keys are still in the settings file. Cuewell moves them into the keychain when it starts.'
                    : '');
        }
        if (!storage.encrypted && platform() === 'linux') {
            parts.push('To encrypt them, install and unlock a keyring such as GNOME Keyring or KWallet, then restart Cuewell.');
        }
        $('keyStorageText').textContent = parts.filter(Boolean).join(' ');
        $('keysWhereText').textContent = storage.encrypted
            ? 'are encrypted with your system keychain'
            : 'are saved in a file only your user can read';
    }

    // ---------- App icon ----------

    const iconGrid = $('iconGrid');

    function renderIcons() {
        const s = state.settings;
        if (!s) return;
        const raw = s.selectedIcon || s.appIcon || 'cuewell';
        const selected = raw === 'superinterview' ? 'cuewell' : raw;
        iconGrid.querySelectorAll('.sw-icon').forEach((tile) => {
            const checked = tile.dataset.icon === selected;
            tile.setAttribute('aria-checked', String(checked));
            tile.tabIndex = checked ? 0 : -1;
        });
    }

    async function selectIcon(key) {
        if (!state.settings) return;
        const previous = state.settings.selectedIcon;
        if (key === previous) return;
        state.settings.selectedIcon = key;
        renderIcons();
        const tile = iconGrid.querySelector(`[data-icon="${key}"]`);
        const result = await save({ selectedIcon: key }, {
            status: $('selectedIconStatus'),
            key: 'selectedIcon',
            okText: `Using ${tile ? tile.textContent.trim() : 'this icon'}`
        });
        if (result.stale) return;
        if (!result.ok) {
            state.settings.selectedIcon = previous;
            renderIcons();
            return;
        }
        loadSettings({ quiet: true });
    }

    iconGrid.addEventListener('click', (e) => {
        const tile = e.target.closest('.sw-icon');
        if (tile) selectIcon(tile.dataset.icon);
    });
    iconGrid.addEventListener('keydown', (e) => radioKeys(e, iconGrid, '.sw-icon', (tile) => selectIcon(tile.dataset.icon)));
    iconGrid.querySelectorAll('img').forEach((img) => {
        img.addEventListener('error', () => { img.hidden = true; });
    });

    // ---------- Navigation and search ----------

    const nav = $('settingsNav');
    const navItems = Array.from(nav.querySelectorAll('.sw-nav-item'));
    const sections = Array.from(document.querySelectorAll('.sw-section'));
    const searchInput = $('settingsSearch');
    const scroller = $('settingsScroll');
    const root = $('settingsRoot');

    function showSection(name, { focusNav = false } = {}) {
        if (!SECTION_TITLES[name]) return;
        state.section = name;
        if (state.query) clearSearch();
        applyView();
        scroller.scrollTop = 0;
        if (focusNav) {
            const item = navItems.find((i) => i.dataset.nav === name);
            if (item) item.focus();
        }
        if (name === 'voice' && speechProvider() === 'whisper') maybeCheckVoice();
    }

    function applyView() {
        if (!$('loadError').hidden) return;
        const searching = !!state.query;
        root.classList.toggle('is-searching', searching);
        $('sectionTitle').textContent = searching ? 'Search results' : SECTION_TITLES[state.section];
        navItems.forEach((item) => {
            if (!searching && item.dataset.nav === state.section) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });
        if (searching) {
            runSearch();
            return;
        }
        document.querySelectorAll('.sw-filtered').forEach((n) => n.classList.remove('sw-filtered'));
        Object.keys(gateErrors).forEach((gate) => { delete gateErrors[gate]; });
        document.querySelectorAll('[data-gate]').forEach((container) => setGateRevealed(container, false));
        navItems.forEach((item) => {
            item.classList.remove('is-empty');
            item.querySelector('.sw-nav-count').textContent = '';
        });
        sections.forEach((section) => { section.hidden = section.dataset.section !== state.section; });
        $('searchEmpty').hidden = true;
    }

    /**
     * What hides `node` inside its section, apart from the search filter:
     * null when nothing does, the [data-gate] container when only a provider
     * choice does (search still lists those), or false for any other state.
     */
    function hiddenBy(node, section) {
        let gate = null;
        for (let n = node; n && n !== section; n = n.parentElement) {
            if (!n.hidden) continue;
            if (n.dataset.gate && !gate) gate = n;
            else return false;
        }
        return gate;
    }

    // ---------- Search: settings hidden by a provider choice ----------

    // A failed switch from a search note, by gate, until the search changes.
    const gateErrors = {};

    /** The note for a hidden [data-gate] container, or null to leave it out of search. */
    function gateNote(gate) {
        const current = currentProvider();
        const currentName = current ? current.label : 'another provider';
        switch (gate) {
            case 'speech:whisper':
                return {
                    text: 'Used only with local voice. Voice input now uses Azure Speech.',
                    button: 'Use local voice',
                    run: () => switchFromNote(gate, () => saveSpeechProvider('whisper'), () => speechProvider() === 'whisper', 'Now using local voice')
                };
            case 'speech:azure':
                return {
                    text: 'Used only with Azure Speech. Voice input now uses local voice.',
                    button: 'Use Azure Speech',
                    run: () => switchFromNote(gate, () => saveSpeechProvider('azure'), () => speechProvider() === 'azure', 'Now using Azure Speech')
                };
            case 'llm:ollama':
                if (!providers().some((p) => p.id === 'ollama')) return null;
                return {
                    text: `Used only with Ollama. Your AI provider is ${currentName}.`,
                    button: 'Use Ollama',
                    run: () => switchFromNote(gate, () => selectProvider('ollama'), () => currentProviderId() === 'ollama', 'Now using Ollama')
                };
            case 'llm:key':
                return {
                    text: `${currentName} needs no API key. To add a key for another provider, choose it under AI provider.`,
                    button: 'Choose a provider',
                    noteOnly: true,
                    run: () => {
                        showSection('ai');
                        const card = providerGrid.querySelector('.sw-provider[tabindex="0"]');
                        if (card) card.focus();
                    }
                };
            default:
                return null;
        }
    }

    /** Switch provider from a search note, then show the now-active settings in place. */
    async function switchFromNote(gate, action, succeeded, doneText) {
        delete gateErrors[gate];
        const pending = action();
        applyView();
        const container = document.querySelector(`[data-gate="${gate}"]`);
        if (container && !container.hidden) {
            const field = container.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea, button:not([disabled])');
            if (field) field.focus({ preventScroll: true });
            container.scrollIntoView({ block: 'nearest' });
        }
        try {
            await pending;
        } catch (_) { /* reported below */ }
        if (!succeeded()) gateErrors[gate] = 'Could not switch. Try again.';
        if (state.query) applyView();
        if (!succeeded() && container) {
            const retry = container.querySelector(':scope > .sw-gate-hint button');
            if (retry) retry.focus({ preventScroll: true });
        }
        $('srAnnounce').textContent = succeeded() ? doneText : 'Could not switch. Try again.';
    }

    /** Show or hide a gated container in search results, with its note on top. */
    function setGateRevealed(container, on) {
        const existing = container.querySelector(':scope > .sw-gate-hint');
        if (!on) {
            if (existing) existing.remove();
            container.classList.remove('sw-gate-revealed', 'sw-gate-revealed--note-only');
            Array.from(container.children).forEach((child) => {
                if (child.dataset.gateInert) {
                    child.inert = false;
                    delete child.dataset.gateInert;
                }
            });
            return;
        }
        const note = gateNote(container.dataset.gate);
        if (!note) return;
        const text = gateErrors[container.dataset.gate] ? `${note.text} ${gateErrors[container.dataset.gate]}` : note.text;
        let hint = existing;
        if (!hint) {
            hint = el('div', { class: 'sw-gate-hint' },
                icon('circle-info'),
                el('span', { class: 'sw-gate-hint-text' }),
                el('button', { type: 'button', class: 'oc-btn' }));
            hint.querySelector('button').addEventListener('click', () => {
                const current = gateNote(container.dataset.gate);
                if (current) current.run();
            });
            const head = container.querySelector(':scope > .sw-group-head');
            if (head) head.after(hint);
            else container.prepend(hint);
        }
        // Update in place so a focused button keeps focus across re-renders.
        hint.querySelector('.sw-gate-hint-text').textContent = text;
        hint.querySelector('button').textContent = note.button;
        container.classList.add('sw-gate-revealed');
        container.classList.toggle('sw-gate-revealed--note-only', !!note.noteOnly);
        Array.from(container.children).forEach((child) => {
            if (child === hint) return;
            child.inert = true;
            child.dataset.gateInert = '1';
        });
    }

    const searchText = (node) => `${node.dataset.search || ''} ${node.textContent || ''}`.toLowerCase();

    let firstMatch = null;
    function runSearch() {
        const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = (node) => {
            const text = searchText(node);
            return terms.every((t) => text.includes(t));
        };
        let total = 0;
        firstMatch = null;
        const revealed = new Set();
        sections.forEach((section) => {
            let count = 0;
            const units = Array.from(section.querySelectorAll('[data-search]'));
            const leaves = units.filter((u) => !u.querySelector('[data-search]'));
            const containers = units.filter((u) => u.querySelector('[data-search]'));
            units.forEach((u) => u.classList.remove('sw-filtered'));
            const visibleLeaves = new Set();
            const gateOf = new Map();
            leaves.forEach((leaf) => {
                const gate = hiddenBy(leaf, section);
                if (gate === false) return;
                if (gate && !gateNote(gate.dataset.gate)) return;
                if (gate) gateOf.set(leaf, gate);
                const parent = containers.find((c) => c.contains(leaf));
                const parentHead = parent ? parent.querySelector('.sw-group-head') : null;
                const parentMatches = parent && parentHead && (() => {
                    const text = `${parent.dataset.search || ''} ${parentHead.textContent}`.toLowerCase();
                    return terms.every((t) => text.includes(t));
                })();
                if (matches(leaf) || parentMatches) visibleLeaves.add(leaf);
            });
            leaves.forEach((leaf) => {
                const show = visibleLeaves.has(leaf);
                leaf.classList.toggle('sw-filtered', !show);
                if (show) {
                    count += 1;
                    const gate = gateOf.get(leaf) || null;
                    if (gate) revealed.add(gate);
                    // Enter goes to the first result; one in a hidden
                    // provider's settings is reached through its note.
                    if (!firstMatch || (firstMatch.gate && !gate)) {
                        firstMatch = { section: section.dataset.section, node: gate || leaf, gate };
                    }
                }
            });
            // A group that holds result rows hides when none of them match.
            section.querySelectorAll('.sw-group').forEach((group) => {
                const inner = leaves.filter((leaf) => leaf !== group && group.contains(leaf));
                if (inner.length) group.classList.toggle('sw-filtered', !inner.some((leaf) => visibleLeaves.has(leaf)));
            });
            section.hidden = count === 0;
            total += count;
            const item = navItems.find((i) => i.dataset.nav === section.dataset.section);
            if (item) {
                item.classList.toggle('is-empty', count === 0);
                item.querySelector('.sw-nav-count').textContent = count ? String(count) : '';
            }
        });
        document.querySelectorAll('[data-gate]').forEach((container) => setGateRevealed(container, revealed.has(container)));
        $('searchEmptyQuery').textContent = `“${state.query}”`;
        $('searchEmpty').hidden = total > 0;
        $('srAnnounce').textContent = total ? `${total} setting${total === 1 ? '' : 's'} found` : 'No settings found';
    }

    function clearSearch() {
        state.query = '';
        searchInput.value = '';
    }

    searchInput.addEventListener('input', () => {
        state.query = searchInput.value.trim();
        applyView();
        scroller.scrollTop = 0;
        // Results can list the voice models; make sure they have loaded.
        if (state.query && speechProvider() === 'whisper' && !voice.status) maybeCheckVoice();
    });

    searchInput.addEventListener('keydown', (e) => {
        if (composing(e)) return;
        if (e.key === 'Escape' && searchInput.value) {
            e.preventDefault();
            e.stopPropagation();
            clearSearch();
            applyView();
        } else if (e.key === 'Enter' && state.query && firstMatch && firstMatch.gate) {
            // The first result belongs to a provider that is not selected:
            // stay in the results and move to its note's button.
            e.preventDefault();
            const button = firstMatch.gate.querySelector(':scope > .sw-gate-hint button');
            firstMatch.gate.scrollIntoView({ block: 'nearest' });
            if (button) button.focus();
        } else if (e.key === 'Enter' && state.query && firstMatch) {
            // Jump to the first result in its section.
            e.preventDefault();
            const target = firstMatch;
            showSection(target.section);
            const focusable = target.node.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea, button:not([disabled]), [tabindex="0"]');
            target.node.scrollIntoView({ block: 'center' });
            target.node.classList.remove('sw-flash');
            void target.node.offsetWidth;
            target.node.classList.add('sw-flash');
            if (focusable) focusable.focus({ preventScroll: true });
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            const item = navItems.find((i) => !i.classList.contains('is-empty')) || navItems[0];
            item.focus();
        }
    });

    nav.addEventListener('click', (e) => {
        const item = e.target.closest('.sw-nav-item');
        if (item) showSection(item.dataset.nav);
    });

    nav.addEventListener('keydown', (e) => {
        const index = navItems.indexOf(document.activeElement);
        if (index < 0) return;
        let next = null;
        if (e.key === 'ArrowDown') next = navItems[(index + 1) % navItems.length];
        else if (e.key === 'ArrowUp') {
            if (index === 0) {
                e.preventDefault();
                searchInput.focus();
                return;
            }
            next = navItems[index - 1];
        } else if (e.key === 'Home') next = navItems[0];
        else if (e.key === 'End') next = navItems[navItems.length - 1];
        if (!next) return;
        e.preventDefault();
        showSection(next.dataset.nav, { focusNav: true });
    });

    // ---------- Window: close, quit, keyboard, refresh ----------

    function withTimeout(promise, ms) {
        return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
    }

    async function flushAll(timeoutMs = 2000) {
        await withTimeout(Promise.all([saveProfile(), flushTextInputs()]), timeoutMs);
    }

    // Quitting (Cmd+Q, menu, tray) waits up to 1 s for pending saves; stay
    // inside that budget.
    if (api && api.onFlushBeforeQuit) api.onFlushBeforeQuit(() => flushAll(900));

    async function closeWindow() {
        await flushAll();
        if (api && api.closeSettings) api.closeSettings();
        else window.close();
    }

    $('closeButton').addEventListener('click', closeWindow);

    $('quitButton').addEventListener('click', async () => {
        await flushAll();
        if (api && api.quit) api.quit();
    });

    $('loadRetry').addEventListener('click', async () => {
        const ok = await loadSettings();
        if (ok) {
            loadProfile();
            if (!state.info) loadInfo();
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.defaultPrevented || composing(e)) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closeWindow();
            return;
        }
        // Cmd/Ctrl+F focuses the search box.
        if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
            e.preventDefault();
            searchInput.focus();
            searchInput.select();
        }
    });

    // Focus left the window (another app, or the close button / Cmd+W hid
    // it): save anything still pending.
    window.addEventListener('blur', () => { flushAll(); });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushAll();
    });

    if (api) {
        if (api.onSettingsWindowShown) {
            api.onSettingsWindowShown(() => {
                loadSettings({ quiet: true });
                loadProfile();
                if (!state.info) loadInfo();
                if (state.section === 'voice') {
                    state.whisperCheckedAt = 0;
                    voice.checkedAt = 0;
                }
                setTimeout(() => {
                    if (!document.activeElement || document.activeElement === document.body) searchInput.focus();
                }, 50);
            });
        }
        if (api.onSkillUpdated) {
            api.onSkillUpdated((data) => {
                if (!data || typeof data.skill !== 'string') return;
                if (state.settings) state.settings.activeSkill = data.skill;
                setInputValue($('activeSkill'), data.skill);
            });
        }
        if (api.onCodingLanguageChanged) {
            api.onCodingLanguageChanged((data) => {
                if (!data || typeof data.language !== 'string') return;
                if (state.settings) state.settings.codingLanguage = data.language;
                setInputValue($('codingLanguage'), data.language);
            });
        }
        if (api.onSpeechAvailability) {
            api.onSpeechAvailability((data) => {
                if (!data || !state.settings) return;
                state.settings.speechAvailable = !!data.available;
                renderVoiceBanner();
            });
        }
    }

    // ---------- Start ----------

    applyView();
    renderPrivacy();
    loadSettings().then((ok) => {
        if (ok) loadProfile();
    });
    loadInfo();
})();
