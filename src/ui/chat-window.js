try {
    // Check if we're in Node.js context or browser context
    let logger;
    try {
        logger = require('../core/logger').createServiceLogger('CHAT-UI');
    } catch (error) {
        logger = {
            info: (...args) => console.log('[CHAT-UI INFO]', ...args),
            debug: (...args) => console.log('[CHAT-UI DEBUG]', ...args),
            error: (...args) => console.error('[CHAT-UI ERROR]', ...args),
            warn: (...args) => console.warn('[CHAT-UI WARN]', ...args)
        };
    }

class ChatWindowUI {
    constructor() {
        this.isRecording = false;
        this.isInteractive = true; // Start in interactive mode
        this.elements = {};
        
        this.init();
    }

    init() {
        try {
            this.setupElements();
            this.setupEventListeners();
            this.addMessage('Chat window initialized. Click microphone or press ⌘+R to start recording.', 'system');
            
            logger.info('Chat window UI initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize chat window UI', { error: error.message });
            console.error('Chat window initialization failed:', error);
        }
    }

    setupElements() {
        this.elements = {
            chatMessages: document.getElementById('chatMessages'),
            recordingIndicator: document.getElementById('recordingIndicator'),
            messageInput: document.getElementById('messageInput'),
            sendButton: document.getElementById('sendButton'),
            micButton: document.getElementById('micButton'),
            chatContainer: document.getElementById('chatContainer'),
            interactionIndicator: document.getElementById('interactionIndicator'),
            interactionText: document.getElementById('interactionText'),
            listeningContainer: document.getElementById('listeningContainer'),
            listeningDuration: document.getElementById('listeningDuration')
        };
        
        // Validate required elements
        const requiredElements = ['chatMessages', 'micButton', 'sendButton', 'messageInput'];
        for (const elementKey of requiredElements) {
            if (!this.elements[elementKey]) {
                throw new Error(`Required element '${elementKey}' not found`);
            }
        }
        
        // Initialize listening timer
        this.listeningStartTime = null;
        this.listeningTimer = null;
    }

    setupEventListeners() {
        // Interaction state handlers
        if (window.electronAPI) {
            window.electronAPI.onInteractionModeChanged((event, interactive) => {
                this.isInteractive = interactive;
                if (interactive) {
                    this.handleInteractionEnabled();
                } else {
                    this.handleInteractionDisabled();
                }
            });
            
            // Speech recognition handlers
            window.electronAPI.onTranscriptionReceived((event, data) => {
                if (data && data.text) {
                    this.handleTranscription(data.text);
                } else {
                    console.warn('Transcription event received but no text data:', data);
                }
            });
            
            // Listen for interim transcription (real-time)
            if (window.electronAPI.onInterimTranscription) {
                window.electronAPI.onInterimTranscription((event, data) => {
                    if (data && data.text) {
                        this.showInterimText(data.text);
                    }
                });
            }
            
            window.electronAPI.onSpeechStatus((event, data) => {
                if (data && data.status) {
                    this.addMessage(data.status, 'system');
                    
                    // Update recording state based on status
                    if (data.status.includes('started') || data.status.includes('Recording')) {
                        this.handleRecordingStarted();
                    } else if (data.status.includes('stopped') || data.status.includes('ended')) {
                        this.handleRecordingStopped();
                    }
                }
            });
            
            window.electronAPI.onSpeechError((event, data) => {
                if (data && data.error) {
                    this.addMessage(`Speech Error: ${data.error}`, 'error');
                    this.handleRecordingStopped(); // Stop recording on error
                }
            });
            
            // Skill handlers
            window.electronAPI.onSkillChanged((event, data) => {
                if (data && data.skill) {
                    this.handleSkillActivated(data.skill);
                }
            });
            
            // Session handlers
            window.electronAPI.onSessionCleared(() => {
                this.addMessage('Session memory has been cleared', 'system');
            });
            
            window.electronAPI.onOcrCompleted((event, data) => {
                if (data.text && data.text.trim()) {
                    this.addMessage(`📷 OCR Result: ${data.text}`, 'transcription');
                }
            });
            
            window.electronAPI.onOcrError((event, data) => {
                this.addMessage(`OCR Error: ${data.error}`, 'error');
            });
            
            window.electronAPI.onLlmResponse((event, data) => {
                // Store AI response (text + snippets) in chat history
                if (data && data.response) {
                    this.hideThinkingIndicator?.();
                    this.renderAssistantResponse(data.response);
                }
            });
            
            window.electronAPI.onLlmError((event, data) => {
                this.addMessage(`LLM Error: ${data.error}`, 'error');
            });
            
            window.electronAPI.onTranscriptionLlmResponse((event, data) => {
                if (data && data.response) {
                    // Hide thinking indicator
                    this.hideThinkingIndicator();
                    // Finalize the streaming bubble (if any) with fully formatted
                    // markdown + code snippets; otherwise render fresh.
                    this.finalizeStreamingResponse(data.messageId, data.response);
                }
            });

            // Streaming response lifecycle: a bubble is created on start, grows
            // as chunks arrive, then is replaced with the formatted final render.
            if (window.electronAPI.onTranscriptionLlmResponseStart) {
                window.electronAPI.onTranscriptionLlmResponseStart((event, data) => {
                    if (data && data.messageId) {
                        this.beginStreamingResponse(data.messageId);
                    }
                });
            }
            if (window.electronAPI.onTranscriptionLlmResponseChunk) {
                window.electronAPI.onTranscriptionLlmResponseChunk((event, data) => {
                    if (data && data.messageId) {
                        this.appendStreamingChunk(data.messageId, data.delta || '');
                    }
                });
            }
        }
        
        // UI event handlers
        this.setupUIHandlers();
        
        logger.debug('Chat window event listeners set up');
    }

    setupUIHandlers() {
        // Microphone button
        this.elements.micButton.addEventListener('click', async () => {
            if (!this.isInteractive) {
                this.addMessage('Window is in non-interactive mode. Press Alt+A to enable interaction.', 'error');
                return;
            }
            
            try {
                if (this.isRecording) {
                    await window.electronAPI.stopSpeechRecognition();
                } else {
                    await window.electronAPI.startSpeechRecognition();
                }
            } catch (error) {
                this.addMessage(`Speech recognition error: ${error.message}`, 'error');
                logger.error('Speech recognition failed', { error: error.message });
            }
        });
        
        // Send button
        this.elements.sendButton.addEventListener('click', () => {
            this.sendMessage();
        });
        
        // Message input
        this.elements.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
            }
        });
        
        // Global keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.altKey && e.key === 'r') {
                e.preventDefault();
                this.elements.micButton.click();
            }
        });
    }

    handleInteractionEnabled() {
        this.isInteractive = true;
        this.elements.chatContainer.classList.remove('non-interactive');
        this.showInteractionIndicator('Interactive', true);
        logger.debug('Interaction mode enabled in chat');
    }

    handleInteractionDisabled() {
        this.isInteractive = false;
        this.elements.chatContainer.classList.add('non-interactive');
        this.showInteractionIndicator('Non-Interactive', false);
        logger.debug('Interaction mode disabled in chat');
    }

    handleRecordingStarted() {
        this.isRecording = true;
        if (this.elements.recordingIndicator) {
            this.elements.recordingIndicator.style.display = 'block';
        }
        if (this.elements.micButton) {
            this.elements.micButton.classList.add('recording');
        }
        
        // Show listening animation
        this.showListeningAnimation();
        
        logger.debug('Recording started in chat window');
    }

    handleRecordingStopped() {
        this.isRecording = false;
        if (this.elements.recordingIndicator) {
            this.elements.recordingIndicator.style.display = 'none';
        }
        if (this.elements.micButton) {
            this.elements.micButton.classList.remove('recording');
        }
        
        // Hide listening animation
        this.hideListeningAnimation();
        
        logger.debug('Recording stopped in chat window');
    }

    handleTranscription(text) {
        if (text && text.trim()) {
            // Hide listening animation first
            this.hideListeningAnimation();
            
            // Show transcribed text with a slight delay for smooth transition
            setTimeout(() => {
                this.addMessage(text, 'transcription');
                
                // Show thinking indicator after transcription
                setTimeout(() => {
                    this.showThinkingIndicator();
                }, 300);
            }, 200);
            
            logger.debug('Transcription received in chat', { textLength: text.length });
        } else {
            console.warn('❌ Transcription text is empty or invalid:', text);
        }
    }

    async handleSkillActivated(skillName) {
        try {
            // Request the actual skill prompt from the main process
            const skillPrompt = await window.electronAPI.getSkillPrompt(skillName);
            
            if (skillPrompt) {
                // Extract the title/first line for display
                const lines = skillPrompt.split('\n').filter(line => line.trim());
                const title = lines.find(line => line.startsWith('#')) || `# ${skillName.toUpperCase()} Mode`;
                const cleanTitle = title.replace(/^#+\s*/, '').trim();
                
                // Show a brief activation message with the skill title
                const icons = {
                    'dsa': '🧠',
                    'behavioral': '💼', 
                    'sales': '💰',
                    'presentation': '🎤',
                    'data-science': '📊',
                    'programming': '💻',
                    'devops': '🚀',
                    'system-design': '🏗️',
                    'negotiation': '🤝'
                };
                
                const icon = icons[skillName] || '🎯';
                this.addMessage(`${icon} ${cleanTitle} - Ready to help!`, 'system');
            } else {
                // Fallback if prompt not found
                this.addMessage(`🎯 ${skillName.toUpperCase()} Mode: Ready to help!`, 'system');
            }
        } catch (error) {
            logger.error('Failed to load skill prompt', { skill: skillName, error: error.message });
            // Fallback message
            this.addMessage(`🎯 ${skillName.toUpperCase()} Mode: Ready to help!`, 'system');
        }
        
        logger.info('Skill activated in chat', { skill: skillName });
    }

    async sendMessage() {
        const text = this.elements.messageInput.value.trim();
        if (text) {
            this.addMessage(text, 'user');
            this.elements.messageInput.value = '';
            
            // Send to main process for session memory storage
            try {
                if (window.electronAPI && window.electronAPI.sendChatMessage) {
                    await window.electronAPI.sendChatMessage(text);
                }
            } catch (error) {
                logger.error('Failed to send chat message to main process', { error: error.message });
            }
            
            logger.debug('User message sent', { textLength: text.length });
        }
    }

    addMessage(text, type = 'user') {        
        if (!this.elements.chatMessages) {
            console.error('❌ Chat messages element not found!');
            return;
        }
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type} oc-rise`;
        
        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();
        
        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        
        // Format assistant messages as markdown
        if (type === 'assistant') {
            textDiv.classList.add('oc-prose');
            // Model output is sanitized; without lib/safe-html.js it is shown as text.
            if (typeof window.sanitizeHtml === 'function') {
                textDiv.innerHTML = window.sanitizeHtml(this.formatMarkdown(text));
            } else {
                textDiv.textContent = text;
            }
        } else {
            textDiv.textContent = text;
        }
        
        if (type === 'assistant' || type === 'transcription') {
            messageDiv.appendChild(this.buildMessageHead(type, timeDiv));
        } else {
            messageDiv.appendChild(timeDiv);
        }
        messageDiv.appendChild(textDiv);
        
        this.elements.chatMessages.appendChild(messageDiv);
        
        // Auto-scroll to bottom
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    // Small head row above heard and assistant messages: a label (plus the
    // brand mark for assistant) and the timestamp.
    buildMessageHead(type, timeDiv) {
        const head = document.createElement('div');
        head.className = 'message-head';
        if (type !== 'transcription') {
            const mark = document.createElement('span');
            mark.className = 'oc-mark';
            mark.setAttribute('aria-hidden', 'true');
            head.appendChild(mark);
        }
        const label = document.createElement('span');
        label.className = 'oc-label';
        label.textContent = type === 'transcription' ? 'Heard' : 'Super Interview';
        head.appendChild(label);
        head.appendChild(timeDiv);
        return head;
    }

    // Create a live, growing assistant bubble for a streaming response.
    beginStreamingResponse(messageId) {
        this.hideThinkingIndicator();
        if (!this.elements.chatMessages) return;
        // Guard against a duplicate start for the same id.
        if (this.elements.chatMessages.querySelector(`[data-stream-id="${messageId}"]`)) {
            return;
        }
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant streaming oc-rise';
        messageDiv.setAttribute('data-stream-id', messageId);

        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();

        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        textDiv.textContent = '';

        messageDiv.appendChild(this.buildMessageHead('assistant', timeDiv));
        messageDiv.appendChild(textDiv);
        this.elements.chatMessages.appendChild(messageDiv);
        this._streamBuffers = this._streamBuffers || {};
        this._streamBuffers[messageId] = '';
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    appendStreamingChunk(messageId, delta) {
        if (!delta) return;
        const messageDiv = this.elements.chatMessages &&
            this.elements.chatMessages.querySelector(`[data-stream-id="${messageId}"]`);
        if (!messageDiv) {
            // No start seen (e.g. very fast final) — create the bubble lazily.
            this.beginStreamingResponse(messageId);
            return this.appendStreamingChunk(messageId, delta);
        }
        this._streamBuffers = this._streamBuffers || {};
        this._streamBuffers[messageId] = (this._streamBuffers[messageId] || '') + delta;
        const textDiv = messageDiv.querySelector('.message-text');
        if (textDiv) {
            // Plain text while streaming keeps it fast and avoids half-parsed
            // markdown flicker; the final render formats it properly.
            textDiv.textContent = this._streamBuffers[messageId];
        }
        const atBottom = true;
        if (atBottom) {
            this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
        }
    }

    // Replace the streaming bubble with the formatted final response (markdown
    // text + extracted code snippets), matching non-streaming rendering.
    finalizeStreamingResponse(messageId, response) {
        const messageDiv = messageId && this.elements.chatMessages &&
            this.elements.chatMessages.querySelector(`[data-stream-id="${messageId}"]`);
        if (messageDiv) {
            messageDiv.remove();
        }
        if (this._streamBuffers && messageId) {
            delete this._streamBuffers[messageId];
        }
        this.renderAssistantResponse(response);
    }

    // Split AI response into plain text and code snippets and append to chat
    renderAssistantResponse(response) {
        if (!response || typeof response !== 'string') return;
        const { text: textOnly, blocks } = this.splitCodeBlocks(response);
        if (textOnly && textOnly.trim().length) {
            this.addMessage(textOnly, 'assistant');
        }
        blocks.forEach(b => this.addCodeSnippet(b.language, b.code));
    }

    // Split an answer into its prose and its fenced code blocks (``` or ~~~
    // on their own lines, possibly indented inside a list). When a coding
    // language is set, the main process retags only opening fence lines
    // (enforceProgrammingLanguage in llm.service.js) and leaves closing ones as
    // written, normally a plain ```. A closing fence that ends in one word
    // (```cpp) is accepted too. A fence leaves nothing in the prose: its lines
    // and the blank lines around it are dropped and the text on either side is
    // rejoined. A fence that is never closed, as in a cut-off answer, runs to
    // the end.
    // Keep in sync with splitCodeBlocks in chat.html and llm-response.html.
    splitCodeBlocks(text) {
        const prose = [];
        const blocks = [];
        const listLine = /^(?:[ \t]|[-*+][ \t]|\d+[.)][ \t])/; // list item or indented line
        let fence = null; // the block being read
        let cut = false;  // a block was removed after the last prose line
        const endBlock = () => {
            const lines = fence.lines;
            while (lines.length && !lines[0].trim()) lines.shift();
            while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
            if (lines.length) blocks.push({ language: fence.language, code: lines.join('\n') });
            fence = null;
            cut = true;
        };
        String(text || '').split(/\r\n?|\n/).forEach(line => {
            if (fence) {
                const close = line.match(/^[ \t]*(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/);
                if (close && close[1][0] === fence.char && close[1].length >= fence.size &&
                    !close[2].includes(fence.char)) {
                    endBlock();
                } else {
                    // Drop the fence's own indentation, keep the code's.
                    const lead = line.match(/^[ \t]*/)[0].length;
                    fence.lines.push(line.slice(Math.min(lead, fence.indent)));
                }
                return;
            }
            const open = line.match(/^([ \t]*)(`{3,}|~{3,})(.*)$/);
            // A backtick fence's info string has no backticks, so ```x``` stays inline code.
            if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
                while (prose.length && !prose[prose.length - 1].trim()) prose.pop();
                fence = {
                    char: open[2][0],
                    size: open[2].length,
                    indent: open[1].length,
                    language: open[3].trim().split(/\s+/)[0] || 'text',
                    lines: []
                };
                return;
            }
            if (cut) {
                if (!line.trim()) return;
                cut = false;
                // A blank line keeps paragraphs apart; inside a list the two sides
                // are joined directly so the list stays tight.
                const before = prose[prose.length - 1];
                if (before !== undefined && !(listLine.test(before) && listLine.test(line))) prose.push('');
            }
            prose.push(line);
        });
        if (fence) endBlock();
        return { text: prose.join('\n').replace(/\n\s*\n\s*\n/g, '\n\n').trim(), blocks };
    }

    addCodeSnippet(language, code) {
        if (!this.elements.chatMessages) return;
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message assistant snippet oc-rise';
        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();
        const textDiv = document.createElement('div');
        textDiv.className = 'message-text oc-prose';
        const escapedLang = this.escapeHtmlForSnippet((language || 'text').toLowerCase());
        const escapedCode = this.escapeHtmlForSnippet(code || '');
        textDiv.innerHTML = `<div class="code-block"><div class="code-head"><span class="oc-label">${escapedLang}</span></div><pre><code>${escapedCode}</code></pre></div>`;
        messageDiv.appendChild(this.buildMessageHead('assistant', timeDiv));
        messageDiv.appendChild(textDiv);
        this.elements.chatMessages.appendChild(messageDiv);
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    escapeHtmlForSnippet(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    formatMarkdown(text) {
        if (!text) return '';
        
        try {
            // Use the markdown.js library for proper markdown parsing
            // Try to access markdown library in different contexts
            let markdownLib;
            
            // First try global markdown object (from script tag)
            if (typeof markdown !== 'undefined' && markdown.toHTML) {
                markdownLib = markdown;
            }
            // Then try require (Node.js context)
            else if (typeof require !== 'undefined') {
                try {
                    markdownLib = require('markdown');
                } catch (requireError) {
                    logger.debug('Could not require markdown library:', requireError.message);
                }
            }
            // Finally try window.markdown (browser context)
            else if (typeof window !== 'undefined' && window.markdown) {
                markdownLib = window.markdown;
            }
            
            if (markdownLib && markdownLib.toHTML) {
                return markdownLib.toHTML(text);
            } else {
                logger.warn('Markdown library not available, falling back to basic formatting');
                // Fallback to basic formatting
                return text
                    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                    .replace(/\*(.+?)\*/g, '<em>$1</em>')
                    .replace(/`(.+?)`/g, '<code>$1</code>')
                    .replace(/\n/g, '<br>');
            }
        } catch (error) {
            logger.warn('Failed to parse markdown, falling back to plain text', { error: error.message });
            // Fallback to basic formatting
            return text.replace(/\n/g, '<br>');
        }
    }

    showThinkingIndicator() {
        if (!this.elements.chatMessages) return;

        const thinkingDiv = document.createElement('div');
        thinkingDiv.className = 'message assistant thinking';
        thinkingDiv.id = 'thinking-indicator';

        const timeDiv = document.createElement('div');
        timeDiv.className = 'message-time';
        timeDiv.textContent = new Date().toLocaleTimeString();

        const textDiv = document.createElement('div');
        textDiv.className = 'message-text';
        const shimmer = document.createElement('span');
        shimmer.className = 'oc-shimmer';
        shimmer.textContent = 'Thinking…';
        textDiv.appendChild(shimmer);

        thinkingDiv.appendChild(this.buildMessageHead('assistant', timeDiv));
        thinkingDiv.appendChild(textDiv);

        this.elements.chatMessages.appendChild(thinkingDiv);
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    hideThinkingIndicator() {
        const thinkingIndicator = document.getElementById('thinking-indicator');
        if (thinkingIndicator) {
            thinkingIndicator.remove();
        }
    }

    showInteractionIndicator(text, interactive) {
        if (!this.elements.interactionIndicator || !this.elements.interactionText) return;
        
        this.elements.interactionText.textContent = text;
        this.elements.interactionIndicator.className = `interaction-indicator show ${interactive ? 'interactive' : 'non-interactive'}`;
        
        setTimeout(() => {
            this.elements.interactionIndicator.classList.remove('show');
        }, 2000);
    }

    showListeningAnimation() {
        if (!this.elements.listeningContainer) {
            console.warn('❌ Listening container not found');
            return;
        }
        
        // Show the listening animation
        this.elements.listeningContainer.classList.add('active');
        
        // Start the duration timer
        this.listeningStartTime = Date.now();
        this.listeningTimer = setInterval(() => {
            this.updateListeningDuration();
        }, 100);
        
        // Auto-scroll to show the listening animation
        if (this.elements.chatMessages) {
            this.elements.chatMessages.scrollTop = 0;
        }
    }

    hideListeningAnimation() {
        if (this.elements.listeningContainer) {
            this.elements.listeningContainer.classList.remove('active');
        }
        
        // Clear interim text
        this.clearInterimText();
        
        // Clear the duration timer
        if (this.listeningTimer) {
            clearInterval(this.listeningTimer);
            this.listeningTimer = null;
        }
        
        this.listeningStartTime = null;
    }

    updateListeningDuration() {
        if (!this.listeningStartTime || !this.elements.listeningDuration) return;
        
        const elapsed = Date.now() - this.listeningStartTime;
        const seconds = Math.floor(elapsed / 1000);
        const milliseconds = Math.floor((elapsed % 1000) / 100);
        
        const formattedTime = `${seconds.toString().padStart(2, '0')}:${milliseconds}`;
        this.elements.listeningDuration.textContent = formattedTime;
    }

    showInterimText(text) {
        if (!this.elements.listeningContainer) return;
        
        // Find or create interim text element
        let interimElement = this.elements.listeningContainer.querySelector('.interim-text');
        if (!interimElement) {
            interimElement = document.createElement('div');
            interimElement.className = 'interim-text';
            interimElement.style.cssText = `
                color: var(--oc-text-2);
                font-size: var(--oc-fs-sm);
                font-style: italic;
                margin-top: 8px;
                padding: 4px 12px;
                background: var(--oc-raised);
                border: 1px solid var(--oc-line);
                border-radius: var(--oc-r-pill);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            `;
            this.elements.listeningContainer.appendChild(interimElement);
        }
        
        interimElement.textContent = text || 'Waiting for speech...';
    }

    clearInterimText() {
        if (!this.elements.listeningContainer) return;
        
        const interimElement = this.elements.listeningContainer.querySelector('.interim-text');
        if (interimElement) {
            interimElement.remove();
        }
    }
}

    // Initialize when DOM is loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            new ChatWindowUI();
        });
    } else {
        new ChatWindowUI();
    }

} catch (error) {
    console.error('💥 CHAT-WINDOW.JS: Script execution failed!', error);
    console.error('💥 CHAT-WINDOW.JS: Error stack:', error.stack);
}