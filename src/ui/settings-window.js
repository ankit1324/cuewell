document.addEventListener('DOMContentLoaded', () => {    
    const logger = {
        info: (...args) => console.log('[SettingsWindowUI]', ...args)
    };

    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const speechProviderSelect = document.getElementById('speechProvider');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const whisperCommandInput = document.getElementById('whisperCommand');
    const whisperModelInput = document.getElementById('whisperModel');
    const whisperLanguageInput = document.getElementById('whisperLanguage');
    const whisperDeviceSelect = document.getElementById('whisperDevice');
    const whisperCaptureModeSelect = document.getElementById('whisperCaptureMode');
    const whisperResponseTargetSelect = document.getElementById('whisperResponseTarget');
    const whisperSegmentMsInput = document.getElementById('whisperSegmentMs');
    const geminiKeyInput = document.getElementById('geminiKey');
    const llmProviderSelect = document.getElementById('llmProvider');
    // AI provider fields. Each element id is also its settings key in main.js
    // (geminiKey is handled with the other existing fields above).
    const llmFieldInputs = [
        'anthropicKey', 'openaiKey', 'openrouterKey', 'groqKey', 'deepseekKey',
        'geminiModel', 'anthropicModel', 'openaiModel', 'openrouterModel',
        'groqModel', 'deepseekModel', 'ollamaModel', 'ollamaBaseUrl'
    ].map((id) => document.getElementById(id)).filter(Boolean);
    const windowGapInput = document.getElementById('windowGap');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const answerLengthSelect = document.getElementById('answerLength');
    const iconGrid = document.getElementById('iconGrid');
    // Interview context inputs; data-profile-field is the profile.json key.
    const profileInputs = Array.from(document.querySelectorAll('[data-profile-field]'));
    const contextStatus = document.getElementById('contextStatus');

    // API-key fields. Main never sends a saved key back, only whether one is
    // set and its last 4 characters. These inputs stay empty and show the
    // saved state in their placeholder; typing a new key replaces it, and an
    // empty field keeps the saved key.
    const secretInputs = [
        'geminiKey', 'azureKey', 'anthropicKey', 'openaiKey', 'openrouterKey',
        'groqKey', 'deepseekKey'
    ].map((id) => document.getElementById(id)).filter(Boolean);
    secretInputs.forEach((input) => {
        input.dataset.emptyPlaceholder = input.placeholder;
    });
    const isSecretInput = (input) => secretInputs.includes(input);

    const showSecretState = (input, masked) => {
        input.value = '';
        if (masked && masked.set) {
            input.placeholder = masked.last4 ? `•••••••• ${masked.last4} (saved)` : '•••••••• (saved)';
        } else {
            input.placeholder = input.dataset.emptyPlaceholder || '';
        }
    };

    // Main saves the valid fields and rejects invalid ones with
    // { success: false, field, error, errors: [{ field, error }] }. Each
    // rejected field gets its message as a validation error; the first is
    // shown in the browser's validation bubble, once per value, so leaving
    // the field does not keep pulling focus back to it.
    let lastReportedError = '';
    const clearSaveErrors = () => {
        document.querySelectorAll('input, select').forEach((el) => {
            if (typeof el.setCustomValidity === 'function') el.setCustomValidity('');
        });
    };
    const showSaveError = (result) => {
        const message = (result && result.error) || 'Could not save settings.';
        console.error('Settings not saved:', message);
        const errors = result && Array.isArray(result.errors) && result.errors.length
            ? result.errors
            : [{ field: result && result.field, error: message }];
        clearSaveErrors();
        let first = null;
        errors.forEach(({ field, error }) => {
            const input = field ? document.getElementById(field) : null;
            if (!input || typeof input.setCustomValidity !== 'function') return;
            input.setCustomValidity(error || message);
            if (!first) first = { input, field, error: error || message };
        });
        if (!first) return;
        const key = `${first.field}\n${first.input.value}\n${first.error}`;
        if (key !== lastReportedError) {
            lastReportedError = key;
            first.input.reportValidity();
        }
    };
    document.addEventListener('input', (e) => {
        if (e.target && typeof e.target.setCustomValidity === 'function') e.target.setCustomValidity('');
    });

    // Refresh the saved-key placeholders. A key input is cleared only if it
    // is empty or still holds the key that was just saved, never while the
    // user is typing a different one.
    const refreshSecretStates = (sentKeys) => {
        if (!window.electronAPI || !window.electronAPI.getSettings) return;
        window.electronAPI.getSettings().then((settings) => {
            secretInputs.forEach((input) => {
                const current = input.value.trim();
                if (current && current !== sentKeys[input.id]) return;
                showSecretState(input, settings[input.id]);
            });
        }).catch((error) => console.error('Failed to refresh settings:', error));
    };

    // Send settings to main and report the result.
    const sendSettings = (settings) => {
        if (!window.electronAPI || !window.electronAPI.saveSettings) return Promise.resolve(null);
        const sentKeys = {};
        secretInputs.forEach((input) => {
            if (settings[input.id] !== undefined) sentKeys[input.id] = settings[input.id];
        });
        return window.electronAPI.saveSettings(settings).then((result) => {
            if (result && result.success === false) {
                showSaveError(result);
                // A rejected key stays in its field for the user to fix. With
                // no per-field list nothing was saved, so no key is cleared.
                if (!Array.isArray(result.errors)) {
                    Object.keys(sentKeys).forEach((k) => delete sentKeys[k]);
                }
                (Array.isArray(result.errors) ? result.errors : []).forEach((e) => {
                    if (e && e.field) delete sentKeys[e.field];
                });
            } else {
                lastReportedError = '';
                clearSaveErrors();
            }
            if (Object.keys(sentKeys).length > 0) refreshSecretStates(sentKeys);
            return result;
        }).catch((error) => {
            showSaveError({ error: error && error.message });
            return null;
        });
    };

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    // Unsaved interview context is saved before the window hides. Declared
    // later in this function; only called after setup has finished.
    const closeSettings = () => {
        Promise.resolve(saveProfile()).finally(() => window.api.send('close-settings'));
    };

    if (closeButton) {
        closeButton.addEventListener('click', closeSettings);
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.speechProvider && speechProviderSelect) speechProviderSelect.value = settings.speechProvider;
        // Always set the input value, even if empty, so the user sees what's
        // currently configured (including env-derived defaults). Previously
        // empty strings were skipped which left stale UI values.
        if (azureRegionInput) azureRegionInput.value = settings.azureRegion || '';
        if (whisperCommandInput) whisperCommandInput.value = settings.whisperCommand || '';
        if (whisperModelInput) whisperModelInput.value = settings.whisperModel || '';
        if (whisperLanguageInput) whisperLanguageInput.value = settings.whisperLanguage || '';
        if (whisperDeviceSelect) whisperDeviceSelect.value = settings.whisperDevice || 'auto';
        if (whisperCaptureModeSelect) whisperCaptureModeSelect.value = settings.whisperCaptureMode || 'vad';
        if (whisperResponseTargetSelect) whisperResponseTargetSelect.value = settings.whisperResponseTarget || 'both';
        if (whisperSegmentMsInput) whisperSegmentMsInput.value = settings.whisperSegmentMs || '';
        secretInputs.forEach((input) => showSecretState(input, settings[input.id]));
        if (settings.llmProvider && llmProviderSelect) llmProviderSelect.value = settings.llmProvider;
        llmFieldInputs.forEach((input) => {
            if (!isSecretInput(input)) input.value = settings[input.id] || '';
        });
        // Show each provider's default model as the placeholder.
        if (Array.isArray(settings.llmProviders)) {
            settings.llmProviders.forEach((provider) => {
                const modelInput = document.getElementById(`${provider.id}Model`);
                if (modelInput && provider.defaultModel) modelInput.placeholder = provider.defaultModel;
            });
        }
        if (windowGapInput) windowGapInput.value = settings.windowGap || '';

        // Set C++ as default if no coding language is specified
        if (codingLanguageSelect) {
            codingLanguageSelect.value = settings.codingLanguage || 'cpp';
        }

        // Mode options come from main so they always match the toolbar.
        if (activeSkillSelect && Array.isArray(settings.modes) && settings.modes.length > 0) {
            activeSkillSelect.replaceChildren(...settings.modes
                .filter((mode) => mode && typeof mode.id === 'string' && typeof mode.label === 'string')
                .map((mode) => {
                    const option = document.createElement('option');
                    option.value = mode.id;
                    option.textContent = mode.label;
                    return option;
                }));
        }
        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;
        if (answerLengthSelect) answerLengthSelect.value = settings.answerLength || 'auto';

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }

        updateSpeechFieldStates();
        updateProviderFieldStates();
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.onSettingsWindowShown) {
        window.electronAPI.onSettingsWindowShown(() => {
            requestCurrentSettings();
            requestProfile();
        });

    // Keep the Mode select in step with the toolbar chip and ⌘↑/↓.
    if (window.electronAPI.onSkillUpdated) {
        window.electronAPI.onSkillUpdated((data) => {
            if (data && typeof data.skill === 'string' && activeSkillSelect) {
                activeSkillSelect.value = data.skill;
            }
        });
    }

    // Listen for coding language changes from other windows via helper
    window.electronAPI.onCodingLanguageChanged((data) => {
            if (data && data.language && codingLanguageSelect) {
                codingLanguageSelect.value = data.language;
                console.log('Language updated from overlay window:', data.language);
            }
    });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (speechProviderSelect) settings.speechProvider = speechProviderSelect.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (whisperCommandInput) settings.whisperCommand = whisperCommandInput.value;
        if (whisperModelInput) settings.whisperModel = whisperModelInput.value;
        if (whisperLanguageInput) settings.whisperLanguage = whisperLanguageInput.value;
        if (whisperDeviceSelect) settings.whisperDevice = whisperDeviceSelect.value;
        if (whisperCaptureModeSelect) settings.whisperCaptureMode = whisperCaptureModeSelect.value;
        if (whisperResponseTargetSelect) settings.whisperResponseTarget = whisperResponseTargetSelect.value;
        if (whisperSegmentMsInput) settings.whisperSegmentMs = whisperSegmentMsInput.value;
        if (llmProviderSelect) settings.llmProvider = llmProviderSelect.value;
        llmFieldInputs.forEach((input) => {
            if (!isSecretInput(input)) settings[input.id] = input.value;
        });
        // Keys only when the user typed a new one; empty keeps the saved key.
        secretInputs.forEach((input) => {
            const key = input.value.trim();
            if (key) settings[input.id] = key;
        });
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        // Mode and answer length save on their own change events, so a blur
        // here never sends back a mode the toolbar has switched since.

        sendSettings(settings);
    };

    const updateSpeechFieldStates = () => {
        const provider = speechProviderSelect ? speechProviderSelect.value : 'azure';

        // Show/hide provider-specific field groups instead of just disabling
        // them. This keeps the settings UI clean — only the relevant fields
        // for the selected provider are visible.
        const azureGroup = document.getElementById('azureFields');
        const whisperGroup = document.getElementById('whisperFields');
        const azureNote = document.getElementById('azureFieldsNote');

        if (azureGroup) {
            azureGroup.style.display = provider === 'azure' ? '' : 'none';
        }
        if (whisperGroup) {
            whisperGroup.style.display = provider === 'whisper' ? '' : 'none';
        }
        if (azureNote) {
            azureNote.style.display = provider === 'azure' ? '' : 'none';
        }

        // Also toggle disabled attribute for any leftover direct field refs
        [azureKeyInput, azureRegionInput].forEach(input => {
            if (input) input.disabled = provider !== 'azure';
        });
        [whisperCommandInput, whisperModelInput, whisperLanguageInput, whisperDeviceSelect,
            whisperCaptureModeSelect, whisperResponseTargetSelect, whisperSegmentMsInput].forEach(input => {
            if (input) input.disabled = provider !== 'whisper';
        });
    };

    // Only the selected AI provider's fields are visible. Hidden fields keep
    // their values, so switching providers never drops a saved key.
    const updateProviderFieldStates = () => {
        const provider = llmProviderSelect ? llmProviderSelect.value : 'gemini';
        document.querySelectorAll('.provider-fields').forEach((group) => {
            group.style.display = group.dataset.provider === provider ? '' : 'none';
        });
    };

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        whisperCommandInput,
        whisperModelInput,
        whisperLanguageInput,
        whisperDeviceSelect,
        whisperCaptureModeSelect,
        whisperResponseTargetSelect,
        whisperSegmentMsInput,
        geminiKeyInput,
        ...llmFieldInputs,
        windowGapInput
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    if (speechProviderSelect) {
        speechProviderSelect.addEventListener('change', () => {
            updateSpeechFieldStates();
            saveSettings();
        });
    }

    if (llmProviderSelect) {
        llmProviderSelect.addEventListener('change', () => {
            updateProviderFieldStates();
            saveSettings();
        });
    }

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            const lang = e.target.value;
            // use electronAPI so main broadcast is consistent
            if (window.electronAPI && window.electronAPI.saveSettings) {
                sendSettings({ codingLanguage: lang });
            } else {
                // fallback
                saveSettings();
            }
        });
    }

    // Mode selection: main switches the mode and tells the toolbar.
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            sendSettings({ activeSkill: e.target.value });
        });
    }

    if (answerLengthSelect) {
        answerLengthSelect.addEventListener('change', (e) => {
            sendSettings({ answerLength: e.target.value });
        });
    }

    // ---------- Interview context (userData/profile.json) ----------
    // Saved through its own IPC (get-profile / save-profile); main validates
    // and writes it. Edits save 800 ms after typing stops, on change, and
    // before the window closes.
    let profileDirty = false;
    let profileTimer = null;
    let profileStatusTimer = null;

    const setContextStatus = (text, kind = '') => {
        if (!contextStatus) return;
        if (profileStatusTimer) {
            clearTimeout(profileStatusTimer);
            profileStatusTimer = null;
        }
        contextStatus.textContent = text;
        contextStatus.classList.toggle('is-error', kind === 'error');
        contextStatus.classList.toggle('is-saved', kind === 'saved');
        if (kind === 'saved') {
            profileStatusTimer = setTimeout(() => setContextStatus(''), 1800);
        }
    };

    const updateProfileCount = (input) => {
        const counter = document.querySelector(`[data-count-for="${input.id}"]`);
        if (!counter) return;
        const limit = Number(input.getAttribute('maxlength')) || 0;
        const length = input.value.length;
        counter.textContent = length > 0 ? `${length.toLocaleString()} / ${limit.toLocaleString()}` : '';
        counter.classList.toggle('is-over', limit > 0 && length > limit);
    };

    const collectProfile = () => {
        const profile = {};
        profileInputs.forEach((input) => {
            profile[input.dataset.profileField] = input.value;
        });
        return profile;
    };

    const loadProfileIntoUI = (profile) => {
        if (!profile || typeof profile !== 'object') return;
        profileInputs.forEach((input) => {
            const value = profile[input.dataset.profileField];
            input.value = typeof value === 'string' ? value : '';
            input.setCustomValidity('');
            updateProfileCount(input);
        });
    };

    const requestProfile = () => {
        // Never overwrite edits that are not saved yet.
        if (profileDirty || !window.electronAPI || !window.electronAPI.getProfile) return;
        window.electronAPI.getProfile().then((result) => {
            if (!profileDirty && result && result.success) loadProfileIntoUI(result.profile);
        }).catch((error) => console.error('Failed to load interview context:', error));
    };

    const saveProfile = () => {
        if (profileTimer) {
            clearTimeout(profileTimer);
            profileTimer = null;
        }
        if (!profileDirty || !window.electronAPI || !window.electronAPI.saveProfile) return Promise.resolve();
        profileDirty = false;
        setContextStatus('Saving…');
        return window.electronAPI.saveProfile(collectProfile()).then((result) => {
            profileInputs.forEach((input) => input.setCustomValidity(''));
            if (result && result.success) {
                setContextStatus('Saved', 'saved');
                return;
            }
            const message = (result && result.error) || 'Could not save the interview context.';
            setContextStatus('Not saved', 'error');
            const input = result && result.field
                ? profileInputs.find((el) => el.dataset.profileField === result.field)
                : null;
            if (input) {
                input.setCustomValidity(message);
                input.reportValidity();
            } else {
                console.error('Interview context not saved:', message);
            }
        }).catch((error) => {
            setContextStatus('Not saved', 'error');
            console.error('Interview context not saved:', error);
        });
    };

    profileInputs.forEach((input) => {
        input.addEventListener('input', () => {
            profileDirty = true;
            updateProfileCount(input);
            if (profileTimer) clearTimeout(profileTimer);
            profileTimer = setTimeout(saveProfile, 800);
        });
        input.addEventListener('change', saveProfile);
    });

    updateSpeechFieldStates();
    updateProviderFieldStates();

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                sendSettings({ selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
        requestProfile();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeSettings();
        }
    });
}); 
