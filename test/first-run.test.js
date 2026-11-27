'use strict';
// src/core/first-run.js: whether to show onboarding, the first-run markers
// (current and legacy names) and .env bootstrap. Everything runs in a temp
// folder with explicit paths, so the real userData and .env are never read.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir, silentLogger, clearAppEnv } = require('./helpers/env');

clearAppEnv();
const FirstRunManager = require('../src/core/first-run');

const MARKER = '.cuewell-firstrun-completed';
const LEGACY_MARKERS = ['.superinterview-firstrun-completed', '.opencluely-firstrun-completed'];
const GEMINI_KEY = 'AIzaSyTESTKEY0000000000000000000000000';
const isPosix = process.platform !== 'win32';

function setup(t, { env, markers = [], options = {} } = {}) {
  const dir = tempDir(t);
  const envPath = path.join(dir, '.env');
  if (env !== undefined) fs.writeFileSync(envPath, env);
  for (const name of markers) fs.writeFileSync(path.join(dir, name), 'done');
  const manager = new FirstRunManager({
    cwd: dir,
    envPath,
    sentinelPath: path.join(dir, MARKER),
    allowLaunchFolder: false,
    logger: silentLogger,
    ...options,
  });
  return { dir, envPath, manager };
}

describe('needsOnboarding', () => {
  it('is true on a fresh install (no marker, no .env)', (t) => {
    assert.equal(setup(t).manager.needsOnboarding(), true);
  });

  it('is true without a marker even when a key is set', (t) => {
    assert.equal(setup(t, { env: `GEMINI_API_KEY=${GEMINI_KEY}\n` }).manager.needsOnboarding(), true);
  });

  it('is true with a marker but no .env', (t) => {
    assert.equal(setup(t, { markers: [MARKER] }).manager.needsOnboarding(), true);
  });

  it('is true when the selected provider has no key or a template key', (t) => {
    for (const env of [
      '',
      'GEMINI_API_KEY=\n',
      'GEMINI_API_KEY=your_gemini_api_key_here\n',
      'GEMINI_API_KEY="your-api-key-here"\n',
      `LLM_PROVIDER=anthropic\nGEMINI_API_KEY=${GEMINI_KEY}\n`,
      'LLM_PROVIDER=openai\nOPENAI_API_KEY=your_openai_api_key_here\n',
      '# GEMINI_API_KEY=commented-out-key\n',
    ]) {
      assert.equal(setup(t, { env, markers: [MARKER] }).manager.needsOnboarding(), true, JSON.stringify(env));
    }
  });

  it('is false with a marker and a key for the selected provider', (t) => {
    for (const env of [
      `GEMINI_API_KEY=${GEMINI_KEY}\n`,
      `GEMINI_API_KEY="${GEMINI_KEY}" # saved by Settings\r\n`,
      `GEMINI_API_KEY='${GEMINI_KEY}'\n`,
      `GEMINI_API_KEY=${GEMINI_KEY} # comment\n`,
      'LLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-test-0000000000\n',
      'LLM_PROVIDER=GROQ\nGROQ_API_KEY=gsk_test000000000000\n',
      // Ollama runs locally and needs no key.
      'LLM_PROVIDER=ollama\n',
      // An unknown provider falls back to Gemini.
      `LLM_PROVIDER=nonsense\nGEMINI_API_KEY=${GEMINI_KEY}\n`,
    ]) {
      assert.equal(setup(t, { env, markers: [MARKER] }).manager.needsOnboarding(), false, JSON.stringify(env));
    }
  });

  it('reads the .env file, not process.env', (t) => {
    const { manager } = setup(t, { env: '', markers: [MARKER] });
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    t.after(() => delete process.env.GEMINI_API_KEY);
    assert.equal(manager.needsOnboarding(), true);
  });
});

