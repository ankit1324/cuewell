const { GoogleGenAI } = require('@google/genai');
const { URL: NodeURL } = require('url');
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');
const {
  getActiveProviderId,
  getProviderConfig,
  getModel,
  getBaseURL,
  isConfigured,
  createProvider
} = require('./providers');
const { fromGeminiRequest } = require('./providers/convert');
const { getFallbackChain, classifyFailure, fallbackNote, shortLabel } = require('./providers/fallback');
const { MAX_TOKENS_NO_TEXT } = require('./providers/errors');
const {
  cancelledError,
  isCancelledError,
  isAborted,
  throwIfCancelled,
  raceCancel,
  cancellableDelay
} = require('./cancellation');

// How long a backup Ollama server may take to accept a connection.
const OLLAMA_PROBE_TIMEOUT_MS = 1500;

class LLMService {
  /**
   * `providerId` (optional) pins the service to that provider instead of
   * LLM_PROVIDER. Such a service answers one request as the backup for the
   * selected provider (see _withProviderFallback) and never falls back itself.
   */
  constructor({ providerId = null } = {}) {
    this.fixedProviderId = providerId;
    this.client = null;
    this.model = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    // Active AI provider (LLM_PROVIDER). Gemini uses this.client; every other
    // provider uses this.provider from ./providers.
    this.providerId = null;
    this.provider = null;
    // Prompt settings main.js keeps current: answer length (Settings) and
    // the About you details and interview context (userData/profile.json).
    this.promptContext = { answerLength: 'auto', profile: null };
    
    this.initializeClient();
  }

  /** Update the answer length and/or profile (About you, interview context) used in every prompt. */
  setPromptContext({ answerLength, profile } = {}) {
    if (answerLength !== undefined) {
      this.promptContext.answerLength = promptLoader.isAnswerLength(answerLength) ? answerLength : 'auto';
    }
    if (profile !== undefined) {
      this.promptContext.profile = profile && typeof profile === 'object' ? { ...profile } : null;
    }
  }

  /**
   * Whether to retag every code fence with the selected language. Only in
   * Coding mode: Auto answers theory questions too, whose examples may be in
   * the language they are about (TypeScript, SQL, ...).
   */
  shouldRetagCode(activeSkill, programmingLanguage) {
    return !!programmingLanguage && promptLoader.normalizeSkillName(activeSkill) === 'dsa';
  }

  /** System prompt for one request in `activeSkill` mode over `channel` ('voice' | 'text' | 'image'). */
  buildSystemPrompt(activeSkill, programmingLanguage, channel) {
    return promptLoader.buildSystemPrompt({
      mode: activeSkill,
      programmingLanguage,
      channel,
      answerLength: this.promptContext.answerLength,
      profile: this.promptContext.profile
    });
  }

  // ---------- Questions, with provider fallback ----------
  //
  // Each public method below asks the selected provider. When that fails
  // for a reason on the provider's side, _withProviderFallback asks the next
  // configured backup provider once (Settings > AI provider). Their
  // arguments and results are those of the _-prefixed methods; options may
  // also hold providerFallback: false, which asks the selected provider only.

  processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, options = {}) {
    return this._withProviderFallback(options, { needsImages: true }, (service) =>
      service._processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage, options));
  }

  processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null, onReset = null, options = {}) {
    const live = this._trackLiveText(onDelta, onReset);
    return this._withProviderFallback(options, { needsImages: true, beforeFallback: live.clear }, (service) =>
      service._processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage, live.onDelta, live.onReset, options));
  }

  processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null, options = {}) {
    return this._withProviderFallback(options, {}, (service) =>
      service._processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage, options));
  }

  processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null, onReset = null, options = {}) {
    const live = this._trackLiveText(onDelta, onReset);
    return this._withProviderFallback(options, { beforeFallback: live.clear }, (service) =>
      service._processTextWithSkillStream(text, activeSkill, sessionMemory, programmingLanguage, live.onDelta, live.onReset, options));
  }

  processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null, options = {}) {
    return this._withProviderFallback(options, {}, (service) =>
      service._processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory, programmingLanguage, options));
  }

  processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null, onReset = null, options = {}) {
    const live = this._trackLiveText(onDelta, onReset);
    return this._withProviderFallback(options, { beforeFallback: live.clear }, (service) =>
      service._processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory, programmingLanguage, live.onDelta, live.onReset, options));
  }

  /**
   * The caller's onDelta/onReset, plus clear(): calls onReset when text is
   * on screen, so a backup provider's answer never follows the failed
   * provider's partial text.
   */
  _trackLiveText(onDelta, onReset) {
    let shown = false;
    const reset = () => {
      shown = false;
      if (typeof onReset === 'function') onReset();
    };
    return {
      onDelta: (delta) => {
        if (delta) shown = true;
        if (typeof onDelta === 'function') onDelta(delta);
      },
      onReset: reset,
      clear: () => {
        if (!shown) return;
        try {
          reset();
        } catch (error) {
          logger.warn('Live text reset failed', { error: error.message });
        }
      }
    };
  }

  /**
   * Run `run(this)`. When it fails for a reason on the provider's side
   * (classifyFailure), run it once more on the first backup provider that
   * is on, configured, able to read images when `needsImages`, and (for
   * Ollama) reachable. A stop, a refusal, or no backup rethrows the first
   * error. The backup's result names it in metadata.providerFallback and
   * metadata.providerNote. `beforeFallback` runs just before the backup.
   */
  /**
   * Attempts for one model: all of `configured` normally, at most 2 (one
   * retry) while a backup provider is ready to take over.
   */
  _retryBudget(configured) {
    const max = Math.max(1, Number(configured) || 1);
    return this._backupAvailable ? Math.min(max, 2) : max;
  }

  async _withProviderFallback(options, { needsImages = false, beforeFallback = null } = {}, run) {
    const signal = (options && options.signal) || null;
    if ((options && options.providerFallback === false) || this.fixedProviderId) {
      return run(this);
    }
    // With a backup ready, the selected provider gives up sooner (see
    // _retryBudget) so the backup answers in seconds, not after every retry.
    this._backupAvailable = getFallbackChain(this.providerId, process.env, { needsImages }).length > 0;
    try {
      return await run(this);
    } catch (error) {
      this._rethrowIfCancelled(error, signal);
      const failure = classifyFailure(error);
      const primaryId = this.providerId;
      if (!failure.fallback) throw error;

      for (const id of getFallbackChain(primaryId, process.env, { needsImages })) {
        if (id === 'ollama' && !(await this._isOllamaReachable())) {
          logger.info('Skipping the Ollama backup: its server is not reachable', { from: primaryId });
          continue;
        }
        throwIfCancelled(signal);
        const backup = this._createFallbackService(id);
        if (!backup || !backup.isInitialized) continue;

        logger.warn('AI provider failed; asking the backup provider', {
          from: primaryId, to: id, kind: failure.kind
        });
        if (typeof beforeFallback === 'function') beforeFallback();
        try {
          const result = await run(backup);
          throwIfCancelled(signal);
          result.metadata = {
            ...(result.metadata || {}),
            provider: id,
            providerFallback: { from: primaryId, to: id, kind: failure.kind, reason: failure.reason },
            providerNote: fallbackNote(primaryId, id, failure.reason)
          };
          return result;
        } catch (backupError) {
          this._rethrowIfCancelled(backupError, signal);
          logger.warn('Backup AI provider failed too', {
            from: primaryId, to: id, error: backupError && backupError.message
          });
          // One backup per question: say both failed, with the selected
          // provider's reason first.
          const both = new Error(`${error.message} ${shortLabel(id)} was tried instead and failed too.`);
          both.cause = error;
          both.backupError = backupError;
          both.isUserFacing = true;
          throw both;
        }
      }
      throw error;
    }
  }

  /** A service pinned to provider `id`, sharing this one's prompt settings. */
  _createFallbackService(id) {
    const backup = new LLMService({ providerId: id });
    backup.promptContext = this.promptContext;
    return backup;
  }

  /** True when the Ollama server accepts a connection within OLLAMA_PROBE_TIMEOUT_MS. */
  async _isOllamaReachable() {
    try {
      const url = new NodeURL(getBaseURL('ollama'));
      const port = Number(url.port) || (url.protocol === 'http:' ? 80 : 443);
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      return await this.testNetworkConnection({ host, port, timeoutMs: OLLAMA_PROBE_TIMEOUT_MS });
    } catch (_) {
      return false;
    }
  }

  initializeClient() {
    const providerId = this.fixedProviderId || getActiveProviderId();
    const previousProviderId = this.providerId;
    this.providerId = providerId;

    if (providerId !== 'gemini') {
      this._initializeProvider(providerId);
      return;
    }

    this.provider = null;
    if (previousProviderId && previousProviderId !== 'gemini') {
      // Switching back from another provider: drop its state so a missing
      // Gemini key leaves the service uninitialized instead of half-wired.
      this.client = null;
      this.model = null;
      this.isInitialized = false;
    }

    const apiKey = config.getApiKey('GEMINI');
    
    if (!apiKey || apiKey === 'your-api-key-here') {
      logger.warn('Gemini API key not configured', { 
        keyExists: !!apiKey,
        isPlaceholder: apiKey === 'your-api-key-here'
      });
      return;
    }

    try {
      this.client = new GoogleGenAI({ apiKey });
      
      // GEMINI_MODEL from .env when set, otherwise the configured default
      this.model = getModel('gemini');
      this.isInitialized = true;
      
      logger.info('Gemini AI client initialized successfully', {
        model: this.model
      });
    } catch (error) {
      logger.error('Failed to initialize Gemini client', { 
        error: error.message 
      });
    }
  }

  /** Set up a non-Gemini provider. Never reuses the Gemini client or a stale provider. */
  _initializeProvider(providerId) {
    const label = getProviderConfig(providerId).label;
    this.client = null;
    this.provider = null;
    this.isInitialized = false;
    this.model = getModel(providerId);

    if (!isConfigured(providerId)) {
      logger.warn(`${label} API key not configured`, { provider: providerId });
      return;
    }

    try {
      this.provider = createProvider(providerId);
      this.isInitialized = true;
      logger.info(`${label} client initialized successfully`, {
        provider: providerId,
        model: this.model
      });
    } catch (error) {
      this.provider = null;
      logger.error(`Failed to initialize ${label} client`, {
        provider: providerId,
        error: error.message
      });
    }
  }

  getGenerationConfig(overrides = {}) {
    const defaults = config.get('llm.gemini.generation') || {};
    const fallback = {
      temperature: 0.7,
      topK: 40,
      topP: 0.95,
      maxOutputTokens: 4096,
      thinkingConfig: { thinkingBudget: 0 }
    };

    const merged = { ...fallback, ...defaults, ...overrides };
    return Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined && value !== null)
    );
  }

  applyGenerationDefaults(request, overrides = {}) {
    request.generationConfig = this.getGenerationConfig({ ...(request.generationConfig || {}), ...overrides });
    return request;
  }

  extractTextFromCandidates(response) {
    // New @google/genai SDK exposes response.text as a convenience getter.
    if (response && typeof response.text === 'string' && response.text.trim().length > 0) {
      return {
        text: response.text.trim(),
        candidate: response.candidates?.[0] || null,
        finishReason: response.candidates?.[0]?.finishReason || null
      };
    }

    const candidates = Array.isArray(response?.candidates)
      ? response.candidates
      : Array.isArray(response)
        ? response
        : [];

    if (!candidates.length) {
      throw new Error('No candidates in Gemini response');
    }

    const candidateWithText = candidates.find(candidate => {
      const parts = candidate?.content?.parts;
      return Array.isArray(parts) && parts.some(part => typeof part.text === 'string' && part.text.trim().length > 0);
    });

    if (!candidateWithText) {
      const finishReasons = candidates.map(c => c.finishReason || 'unknown').join(', ');
      throw new Error(`No text parts in candidates. Finish reasons: ${finishReasons}`);
    }

    const textParts = candidateWithText.content.parts
      .filter(part => typeof part.text === 'string' && part.text.trim().length > 0)
      .map(part => part.text.trim());

    if (!textParts.length) {
      throw new Error(`Candidate parts missing text after filtering: ${JSON.stringify(candidateWithText)}`);
    }

    const text = textParts.join('\n');

    return {
      text,
      candidate: candidateWithText,
      finishReason: candidateWithText.finishReason || null
    };
  }

  /**
   * Process an image directly with Gemini using the active skill prompt.
   * The image buffer is sent as inlineData alongside a concise instruction.
   * For image-based queries, we include the skill prompt (e.g., DSA) as systemInstruction.
   * @param {Buffer} imageBuffer - PNG/JPEG image bytes
   * @param {string} mimeType - e.g., 'image/png' or 'image/jpeg'
   * @param {string} activeSkill - current skill (e.g. 'dsa')
   * @param {Array} _sessionMemory - unused: images are sent without history
   * @param {string|null} programmingLanguage - optional language context for skills that need it
   * @param {{signal?: AbortSignal}} options - `signal` stops the request (see ./cancellation.js)
   * @returns {Promise<{response: string, metadata: object}>}
   */
  async _processImageWithSkill(imageBuffer, mimeType, activeSkill, _sessionMemory = [], programmingLanguage = null, options = {}) {
    const signal = (options && options.signal) || null;
    if (!this.isInitialized) {
      throw new Error(this._providerCopy().notInitialized);
    }

    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkill');
    }

    // Thrown before the fallback-response handling below so the user sees why.
    this._assertImagesSupported();

    const startTime = Date.now();
    this.requestCount++;

    try {
      // System instruction: mode prompt, answer format and interview context
      const skillPrompt = this.buildSystemPrompt(activeSkill, programmingLanguage, 'image');

      // Build request with text + image parts
      const base64 = imageBuffer.toString('base64');

      const request = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: this.formatImageInstruction(activeSkill, programmingLanguage) },
              { inlineData: { data: base64, mimeType } }
            ]
          }
        ]
      };

      this.applyGenerationDefaults(request);

      if (skillPrompt && skillPrompt.trim().length > 0) {
        request.systemInstruction = { parts: [{ text: skillPrompt }] };
      }

      // Execute with retries/timeout - try alternative method first for network reliability
      let responseText;
      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for reliability');
          responseText = await this.executeAlternativeRequest(request, signal);
        } else {
          responseText = await this.executeRequest(request, signal);
        }
      } catch (error) {
        this._rethrowIfCancelled(error, signal);
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, { error: error.message });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);

        try {
          responseText = await secondaryFn(request, signal);
        } catch (secondaryError) {
          this._rethrowIfCancelled(secondaryError, signal);
          logger.error('Both Gemini request methods failed', {
            firstError: error.message,
            secondError: secondaryError.message
          });
          throw secondaryError;
        }
      }

      // Enforce language in code fences if provided
      const finalResponse = this.shouldRetagCode(activeSkill, programmingLanguage)
        ? this.enforceProgrammingLanguage(responseText, programmingLanguage)
        : responseText;

      logger.logPerformance('LLM image processing', startTime, {
        activeSkill,
        imageSize: imageBuffer.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isImageAnalysis: true,
          mimeType
        }
      };
    } catch (error) {
      this._rethrowIfCancelled(error, signal);
      this.errorCount++;
      logger.error('LLM image processing failed', {
        error: error.message,
        activeSkill,
        requestId: this.requestCount
      });

      throw this._userFacingError(error);
    }
  }

  async _processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null, onReset = null, options = {}) {
    const signal = (options && options.signal) || null;
    if (!this.isInitialized) {
      throw new Error(this._providerCopy().notInitialized);
    }

    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkillStream');
    }

    this._assertImagesSupported();

    const startTime = Date.now();
    this.requestCount++;
    const live = this._createLiveText(onDelta, onReset);

    try {
      const skillPrompt = this.buildSystemPrompt(activeSkill, programmingLanguage, 'image');
      const base64 = imageBuffer.toString('base64');

      const geminiRequest = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: this.formatImageInstruction(activeSkill, programmingLanguage) },
              { inlineData: { data: base64, mimeType } }
            ]
          }
        ]
      };
      this.applyGenerationDefaults(geminiRequest);
      if (skillPrompt && skillPrompt.trim().length > 0) {
        geminiRequest.systemInstruction = { parts: [{ text: skillPrompt }] };
      }

      const fullText = await this.executeStreamingRequest(geminiRequest, live.onDelta, live.onAttemptStart, signal);

      const finalResponse = this.shouldRetagCode(activeSkill, programmingLanguage)
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM image streaming', startTime, {
        activeSkill,
        imageSize: imageBuffer.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isImageAnalysis: true,
          mimeType
        }
      };
    } catch (error) {
      // A stopped answer keeps the text shown so far: no reset, no fallback.
      this._rethrowIfCancelled(error, signal);
      logger.warn('Streaming image analysis failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      live.onAttemptStart();
      return this.processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage, { signal, providerFallback: false });
    }
  }

  formatImageInstruction(activeSkill, programmingLanguage) {
    return promptLoader.getImageInstruction(activeSkill, programmingLanguage);
  }

  async _processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null, options = {}) {
    const signal = (options && options.signal) || null;
    if (!this.isInitialized) {
      throw new Error(this._providerCopy().notInitialized);
    }

    const startTime = Date.now();
    this.requestCount++;
    
    try {
      logger.info('Processing text with LLM', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let response;
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for text processing');
          response = await this.executeAlternativeRequest(geminiRequest, signal);
        } else {
          response = await this.executeRequest(geminiRequest, signal);
        }
      } catch (error) {
        this._rethrowIfCancelled(error, signal);
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, {
          error: error.message,
          requestId: this.requestCount
        });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        try {
          response = await secondaryFn(geminiRequest, signal);
        } catch (secondaryError) {
          this._rethrowIfCancelled(secondaryError, signal);
          logger.error('Both Gemini request methods failed for text processing', {
            firstError: error.message,
            secondError: secondaryError.message,
            requestId: this.requestCount
          });
          throw secondaryError;
        }
      }
      
      // Enforce language in code fences if programmingLanguage specified
      const finalResponse = this.shouldRetagCode(activeSkill, programmingLanguage)
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM text processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false
        }
      };
    } catch (error) {
      this._rethrowIfCancelled(error, signal);
      this.errorCount++;
      logger.error('LLM processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      throw this._userFacingError(error);
    }
  }

  async _processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null, onReset = null, options = {}) {
    const signal = (options && options.signal) || null;
    if (!this.isInitialized) {
      throw new Error(this._providerCopy().notInitialized);
    }

    const startTime = Date.now();
    this.requestCount++;
    const live = this._createLiveText(onDelta, onReset);

    try {
      const geminiRequest = this.buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const fullText = await this.executeStreamingRequest(geminiRequest, live.onDelta, live.onAttemptStart, signal);

      const finalResponse = this.shouldRetagCode(activeSkill, programmingLanguage)
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM text streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true
        }
      };
    } catch (error) {
      // A stopped answer keeps the text shown so far: no reset, no fallback.
      this._rethrowIfCancelled(error, signal);
      logger.warn('Streaming text failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      live.onAttemptStart();
      return this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage, { signal, providerFallback: false });
    }
  }

  async _processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null, options = {}) {
    const signal = (options && options.signal) || null;
    if (!this.isInitialized) {
      throw new Error(this._providerCopy().notInitialized);
    }

    const startTime = Date.now();
    this.requestCount++;
    
    try {
      logger.info('Processing transcription with intelligent response', {
        activeSkill,
        textLength: text.length,
        hasSessionMemory: sessionMemory.length > 0,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      const geminiRequest = this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const preferAlternative = !!config.get('llm.gemini.enableFallbackMethod');
      let response;
      try {
        if (preferAlternative) {
          logger.debug('Attempting alternative HTTPS method first for transcription processing');
          response = await this.executeAlternativeRequest(geminiRequest, signal);
        } else {
          response = await this.executeRequest(geminiRequest, signal);
        }
      } catch (error) {
        this._rethrowIfCancelled(error, signal);
        const secondaryLabel = preferAlternative ? 'primary SDK method' : 'alternative HTTPS method';
        logger.warn(`${preferAlternative ? 'Alternative' : 'Primary'} method failed, trying ${secondaryLabel}`, {
          error: error.message,
          requestId: this.requestCount
        });
        const secondaryFn = preferAlternative ? this.executeRequest.bind(this) : this.executeAlternativeRequest.bind(this);
        try {
          response = await secondaryFn(geminiRequest, signal);
        } catch (secondaryError) {
          this._rethrowIfCancelled(secondaryError, signal);
          logger.error('Both Gemini request methods failed for transcription processing', {
            firstError: error.message,
            secondError: secondaryError.message,
            requestId: this.requestCount
          });
          throw secondaryError;
        }
      }
      
      // Enforce language in code fences if programmingLanguage specified
      const finalResponse = this.shouldRetagCode(activeSkill, programmingLanguage)
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      logger.logPerformance('LLM transcription processing', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      this._rethrowIfCancelled(error, signal);
      this.errorCount++;
      logger.error('LLM transcription processing failed', {
        error: error.message,
        activeSkill,
        programmingLanguage: programmingLanguage || 'not specified',
        requestId: this.requestCount
      });

      throw this._userFacingError(error);
    }
  }

  /**
   * Retag fenced code blocks with the selected programming language.
   * Walks the text line by line with CommonMark-style fence state. Outside a
   * fence, a line starting with 3+ backticks or tildes opens one; the line
   * that closes it (same character, at least as long, only spaces or tabs
   * after, indented at most 3 more than the opener) stays a plain fence.
   * Only an opener indented up to 3 spaces is retagged (~~~ becomes ```).
   * Deeper ones, as in some nested lists, are tracked but left as written,
   * so their closing lines are never mistaken for openers. Code inside a
   * fence and triple backticks inside a line (inline code like
   * ```solve()```) are never changed. An unclosed fence, as in a cut-off
   * answer, runs to the end.
   */
  enforceProgrammingLanguage(text, programmingLanguage) {
    try {
      if (!text || !programmingLanguage) return text;
      const norm = String(programmingLanguage).toLowerCase();
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const fenceTag = fenceTagMap[norm] || norm || 'text';

      // Lines sit at even indexes and their line breaks at odd ones, so
      // join('') rebuilds the text with only the fence lines rewritten.
      const parts = text.split(/(\r\n?|\n)/);
      const fenceLine = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
      let fence = null; // the open fence
      // A retagged ~~~ fence becomes a ``` fence longer than any backtick run
      // that starts a line inside it, so that line cannot close it early. The
      // opener is rewritten once the fence ends.
      const toBackticks = (closeAt, closeIndent) => {
        const ticks = '`'.repeat(Math.max(fence.size, fence.innerTicks + 1));
        parts[fence.at] = fence.indent + ticks + fence.tag;
        if (closeAt >= 0) parts[closeAt] = closeIndent + ticks;
      };

      for (let i = 0; i < parts.length; i += 2) {
        const m = parts[i].match(fenceLine);
        if (fence) {
          if (m && m[2][0] === fence.char && m[2].length >= fence.size &&
              /^[ \t]*$/.test(m[3]) && m[1].length <= fence.indent.length + 3) {
            if (fence.convert) toBackticks(i, m[1]);
            fence = null;
          } else if (fence.convert) {
            const run = parts[i].match(/^[ \t]*(`{3,})/);
            if (run) fence.innerTicks = Math.max(fence.innerTicks, run[1].length);
          }
          continue; // code inside a fence is never changed
        }
        if (!m) continue;
        const mark = m[2][0];
        const info = m[3].trim();
        // A backtick fence's info string has no backticks, so a line that
        // starts with inline code such as ```solve()``` is not a fence.
        if (mark === '`' && info.includes('`')) continue;
        const retag = /^ {0,3}$/.test(m[1]);
        const keepTag = info.split(/\s+/)[0].toLowerCase() === fenceTag && !info.includes('`');
        fence = {
          char: mark,
          size: m[2].length,
          at: i,
          indent: m[1],
          tag: keepTag ? info : fenceTag,
          convert: retag && mark === '~',
          innerTicks: 0
        };
        if (retag && mark === '`' && !keepTag) parts[i] = m[1] + m[2] + fenceTag;
      }
      if (fence && fence.convert) toBackticks(-1, '');

      return parts.join('');
    } catch (_) {
      return text;
    }
  }

  buildGeminiRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');
    
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(15);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to old method for compatibility - now with programming language support
    const requestComponents = promptLoader.getRequestComponents(
      activeSkill, 
      text, 
      sessionMemory,
      programmingLanguage
    );

    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Every request carries the mode prompt, answer format and interview context
    const systemPrompt = this.buildSystemPrompt(activeSkill, programmingLanguage, 'text');
    request.systemInstruction = {
      parts: [{ text: systemPrompt }]
    };

    logger.debug('Using mode system instruction', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      promptLength: systemPrompt.length,
      requiresProgrammingLanguage: requestComponents.requiresProgrammingLanguage
    });

    request.contents.push({
      role: 'user',
      parts: [{ text: this.formatUserMessage(text, activeSkill) }]
    });

    return request;
  }

  /**
   * History contents ({ role, parts }) without trailing user turns identical
   * to `currentText`. Callers store the message in session memory before the
   * request is built and the builders append it after the history, so
   * without this the current message would be sent twice.
   */
  _withoutTrailingCopies(contents, currentText) {
    const target = typeof currentText === 'string' ? currentText.trim() : '';
    let end = contents.length;
    while (target && end > 0 && contents[end - 1].role === 'user' &&
           contents[end - 1].parts.map((part) => part.text).join('') === target) {
      end--;
    }
    return contents.slice(0, end);
  }

  buildGeminiRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Mode prompt (with the coding language for Coding), answer format and
    // interview context
    const systemPrompt = this.buildSystemPrompt(activeSkill, programmingLanguage, 'text');
    request.systemInstruction = {
      parts: [{ text: systemPrompt }]
    };

    logger.debug('Using mode system instruction', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      promptLength: systemPrompt.length,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    // Add conversation history (excluding system messages) with validation
    const conversationContents = conversationHistory
      .filter(event => {
        return event.role !== 'system' && 
               event.content && 
               typeof event.content === 'string' && 
               event.content.trim().length > 0;
      })
      .map(event => {
        const content = event.content.trim();
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      });

    // Add the conversation history, minus trailing copies of the current
    // message (callers store it in session memory before building the request)
    request.contents.push(...this._withoutTrailingCopies(conversationContents, text));

    // Format and validate the current user input
    const formattedMessage = this.formatUserMessage(text, activeSkill);
    if (!formattedMessage || formattedMessage.trim().length === 0) {
      throw new Error('Failed to format user message or message is empty');
    }

    // Add the current user input
    request.contents.push({
      role: 'user',
      parts: [{ text: formattedMessage }]
    });

    logger.debug('Built Gemini request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSystemInstruction: !!request.systemInstruction,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage) {
    // Validate input text first
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided to buildIntelligentTranscriptionRequest');
    }

    // Check if we have the new conversation history format
    const sessionManager = require('../managers/session.manager');
    
    if (sessionManager && typeof sessionManager.getConversationHistory === 'function') {
      const conversationHistory = sessionManager.getConversationHistory(10);
      const skillContext = sessionManager.getSkillContext(activeSkill, programmingLanguage);
      return this.buildIntelligentTranscriptionRequestWithHistory(cleanText, activeSkill, conversationHistory, skillContext, programmingLanguage);
    }

    // Fallback to basic intelligent request
    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Add intelligent filtering system instruction
    const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
    if (!intelligentPrompt) {
      throw new Error('Failed to generate intelligent transcription prompt');
    }

    request.systemInstruction = {
      parts: [{ text: intelligentPrompt }]
    };

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    logger.debug('Built basic intelligent transcription request', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      textLength: cleanText.length,
      hasSystemInstruction: !!request.systemInstruction
    });

    return request;
  }

  buildIntelligentTranscriptionRequestWithHistory(text, activeSkill, conversationHistory, skillContext, programmingLanguage) {
    const request = {
      contents: []
    };

    this.applyGenerationDefaults(request);

    // Voice uses the same mode prompt as typed questions, with voice handling
    const intelligentPrompt = this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
    request.systemInstruction = { parts: [{ text: intelligentPrompt }] };

    // Recent conversation history (excluding system messages) with validation
    const historyContents = conversationHistory
      .filter(event => {
        // Filter out system messages and ensure content exists and is valid
        return event.role !== 'system' && 
               event.content && 
               typeof event.content === 'string' && 
               event.content.trim().length > 0;
      })
      .map(event => {
        const content = event.content.trim();
        if (!content) {
          logger.warn('Empty content found in conversation history', { event });
          return null;
        }
        return {
          role: event.role === 'model' ? 'model' : 'user',
          parts: [{ text: content }]
        };
      })
      .filter(content => content !== null); // Remove any null entries

    // Keep last 8 exchanges for context, not counting the transcript itself
    // (dispatch stores it in session memory before the request is built)
    const conversationContents = this._withoutTrailingCopies(historyContents, text).slice(-8);

    // Add the conversation history
    request.contents.push(...conversationContents);

    // Validate and add the current transcription
    const cleanText = text && typeof text === 'string' ? text.trim() : '';
    if (!cleanText) {
      throw new Error('Empty or invalid transcription text provided');
    }

    request.contents.push({
      role: 'user',
      parts: [{ text: cleanText }]
    });

    // Ensure we have at least one content item
    if (request.contents.length === 0) {
      throw new Error('No valid content to send to Gemini API');
    }

    logger.debug('Built intelligent transcription request with conversation history', {
      skill: activeSkill,
      programmingLanguage: programmingLanguage || 'not specified',
      historyLength: conversationHistory.length,
      totalContents: request.contents.length,
      hasSkillPrompt: !!skillContext.skillPrompt,
      cleanTextLength: cleanText.length,
      requiresProgrammingLanguage: skillContext.requiresProgrammingLanguage || false
    });

    return request;
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    return this.buildSystemPrompt(activeSkill, programmingLanguage, 'voice');
  }

  formatUserMessage(text, activeSkill) {
    return `Interview mode: ${promptLoader.getModeLabel(activeSkill)}\n\nQuestion:\n${text}`;
  }

  /**
   * One Gemini answer through the SDK, with retries and fallback models.
   * `signal` (optional AbortSignal) stops it at once, including during a
   * retry wait, and no further attempt or model is tried.
   */
  async executeRequest(geminiRequest, signal = null) {
    if (this.providerId !== 'gemini') {
      return this.executeProviderRequest(geminiRequest, null, { signal });
    }

    const maxRetries = this._retryBudget(config.get('llm.gemini.maxRetries'));
    const timeout = config.get('llm.gemini.timeout');
    const primaryModel = this.model;
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    logger.debug('Executing Gemini request', {
      hasModel: !!this.model,
      hasClient: !!this.client,
      requestKeys: Object.keys(geminiRequest),
      timeout,
      maxRetries,
      modelsToTry,
      nodeVersion: process.version,
      platform: process.platform
    });

    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        throwIfCancelled(signal);
        try {
          let timeoutTimer = null;
          const timeoutPromise = new Promise((_, reject) => {
            timeoutTimer = setTimeout(() => reject(new Error('Request timeout')), timeout);
          });

          logger.debug(`Gemini API attempt ${attempt} starting with model ${modelName}`, {
            timestamp: new Date().toISOString(),
            timeout,
            model: modelName
          });

          const requestPromise = this.client.models.generateContent({
            model: modelName,
            contents: geminiRequest.contents,
            config: signal
              ? { ...geminiRequest.generationConfig, abortSignal: signal }
              : geminiRequest.generationConfig,
            systemInstruction: geminiRequest.systemInstruction
          });
          // The timer is cleared once the call settles, so a stopped or
          // finished request leaves nothing running.
          const result = await raceCancel(Promise.race([requestPromise, timeoutPromise]), signal)
            .finally(() => clearTimeout(timeoutTimer));

          if (!result) {
            throw new Error('Empty response from Gemini API');
          }

          const { text, finishReason } = this.extractTextFromCandidates(result);

          if (finishReason === 'MAX_TOKENS') {
            logger.warn('Gemini response reached max tokens limit', {
              attempt,
              finishReason,
              model: modelName
            });
          }

          logger.debug('Gemini API request successful', {
            attempt,
            model: modelName,
            responseLength: text.length,
            finishReason
          });

          return text;
        } catch (error) {
          this._rethrowIfCancelled(error, signal);
          const errorInfo = this.analyzeError(error);
          lastError = error;
          // A rejected key fails the same way on every attempt and model.
          if (errorInfo.type === 'AUTH_ERROR') throw error;

          // Enhanced error logging for fetch failures
          if (errorInfo.type === 'NETWORK_ERROR') {
            logger.error('Network error details', {
              attempt,
              model: modelName,
              errorMessage: error.message,
              errorStack: error.stack,
              errorName: error.name,
              nodeEnv: process.env.NODE_ENV,
              electronVersion: process.versions.electron,
              chromeVersion: process.versions.chrome,
              nodeVersion: process.versions.node,
              userAgent: this.getUserAgent()
            });
          }

          logger.warn(`Gemini API attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            errorType: errorInfo.type,
            isNetworkError: errorInfo.isNetworkError,
            suggestedAction: errorInfo.suggestedAction,
            remainingAttempts: maxRetries - attempt,
            model: modelName
          });

          // For model-unavailable / overloaded / rate-limit errors, move to
          // the next fallback model immediately instead of burning all retries.
          const isModelUnavailable = errorInfo.type === 'RATE_LIMIT_ERROR' ||
            error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand');

          if (isModelUnavailable && modelName !== modelsToTry[modelsToTry.length - 1]) {
            logger.info(`Switching to fallback model after ${modelName} unavailable`, {
              model: modelName,
              error: error.message
            });
            break; // exit retry loop for this model and try next model
          }

          if (attempt === maxRetries) {
            break; // exit retry loop for this model and try next model
          }

          // Use exponential backoff with jitter for network errors
          const baseDelay = errorInfo.isNetworkError ? 2500 : 1500;
          const delay = baseDelay * attempt + Math.random() * 1000;

          logger.debug(`Waiting ${delay}ms before retry ${attempt + 1}`, {
            baseDelay,
            isNetworkError: errorInfo.isNetworkError,
            model: modelName
          });

          await this.delay(delay, signal);
        }
      }
    }

    const finalErrorInfo = this.analyzeError(lastError);
    const finalError = new Error(`Gemini API failed after trying ${modelsToTry.join(', ')}: ${lastError?.message}`);
    finalError.errorAnalysis = finalErrorInfo;
    finalError.originalError = lastError;
    throw finalError;
  }

  /**
   * Streaming sibling of processTranscriptionWithIntelligentResponse. Emits
   * incremental text via onDelta so the UI can render the answer as it is
   * generated (much faster perceived latency). Returns the same
   * {response, metadata} shape. Falls back to the non-streaming path on any
   * streaming failure so reliability is never worse than before.
   */
  async _processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null, onReset = null, options = {}) {
    const signal = (options && options.signal) || null;
    if (!this.isInitialized) {
      throw new Error(this._providerCopy().notInitialized);
    }

    const startTime = Date.now();
    this.requestCount++;
    const live = this._createLiveText(onDelta, onReset);

    try {
      const geminiRequest = this.buildIntelligentTranscriptionRequest(text, activeSkill, sessionMemory, programmingLanguage);

      const fullText = await this.executeStreamingRequest(geminiRequest, live.onDelta, live.onAttemptStart, signal);

      const finalResponse = this.shouldRetagCode(activeSkill, programmingLanguage)
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('LLM transcription streaming', startTime, {
        activeSkill,
        textLength: text.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isTranscriptionResponse: true
        }
      };
    } catch (error) {
      // A stopped answer keeps the text shown so far: no reset, no fallback.
      this._rethrowIfCancelled(error, signal);
      logger.warn('Streaming transcription failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount
      });
      // Non-streaming path returns the same shape; the caller renders it as a
      // single final response. The partial text of the failed stream is
      // cleared first so it does not stay on screen while this runs.
      live.onAttemptStart();
      return this.processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory, programmingLanguage, { signal, providerFallback: false });
    }
  }

  /**
   * Live text for one streamed answer. onDelta forwards each piece to the
   * caller. onAttemptStart runs before every attempt (a retry, another model
   * or the non-streaming fallback): when an earlier attempt already showed
   * text it calls onReset once, so the caller clears that text instead of
   * the new attempt's text being appended to it.
   */
  _createLiveText(onDelta, onReset) {
    let shown = false;
    return {
      onDelta: (delta) => {
        if (typeof onDelta !== 'function' || !delta) return;
        shown = true;
        onDelta(delta);
      },
      onAttemptStart: () => {
        if (!shown) return;
        shown = false;
        if (typeof onReset !== 'function') return;
        try {
          onReset();
        } catch (error) {
          logger.warn('Live text reset failed', { error: error.message });
        }
      }
    };
  }

  /** Safely pull the text delta out of a streamed Gemini chunk. */
  _extractChunkText(chunk) {
    try {
      const t = chunk && chunk.text;
      if (typeof t === 'string') {
        return t;
      }
    } catch (_) {
      // `.text` getter can throw on non-text parts; fall through to manual read.
    }
    try {
      const parts = (chunk && chunk.candidates && chunk.candidates[0] &&
        chunk.candidates[0].content && chunk.candidates[0].content.parts) || [];
      return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
    } catch (_) {
      return '';
    }
  }

  /**
   * Run a streaming Gemini request with the same model-fallback + retry policy
   * as executeRequest. Accumulates and returns the full text; invokes onDelta
   * for each chunk and onAttemptStart (optional) before every attempt.
   * `signal` (optional AbortSignal) stops it: the open stream is closed, no
   * chunk reaches onDelta after that, and no retry or fallback model runs.
   */
  async executeStreamingRequest(geminiRequest, onDelta, onAttemptStart = null, signal = null) {
    if (this.providerId !== 'gemini') {
      return this.executeProviderRequest(geminiRequest, onDelta, { onAttemptStart, signal });
    }

    const maxRetries = this._retryBudget(config.get('llm.gemini.maxRetries'));
    const apiKey = config.getApiKey('GEMINI');
    const primaryModel = this.model;
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    let lastError = null;

    for (const modelName of modelsToTry) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        throwIfCancelled(signal);
        if (typeof onAttemptStart === 'function') onAttemptStart();
        try {
          const fullText = await this._streamRequestForModel(geminiRequest, modelName, apiKey, onDelta, signal);

          if (!fullText) {
            throw new Error('Empty streamed response from Gemini API');
          }

          logger.debug('Gemini streaming request successful', {
            attempt,
            model: modelName,
            responseLength: fullText.length
          });

          return fullText;
        } catch (error) {
          this._rethrowIfCancelled(error, signal);
          const errorInfo = this.analyzeError(error);
          lastError = error;
          // A rejected key fails the same way on every attempt and model.
          if (errorInfo.type === 'AUTH_ERROR') throw error;

          logger.warn(`Gemini streaming attempt ${attempt} failed for model ${modelName}`, {
            error: error.message,
            errorType: errorInfo.type,
            remainingAttempts: maxRetries - attempt,
            model: modelName
          });

          const isModelUnavailable = errorInfo.type === 'RATE_LIMIT_ERROR' ||
            error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand');

          if (isModelUnavailable && modelName !== modelsToTry[modelsToTry.length - 1]) {
            break; // try next fallback model
          }

          if (attempt === maxRetries) {
            break;
          }

          const baseDelay = errorInfo.isNetworkError ? 2500 : 1500;
          const delay = baseDelay * attempt + Math.random() * 1000;
          await this.delay(delay, signal);
        }
      }
    }

    throw lastError || new Error('Gemini streaming request failed');
  }

  _streamRequestForModel(geminiRequest, modelName, apiKey, onDelta, signal = null) {
    if (isAborted(signal)) return Promise.reject(cancelledError());
    const https = require('https');
    const timeout = config.get('llm.gemini.timeout');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse`;
    const postData = JSON.stringify(geminiRequest);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      timeout,
      agent
    };

    return new Promise((resolve, reject) => {
      // A stop closes the connection; chunks already read are dropped.
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        reject(cancelledError());
        req.destroy();
      };
      const req = https.request(url, options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody}`)));
          return;
        }

        let fullText = '';
        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (cancelled) return;
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) {
              continue;
            }
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') {
              continue;
            }
            try {
              const json = JSON.parse(payload);
              const piece = this._extractChunkText(json);
              if (piece && !cancelled) {
                fullText += piece;
                if (typeof onDelta === 'function') {
                  onDelta(piece);
                }
              }
            } catch (_) {
              // Partial JSON across chunk boundaries is rare with line framing;
              // skip anything that doesn't parse cleanly.
            }
          }
        });

        res.on('end', () => resolve(fullText.trim()));
        res.on('error', (error) => reject(new Error(`Streaming response error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`Streaming request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Streaming request timeout'));
      });
      req.on('close', () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      });
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      req.write(postData);
      req.end();
    });
  }

  async performPreflightCheck() {
    // Gemini-only probe; other providers never touch the Gemini endpoint.
    if (this.providerId !== 'gemini') {
      return;
    }

    // Quick connectivity check
    try {
      const startTime = Date.now();
      await this.testNetworkConnection({ 
        host: 'generativelanguage.googleapis.com', 
        port: 443, 
        name: 'Gemini API Endpoint' 
      });
      const latency = Date.now() - startTime;
      
      logger.debug('Preflight check passed', { latency });
    } catch (error) {
      logger.warn('Preflight check failed', { 
        error: error.message,
        suggestion: 'Network connectivity issue detected before API call'
      });
      // Don't throw here - let the actual API call fail with more detail
    }
  }

  getUserAgent() {
    try {
      // Try to get user agent from Electron if available
      if (typeof navigator !== 'undefined' && navigator.userAgent) {
        return navigator.userAgent;
      }
      return `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    } catch {
      return 'Unknown';
    }
  }

  analyzeError(error) {
    const errorMessage = error.message.toLowerCase();
    
    // Network connectivity errors
    if (errorMessage.includes('fetch failed') || 
        errorMessage.includes('network error') ||
        errorMessage.includes('enotfound') ||
        errorMessage.includes('econnrefused') ||
        errorMessage.includes('timeout')) {
      return {
        type: 'NETWORK_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check internet connection and firewall settings'
      };
    }
    
    // API key errors
    if (errorMessage.includes('unauthorized') || 
        errorMessage.includes('invalid api key') ||
        errorMessage.includes('api key not valid') ||
        errorMessage.includes('api_key_invalid') ||
        errorMessage.includes('api key expired') ||
        errorMessage.includes('forbidden')) {
      return {
        type: 'AUTH_ERROR',
        isNetworkError: false,
        suggestedAction: 'Verify Gemini API key configuration'
      };
    }
    
    // Rate limiting
    if (errorMessage.includes('quota') || 
        errorMessage.includes('rate limit') ||
        errorMessage.includes('too many requests')) {
      return {
        type: 'RATE_LIMIT_ERROR',
        isNetworkError: false,
        suggestedAction: 'Wait before retrying or check API quota'
      };
    }
    
    // Timeout errors
    if (errorMessage.includes('request timeout') || errorMessage.includes('etimedout')) {
      return {
        type: 'TIMEOUT_ERROR',
        isNetworkError: true,
        suggestedAction: 'Check network latency or increase timeout'
      };
    }
    
    return {
      type: 'UNKNOWN_ERROR',
      isNetworkError: false,
      suggestedAction: 'Check logs for more details'
    };
  }

  async checkNetworkConnectivity() {
    const connectivityTests = this.providerId !== 'gemini'
      ? this._providerConnectivityTests()
      : [
        { host: 'google.com', port: 443, name: 'Google (HTTPS)' },
        { host: 'generativelanguage.googleapis.com', port: 443, name: 'Gemini API Endpoint' }
      ];

    const results = await Promise.allSettled(
      connectivityTests.map(test => this.testNetworkConnection(test))
    );

    const connectivity = {
      timestamp: new Date().toISOString(),
      tests: results.map((result, index) => ({
        ...connectivityTests[index],
        success: result.status === 'fulfilled' && result.value,
        error: result.status === 'rejected' ? result.reason.message : null
      }))
    };

    logger.info('Network connectivity check completed', connectivity);
    return connectivity;
  }

  /** Reachability target for the active non-Gemini provider's endpoint. */
  _providerConnectivityTests() {
    const label = getProviderConfig(this.providerId).label;
    try {
      // Node's URL: speech.service.js may have replaced the global one with a stub.
      const url = new NodeURL(getBaseURL(this.providerId));
      const port = Number(url.port) || (url.protocol === 'http:' ? 80 : 443);
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
      return [{ host, port, name: `${label} API Endpoint` }];
    } catch (_) {
      return [];
    }
  }

  async testNetworkConnection({ host, port, timeoutMs = 5000 }) {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const socket = new net.Socket();
      
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, timeoutMs);

      socket.on('connect', () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(new Error(`Connection failed to ${host}:${port}: ${error.message}`));
      });

      socket.connect(port, host);
    });
  }

  /**
   * The error to surface when every request attempt failed. The message is
   * the same short, actionable text Test connection shows (bad key, rate
   * limited, offline, ...), so the user sees why there is no answer instead
   * of a canned reply that looks like one. The raw error stays on `cause`.
   */
  _userFacingError(error) {
    const friendly = new Error(this._friendlyTestError(error, this.analyzeError(error)));
    friendly.cause = error;
    friendly.isUserFacing = true;
    return friendly;
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized' };
    }

    if (this.providerId !== 'gemini') {
      return this._testProviderConnection();
    }

    try {
      // First check network connectivity
      const networkCheck = await this.checkNetworkConnectivity();
      const hasNetworkIssues = networkCheck.tests.some(test => !test.success);
      
      if (hasNetworkIssues) {
        logger.warn('Network connectivity issues detected', networkCheck);
      }

      const generationConfig = this.getGenerationConfig({ temperature: 0, maxOutputTokens: 64 });
      const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
      const modelsToTry = [this.model, ...fallbackModels];

      let lastError = null;
      let result = null;
      let usedModel = null;

      for (const modelName of modelsToTry) {
        try {
          const startTime = Date.now();
          result = await this.client.models.generateContent({
            model: modelName,
            contents: 'Test connection. Please respond with "OK".',
            config: generationConfig
          });
          usedModel = modelName;
          const latency = Date.now() - startTime;
          const { text } = this.extractTextFromCandidates(result);

          logger.info('Connection test successful', {
            response: text,
            latency,
            model: usedModel,
            networkCheck: hasNetworkIssues ? 'issues_detected' : 'healthy'
          });

          return {
            success: true,
            response: text,
            latency,
            model: usedModel,
            networkConnectivity: networkCheck
          };
        } catch (error) {
          lastError = error;
          logger.warn(`Connection test failed for model ${modelName}`, {
            error: error.message,
            model: modelName
          });

          const isModelUnavailable = error.message.includes('503') ||
            error.message.includes('UNAVAILABLE') ||
            error.message.includes('high demand') ||
            error.message.includes('quota') ||
            error.message.includes('rate limit');

          if (!isModelUnavailable && modelName === this.model) {
            // Primary model failed for a non-availability reason; don't hide it
            break;
          }
        }
      }

      throw lastError || new Error('Connection test failed on all models');
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error('Connection test failed', {
        error: error.message,
        errorAnalysis
      });

      // Map raw SDK errors to user-friendly messages. The wizard only
      // surfaces `error`, so any raw SDK error string would land in the
      // UI verbatim.
      const friendlyError = this._friendlyTestError(error, errorAnalysis);

      return {
        success: false,
        error: friendlyError,
        errorType: errorAnalysis?.type || 'UNKNOWN',
        errorAnalysis,
        networkConnectivity: await this.checkNetworkConnectivity().catch(() => null)
      };
    }
  }

  /**
   * Translate raw SDK / network errors into something a user can act on.
   */
  _friendlyTestError(error, analysis) {
    const type = analysis?.type;
    const raw = (error?.message || '').toLowerCase();
    const copy = this._providerCopy();

    if (type === 'NETWORK_ERROR' || raw.includes('fetch failed') || raw.includes('enotfound')) {
      return copy.unreachable;
    }
    if (type === 'AUTH_ERROR' || raw.includes('api key') || raw.includes('401') || raw.includes('403')) {
      return copy.badKey;
    }
    if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
      return copy.rateLimited;
    }
    if (type === 'TIMEOUT_ERROR') {
      return copy.timedOut;
    }
    if (type === 'MODEL_ERROR' || raw.includes('model') || raw.includes('404')) {
      return copy.modelUnavailable;
    }
    if (raw.includes('503') || raw.includes('unavailable') || raw.includes('high demand')) {
      return copy.highDemand;
    }
    // Fall back to a stripped-down raw message (no SDK prefix noise)
    return (error?.message || 'Connection failed').replace(/^\[(GoogleGenerativeAI|GoogleGenAI) Error\]:\s*/i, '');
  }

  /**
   * User-facing wording for the active provider. The Gemini strings are the
   * original ones, so Gemini messages read exactly as before.
   */
  _providerCopy() {
    const providerConfig = this.providerId && this.providerId !== 'gemini'
      ? getProviderConfig(this.providerId)
      : null;

    if (!providerConfig) {
      return {
        notInitialized: 'LLM service not initialized. Check Gemini API key configuration.',
        unreachable: 'Cannot reach Google servers. Check your internet connection, firewall, or VPN settings.',
        badKey: 'Invalid API key or insufficient permissions. Double-check the key at aistudio.google.com/apikey.',
        rateLimited: 'Rate limit or quota exceeded. Wait a moment or check your Google Cloud billing.',
        timedOut: 'Request timed out. The Google API may be slow or unreachable right now.',
        modelUnavailable: 'The configured Gemini model is unavailable. Try a different model in Settings.',
        highDemand: 'Gemini is experiencing high demand. Please wait a moment and try again.'
      };
    }

    const label = providerConfig.label;
    const isOllama = this.providerId === 'ollama';
    return {
      notInitialized: isOllama
        ? `LLM service not initialized. Check the ${label} settings.`
        : `LLM service not initialized. Check ${label} API key configuration.`,
      unreachable: isOllama
        ? `Cannot reach ${label} at ${getBaseURL(this.providerId)}. Make sure it is running.`
        : `Cannot reach ${label}. Check your internet connection, firewall, or VPN settings.`,
      badKey: `Invalid API key or insufficient permissions. Double-check your ${label} API key in Settings.`,
      rateLimited: `Rate limit or quota exceeded. Wait a moment or check your ${label} plan and billing.`,
      timedOut: `Request timed out. ${label} may be slow or unreachable right now.`,
      modelUnavailable: isOllama
        ? `The configured ${label} model is unavailable. Run "ollama pull ${this.model}" or pick another model in Settings.`
        : `The configured ${label} model is unavailable. Try a different model in Settings.`,
      highDemand: `${label} is experiencing high demand. Please wait a moment and try again.`
    };
  }

  /** Screenshots need a vision-capable provider; fail before any request is made. */
  _assertImagesSupported() {
    if (this.providerId === 'gemini') {
      return;
    }
    const providerConfig = getProviderConfig(this.providerId);
    if (providerConfig && providerConfig.supportsImages === false) {
      throw new Error(`${providerConfig.label} does not support screenshots. Choose Gemini, Claude, OpenAI, OpenRouter or Ollama in Settings.`);
    }
  }

  /**
   * Send a Gemini-shaped request through the active non-Gemini provider.
   * Streams when onDelta is a function. Retries network, 429 and 5xx failures
   * with the same backoff as the Gemini paths; a stream that already showed
   * text is not replayed, because the caller's non-streaming fallback replaces
   * the partial answer instead of appending a second copy. options.onAttemptStart
   * (optional) runs before every attempt. options.signal (optional
   * AbortSignal) stops the request, a retry wait and any further attempt;
   * no onDelta call follows the stop.
   */
  async executeProviderRequest(geminiRequest, onDelta = null, options = {}) {
    const providerConfig = getProviderConfig(this.providerId);
    const label = providerConfig ? providerConfig.label : String(this.providerId);
    const provider = this.provider;
    const model = this.model;

    if (!provider) {
      throw new Error(this._providerCopy().notInitialized);
    }

    const neutral = fromGeminiRequest(geminiRequest);
    if (neutral.messages.some((message) => message.parts.some((part) => part.type === 'image'))) {
      this._assertImagesSupported();
    }
    if (!neutral.messages.length) {
      throw new Error(`Nothing to send to ${label}: the request has no user message`);
    }

    const streaming = typeof onDelta === 'function';
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || this._retryBudget(config.get('llm.gemini.maxRetries')) || 1);
    const signal = options.signal || null;
    let lastError = null;

    const onAttemptStart = typeof options.onAttemptStart === 'function' ? options.onAttemptStart : null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfCancelled(signal);
      let emittedText = false;
      if (onAttemptStart) onAttemptStart();
      try {
        const text = streaming
          ? await raceCancel(provider.stream(neutral, model, (delta) => {
            if (isAborted(signal)) return;
            emittedText = true;
            onDelta(delta);
          }, { signal }), signal)
          : await raceCancel(provider.generate(neutral, model, { signal }), signal);
        throwIfCancelled(signal);

        const trimmed = typeof text === 'string' ? text.trim() : '';
        if (!trimmed) {
          throw new Error(`Empty response from ${label}`);
        }

        logger.debug(`${label} request successful`, {
          provider: this.providerId,
          model,
          attempt,
          streaming,
          responseLength: trimmed.length
        });
        return trimmed;
      } catch (error) {
        this._rethrowIfCancelled(error, signal);
        lastError = error instanceof Error ? error : new Error(String(error));
        const errorInfo = this.analyzeError(lastError);
        const status = Number(lastError.status) || 0;
        const retryable = errorInfo.isNetworkError || errorInfo.type === 'RATE_LIMIT_ERROR' ||
          status === 429 || status >= 500;
        const willRetry = retryable && !emittedText && attempt < maxAttempts;

        logger.warn(`${label} attempt ${attempt} failed`, {
          provider: this.providerId,
          model,
          error: lastError.message,
          errorType: errorInfo.type,
          status: status || undefined,
          streaming,
          willRetry
        });

        if (!willRetry) {
          break;
        }

        const baseDelay = errorInfo.isNetworkError ? 2500 : 1500;
        await this.delay(baseDelay * attempt + Math.random() * 1000, signal);
      }
    }

    throw lastError;
  }

  /** Connection test for non-Gemini providers; same result shape as the Gemini branch. */
  async _testProviderConnection() {
    const startTime = Date.now();
    const request = {
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK' }] }],
      generationConfig: { maxOutputTokens: 64 }
    };

    try {
      let text;
      try {
        // One attempt: a test should report a failure promptly, not back off.
        text = await this.executeProviderRequest(request, null, { maxAttempts: 1 });
      } catch (error) {
        // Reasoning models can spend the 64-token budget before writing any
        // text. The API still accepted the key and model, which is what this
        // test checks.
        if (!error || error.code !== MAX_TOKENS_NO_TEXT) {
          throw error;
        }
        text = '';
      }

      const latency = Date.now() - startTime;
      logger.info('Connection test successful', {
        provider: this.providerId,
        model: this.model,
        response: text,
        latency
      });

      return {
        success: true,
        response: text,
        latency,
        model: this.model,
        provider: this.providerId,
        networkConnectivity: null
      };
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error('Connection test failed', {
        provider: this.providerId,
        model: this.model,
        error: error.message,
        errorAnalysis
      });

      return {
        success: false,
        error: this._friendlyTestError(error, errorAnalysis),
        errorType: errorAnalysis?.type || 'UNKNOWN',
        errorAnalysis,
        networkConnectivity: null
      };
    }
  }

  updateApiKey(newApiKey) {
    process.env.GEMINI_API_KEY = newApiKey;
    this.isInitialized = false;
    this.initializeClient();
    
    logger.info('API key updated and client reinitialized');
  }

  getStats() {
    const providerConfig = getProviderConfig(this.providerId);
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      provider: this.providerId,
      providerLabel: providerConfig ? providerConfig.label : null,
      model: this.model,
      config: config.get('llm.gemini')
    };
  }

  /** Wait `ms`; with `signal`, a stop ends the wait with the cancelled error. */
  delay(ms, signal = null) {
    return cancellableDelay(ms, signal);
  }

  /**
   * Rethrow the cancelled error when `error` is one or `signal` has fired,
   * so a stopped answer skips retries, fallbacks and the error message.
   */
  _rethrowIfCancelled(error, signal) {
    if (isCancelledError(error) || isAborted(signal)) {
      throw isCancelledError(error) ? error : cancelledError();
    }
  }

  async executeAlternativeRequest(geminiRequest, signal = null) {
    if (this.providerId !== 'gemini') {
      return this.executeProviderRequest(geminiRequest, null, { signal });
    }

    const apiKey = config.getApiKey('GEMINI');
    // Same model as the SDK path (honors GEMINI_MODEL); identical to the
    // config default when GEMINI_MODEL is unset.
    const primaryModel = this.model || config.get('llm.gemini.model');
    const fallbackModels = config.get('llm.gemini.fallbackModels') || [];
    const modelsToTry = [primaryModel, ...fallbackModels];

    logger.info('Using alternative HTTPS request method', { modelsToTry });

    let lastError = null;

    for (const modelName of modelsToTry) {
      throwIfCancelled(signal);
      try {
        const result = await this._executeAlternativeRequestForModel(geminiRequest, modelName, apiKey, signal);
        return result;
      } catch (error) {
        this._rethrowIfCancelled(error, signal);
        lastError = error;
        logger.warn(`Alternative HTTPS request failed for model ${modelName}`, {
          error: error.message,
          model: modelName
        });

        const isModelUnavailable = error.message.includes('503') ||
          error.message.includes('UNAVAILABLE') ||
          error.message.includes('high demand');

        if (!isModelUnavailable && modelName === primaryModel) {
          break;
        }
      }
    }

    throw lastError || new Error('Alternative HTTPS request failed for all models');
  }

  async _executeAlternativeRequestForModel(geminiRequest, modelName, apiKey, signal = null) {
    throwIfCancelled(signal);
    const https = require('https');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;

    const postData = JSON.stringify(geminiRequest);

    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });

    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent()
      },
      timeout: config.get('llm.gemini.timeout'),
      agent
    };

    return new Promise((resolve, reject) => {
      const req = https.request(url, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });
        
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }
            
            const response = JSON.parse(data);
            
            logger.debug('Alternative request response structure', {
              hasResponse: !!response,
              hasCandidates: !!response.candidates,
              candidatesLength: response.candidates?.length,
              responseKeys: Object.keys(response || {}),
              firstCandidateKeys: response.candidates?.[0] ? Object.keys(response.candidates[0]) : []
            });

            const { text, finishReason } = this.extractTextFromCandidates(response);

            if (finishReason === 'MAX_TOKENS') {
              logger.warn('Gemini alternative response reached max tokens limit', {
                finishReason
              });
            }
            
            logger.info('Alternative request successful', {
              responseLength: text.length,
              statusCode: res.statusCode,
              finishReason
            });
            
            resolve(text.trim());
          } catch (parseError) {
            logger.error('Failed to parse alternative response', {
              error: parseError.message,
              rawResponseLength: data.length,
              statusCode: res.statusCode
            });
            reject(new Error(`Failed to parse response: ${parseError.message}`));
          }
        });
      });
      
      req.on('error', (error) => {
        reject(new Error(`Alternative request failed: ${error.message}`));
      });
      
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Alternative request timeout'));
      });

      // A stop closes the connection; whatever arrives later is ignored.
      if (signal) {
        const onAbort = () => {
          reject(cancelledError());
          req.destroy();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => signal.removeEventListener('abort', onAbort));
      }
      
      req.write(postData);
      req.end();
    });
  }
}

module.exports = new LLMService();