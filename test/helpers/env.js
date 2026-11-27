'use strict';
// Test isolation: a silent logger in place of src/core/logger.js (which
// writes to ~/.Cuewell/logs), temp folders, and a process.env without any
// provider settings from the developer's shell.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('./source');

const noop = () => {};
const silentLogger = { debug: noop, info: noop, warn: noop, error: noop, log: noop };

/** Replace src/core/logger.js in the require cache. Call before requiring app modules. */
function stubLogger() {
  const file = require.resolve(repoPath('src', 'core', 'logger.js'));
  const stub = {
    createServiceLogger: () => silentLogger,
    debug: noop, info: noop, warn: noop, error: noop,
    logPerformance: () => 0,
  };
  require.cache[file] = { id: file, filename: file, loaded: true, exports: stub, children: [], paths: [] };
  return stub;
}

// Settings the app reads from process.env. Cleared so a key or provider in
// the shell that runs the tests cannot change the results.
const APP_ENV_PATTERN = /^(LLM_|GEMINI_|ANTHROPIC_|OPENAI_|OPENROUTER_|GROQ_|DEEPSEEK_|OLLAMA_|AZURE_|SPEECH_|WHISPER_|INTERVIEW_MODE$|ANSWER_LENGTH$)/;

function clearAppEnv(env = process.env) {
  for (const key of Object.keys(env)) {
    if (APP_ENV_PATTERN.test(key)) delete env[key];
  }
  return env;
}

/** A new temp folder, removed when the test (or suite) `t` ends. */
function tempDir(t, prefix = 'cuewell-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  if (t && typeof t.after === 'function') t.after(cleanup);
  else process.on('exit', cleanup);
  return dir;
}

module.exports = { silentLogger, stubLogger, clearAppEnv, tempDir, APP_ENV_PATTERN };