describe('first-run markers', () => {
  for (const legacy of LEGACY_MARKERS) {
    it(`counts the legacy marker ${legacy} as completed`, (t) => {
      const { manager } = setup(t, { env: `GEMINI_API_KEY=${GEMINI_KEY}\n`, markers: [legacy] });
      assert.equal(manager.needsOnboarding(), false);
      assert.equal(manager.getStatus().sentinelExists, true);
    });
  }

  it('counts a legacy marker passed in legacySentinelPaths (an old userData folder)', (t) => {
    const oldDir = tempDir(t);
    const oldMarker = path.join(oldDir, LEGACY_MARKERS[1]);
    fs.writeFileSync(oldMarker, 'done');
    const { manager } = setup(t, {
      env: `GEMINI_API_KEY=${GEMINI_KEY}\n`,
      options: { legacySentinelPaths: [oldMarker] },
    });
    assert.equal(manager.needsOnboarding(), false);
  });

  it('ignores a legacy marker that does not exist', (t) => {
    const { manager } = setup(t, {
      env: `GEMINI_API_KEY=${GEMINI_KEY}\n`,
      options: { legacySentinelPaths: [path.join(tempDir(t), LEGACY_MARKERS[0])] },
    });
    assert.equal(manager.needsOnboarding(), true);
  });

  it('markCompleted writes the current marker', (t) => {
    const { dir, manager } = setup(t, { env: `GEMINI_API_KEY=${GEMINI_KEY}\n` });
    assert.equal(manager.needsOnboarding(), true);
    manager.markCompleted();
    assert.ok(fs.existsSync(path.join(dir, MARKER)));
    assert.ok(!Number.isNaN(Date.parse(fs.readFileSync(path.join(dir, MARKER), 'utf8'))));
    assert.equal(manager.needsOnboarding(), false);
  });

  it('markCompleted logs a warning instead of throwing when it cannot write', (t) => {
    const warnings = [];
    const { manager } = setup(t, {
      options: {
        sentinelPath: path.join(tempDir(t), 'missing', MARKER),
        logger: { ...silentLogger, warn: (...args) => warnings.push(args) },
      },
    });
    assert.doesNotThrow(() => manager.markCompleted());
    assert.equal(warnings.length, 1);
  });
});

describe('getStatus', () => {
  it('reports the provider and speech setup', (t) => {
    const { manager } = setup(t, {
      env: 'LLM_PROVIDER=ollama\nAZURE_SPEECH_KEY=abc\nAZURE_SPEECH_REGION=eastus\nWHISPER_COMMAND=whisper\n',
      markers: [MARKER],
    });
    assert.deepEqual(manager.getStatus(), {
      envExists: true,
      sentinelExists: true,
      geminiConfigured: false,
      llmProvider: 'ollama',
      llmConfigured: true,
      azureConfigured: true,
      whisperConfigured: true,
      needsOnboarding: false,
    });
  });

  it('never includes key values', (t) => {
    const { manager } = setup(t, { env: `GEMINI_API_KEY=${GEMINI_KEY}\nAZURE_SPEECH_KEY=azuresecret123\n` });
    const json = JSON.stringify(manager.getStatus());
    assert.ok(!json.includes(GEMINI_KEY));
    assert.ok(!json.includes('azuresecret123'));
  });
});

describe('ensureEnv', () => {
  it('creates .env from env.example when it is missing', (t) => {
    const { envPath, manager } = setup(t);
    const result = manager.ensureEnv();
    assert.deepEqual(result, { created: true, path: envPath });
    const template = fs.readFileSync(path.join(__dirname, '..', 'env.example'), 'utf8');
    assert.equal(fs.readFileSync(envPath, 'utf8'), template);
  });

  it('creates .env with mode 0600', { skip: !isPosix && 'POSIX file modes only' }, (t) => {
    const { envPath, manager } = setup(t);
    manager.ensureEnv();
    assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  });

  it('never overwrites an existing .env', (t) => {
    const { envPath, manager } = setup(t, { env: 'GEMINI_API_KEY=keep-me\n' });
    assert.deepEqual(manager.ensureEnv(), { created: false, path: envPath });
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'GEMINI_API_KEY=keep-me\n');
  });

  it('creates missing parent folders', (t) => {
    const envPath = path.join(tempDir(t), 'a', 'b', '.env');
    const { manager } = setup(t, { options: { envPath } });
    assert.equal(manager.ensureEnv().created, true);
    assert.ok(fs.existsSync(envPath));
  });

  it('only reads env.example from the launch folder when running from source', (t) => {
    const launchTemplate = 'GEMINI_API_KEY=from-launch-folder\n';
    const packaged = setup(t);
    fs.writeFileSync(path.join(packaged.dir, 'env.example'), launchTemplate);
    packaged.manager.ensureEnv();
    assert.notEqual(fs.readFileSync(packaged.envPath, 'utf8'), launchTemplate);

    const source = setup(t, { options: { allowLaunchFolder: true } });
    fs.writeFileSync(path.join(source.dir, 'env.example'), launchTemplate);
    source.manager.ensureEnv();
    assert.equal(fs.readFileSync(source.envPath, 'utf8'), launchTemplate);
  });

  it('a new .env still needs onboarding (template key only)', (t) => {
    const { manager } = setup(t, { markers: [MARKER] });
    manager.ensureEnv();
    assert.equal(manager.needsOnboarding(), true);
  });
});
