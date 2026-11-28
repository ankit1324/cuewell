'use strict';
// With a backup provider ready, the selected provider gives up sooner so the
// backup answers in seconds; a rejected key is never retried. Gemini is an
// in-memory fake; nothing leaves this process.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { stubLogger, clearAppEnv, silentLogger } = require('./helpers/env');

stubLogger();
silentLogger.logPerformance = () => 0;
clearAppEnv();
const config = require('../src/core/config');
const llmService = require('../src/services/llm.service');

const GEMINI_REQUEST = { contents: [{ role: 'user', parts: [{ text: 'Hi' }] }], generationConfig: { maxOutputTokens: 64 } };

function useGemini(generateContent) {
  llmService.providerId = 'gemini';
  llmService.provider = null;
  llmService.client = { models: { generateContent } };
  llmService.model = 'gemini-test';
  llmService.isInitialized = true;
  llmService.delay = async () => {}; // no real backoff waits
}

describe('retry budget', () => {
  beforeEach(() => { llmService._backupAvailable = false; });

  it('uses every configured attempt with no backup, and at most two with one', () => {
    assert.equal(llmService._retryBudget(3), 3);
    llmService._backupAvailable = true;
    assert.equal(llmService._retryBudget(3), 2);
    assert.equal(llmService._retryBudget(1), 1);
    assert.equal(llmService._retryBudget(undefined), 1);
  });
});

describe('Gemini stops at once on a rejected key', () => {
  it('recognizes Gemini\'s "API key not valid" message as a key error', () => {
    const info = llmService.analyzeError(new Error('[400 Bad Request] API key not valid. Please pass a valid API key. API_KEY_INVALID'));
    assert.equal(info.type, 'AUTH_ERROR');
  });

  it('makes one request, on one model, then throws', async () => {
    llmService._backupAvailable = false;
    let calls = 0;
    useGemini(async () => { calls += 1; throw new Error('API key not valid. Please pass a valid API key.'); });
    const configured = config.get('llm.gemini.maxRetries');
    const models = 1 + (config.get('llm.gemini.fallbackModels') || []).length;
    assert.ok(configured * models > 1, 'the old behavior made several requests');
    await assert.rejects(llmService.executeRequest(GEMINI_REQUEST));
    assert.equal(calls, 1);
  });

  it('a server error still retries, but only once more while a backup is ready', async () => {
    llmService._backupAvailable = true;
    let calls = 0;
    useGemini(async () => { calls += 1; throw Object.assign(new Error('500 internal error'), { status: 500 }); });
    const models = 1 + (config.get('llm.gemini.fallbackModels') || []).length;
    await assert.rejects(llmService.executeRequest(GEMINI_REQUEST));
    assert.ok(calls <= 2 * models, `${calls} requests for ${models} models`);
    llmService._backupAvailable = false;
  });
});
