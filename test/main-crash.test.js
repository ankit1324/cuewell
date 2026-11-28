'use strict';
// main.js crash handling, end to end under the electron mock: which
// process-level errors keep the app alive, which save a crash record, the
// one fatal-error dialog per run, and that the last run's record is taken
// (and deleted) at startup. See test/helpers/crash-harness.js.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { RESULT_MARKER } = require('./helpers/crash-harness');

const HARNESS = path.join(__dirname, 'helpers', 'crash-harness.js');

function runHarness(root, request) {
  const requestPath = path.join(root, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify({ root, ...request }));
  // Every home and temp folder in `root`, so the real userData, keys and logs are out of reach.
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    TMPDIR: root, TEMP: root, TMP: root, NODE_ENV: 'test' };
  for (const name of ['SystemRoot', 'windir', 'ComSpec']) if (process.env[name]) env[name] = process.env[name];
  const child = spawnSync(process.execPath, [HARNESS, requestPath], {
    cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  });
  const report = `exit ${child.status}\n${(child.stdout || '').slice(-2000)}\n${(child.stderr || '').slice(-2000)}`;
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith(RESULT_MARKER));
  assert.ok(line, `harness printed no result: ${report}`);
  const output = JSON.parse(line.slice(RESULT_MARKER.length));
  assert.equal(output.fatal, undefined, output.fatal);
  assert.equal(child.status, 0, report);
  output.byLabel = Object.fromEntries(output.steps.map((s) => [s.label, s]));
  return output;
}

const roots = [];
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuewell-crash-'));
  roots.push(root);
  return root;
}

describe('main.js process-level errors', () => {
  let out;
  before(() => {
    out = runHarness(tempRoot(), { scenario: 'errors' });
  });

  it('keeps running after a missing recorder, without a dialog or record', () => {
    for (const label of ['recorder ENOENT', 'arecord ENOENT']) {
      assert.deepEqual(out.byLabel[label].calls, [], label);
      assert.equal(out.byLabel[label].record, null, label);
    }
    assert.ok(out.logs.some((l) => l.level === 'warn' && /Audio recorder is not installed/.test(l.message)));
  });

  it('logs rejections and never exits for them', () => {
    for (const label of ['library rejection', 'string rejection', 'app rejection']) {
      assert.deepEqual(out.byLabel[label].calls, [], label);
    }
    const rejections = out.logs.filter((l) => /^Unhandled rejection/.test(l.message));
    assert.equal(rejections.length, 3);
    assert.match(rejections[0].meta.stack, /socket hang up/);
  });

  it('saves a record only for a rejection from app code', () => {
    assert.equal(out.byLabel['library rejection'].record, null);
    assert.equal(out.byLabel['string rejection'].record, null);
    const record = out.byLabel['app rejection'].record;
    assert.equal(record.kind, 'error');
    assert.equal(record.message, 'app bug in ~/x', 'home folder scrubbed');
    assert.equal(record.appVersion, '0.0.0-test');
  });

  it('treats any other uncaught exception as fatal: record, one dialog, restart', () => {
    const fatal = out.byLabel['whisper ENOENT'];
    assert.deepEqual(fatal.calls, ['dialog', 'relaunch', 'exit 0']);
    assert.equal(fatal.record.kind, 'fatal', 'a fatal record replaces the earlier one');
    assert.equal(fatal.record.message, 'spawn whisper ENOENT');
    assert.deepEqual(out.dialogs, [{ message: 'Cuewell could not continue', buttons: ['Restart Cuewell', 'Quit'] }]);
    assert.ok(out.logs.some((l) => l.level === 'error' && l.message === 'Uncaught exception' && /spawn whisper ENOENT/.test(l.meta.stack)));
  });

  it('shows no second dialog and keeps the first fatal record', () => {
    const second = out.byLabel['second fatal'];
    assert.deepEqual(second.calls, []);
    assert.equal(second.record.message, 'spawn whisper ENOENT');
    assert.ok(out.logs.some((l) => /Another uncaught exception/.test(l.message)));
  });

  it('writes the record owner-only and leaves no temp files', () => {
    assert.deepEqual(out.userDataFiles.filter((f) => /crash/.test(f)), ['last-crash.json']);
    if (process.platform !== 'win32') assert.equal(out.recordMode, 0o600);
  });
});

describe('main.js window and helper crashes', () => {
  let out;
  before(() => {
    out = runHarness(tempRoot(), { scenario: 'process-gone' });
  });

  it('records nothing for a killed window or a clean helper exit', () => {
    assert.equal(out.byLabel['window killed'].record, null);
    assert.equal(out.byLabel['helper clean exit'].record, null);
  });

  it('records a crashed helper process, then keeps that first record', () => {
    const record = out.byLabel['helper crash'].record;
    assert.equal(record.kind, 'helper');
    assert.equal(record.message, 'The Audio Service helper process stopped (crashed, exit code 5)');
    assert.equal(out.byLabel['window crash'].record.kind, 'helper');
  });

  it('never exits or shows a dialog for them', () => {
    for (const step of out.steps) assert.deepEqual(step.calls, [], step.label);
  });

  it('logs a failing window message handler instead of crashing', () => {
    assert.deepEqual(out.byLabel['bad audio chunk'].calls, []);
    assert.ok(out.logs.some((l) => l.message === 'IPC message handler failed' && l.meta.channel === 'audio-chunk'));
    assert.ok(!out.logs.some((l) => l.message === 'Uncaught exception'));
  });
});

describe('main.js startup with the last run\'s crash record', () => {
  const seedRecord = JSON.stringify({ time: '2025-01-01T00:00:00.000Z', appVersion: '1.0.0', platform: 'darwin',
    arch: 'arm64', kind: 'fatal', name: 'TypeError', message: 'boom', stack: '' });

  it('takes a valid record and deletes it', () => {
    const out = runHarness(tempRoot(), { seedRecord });
    assert.equal(out.recordAfterLoad, false);
    assert.ok(!out.userDataFiles.includes('last-crash.json'));
  });

  it('keeps a record that was never offered when the app quits', () => {
    const out = runHarness(tempRoot(), { seedRecord, scenario: 'quit' });
    assert.equal(out.recordAfterLoad, false);
    const record = out.byLabel['will-quit'].record;
    assert.equal(record.message, 'boom');
    assert.equal(record.time, '2025-01-01T00:00:00.000Z');
  });

  it('deletes a malformed record', () => {
    const out = runHarness(tempRoot(), { seedRecord: '{"message": ' });
    assert.equal(out.recordAfterLoad, false);
    assert.ok(!out.userDataFiles.includes('last-crash.json'));
  });
});
