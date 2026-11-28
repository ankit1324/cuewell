'use strict';
// src/core/crash-report.js: which uncaught errors keep the app alive, the
// scrubbed local crash record (userData/last-crash.json), the one-time offer
// to report it on the next launch, and the fatal-error dialog guard. Plus the
// crash section that buildProblemReportUrl adds to the issue body.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Test fixtures shaped like credentials are built at runtime, so secret
// scanners do not report them as leaked keys.
const b64url = (text) => Buffer.from(text).toString('base64url');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers/env');

const {
  RECORDER_PROGRAMS, CRASH_RECORD_FILE, CRASH_RECORD_FIELDS,
  isRecoverableRecorderError, scrubText, errorFields, isAppCodeError,
  buildCrashRecord, createCrashRecorder, takeCrashRecord, processCrashFields,
  crashOfferText, crashOfferPlan, createFatalErrorHandler,
} = require('../src/core/crash-report');
const { buildProblemReportUrl, MAX_REPORT_URL_LENGTH } = require('../src/core/error-reporter');

const HOME = '/Users/jdoe';
const USER = 'jdoe';
const CONTEXT = { appVersion: '1.2.3', platform: 'darwin', arch: 'arm64', homeDir: HOME, username: USER };

/** The error Node gives a child process 'error' event when the program is missing. */
function spawnEnoent(program, args = ['-q']) {
  const error = new Error(`spawn ${program} ENOENT`);
  Object.assign(error, { errno: -2, code: 'ENOENT', syscall: `spawn ${program}`, path: program, spawnargs: args });
  return error;
}

describe('isRecoverableRecorderError', () => {
  it('matches the recorder programs node-record-lpcm16 spawns', () => {
    assert.deepEqual([...RECORDER_PROGRAMS].sort(), ['arecord', 'rec', 'sox']);
    for (const program of RECORDER_PROGRAMS) {
      assert.equal(isRecoverableRecorderError(spawnEnoent(program)), true, program);
    }
  });

  it('matches a recorder spawned by full path or with .exe', () => {
    assert.equal(isRecoverableRecorderError(spawnEnoent('/usr/local/bin/sox')), true);
    assert.equal(isRecoverableRecorderError(spawnEnoent('C:\\tools\\sox.exe')), true);
  });

  it('does not match ENOENT from another program', () => {
    for (const program of ['whisper', 'whisper-server', 'python3', 'ffmpeg', 'soxi', 'recorder']) {
      assert.equal(isRecoverableRecorderError(spawnEnoent(program)), false, program);
    }
  });

  it('does not match a missing file that is not a spawn', () => {
    const error = new Error("ENOENT: no such file or directory, open 'sox'");
    Object.assign(error, { code: 'ENOENT', syscall: 'open', path: 'sox' });
    assert.equal(isRecoverableRecorderError(error), false);
  });

  it('does not match a syscall that names another program than path', () => {
    const error = spawnEnoent('sox');
    error.syscall = 'spawn whisper';
    assert.equal(isRecoverableRecorderError(error), false);
  });

  it('does not match other errors from the recorder', () => {
    const eacces = spawnEnoent('sox');
    eacces.code = 'EACCES';
    assert.equal(isRecoverableRecorderError(eacces), false);
    assert.equal(isRecoverableRecorderError(new TypeError("Cannot read properties of undefined (reading 'x')")), false);
    assert.equal(isRecoverableRecorderError(null), false);
    assert.equal(isRecoverableRecorderError('spawn sox ENOENT'), false);
    assert.equal(isRecoverableRecorderError({ code: 'ENOENT', syscall: 'spawn sox', path: 'sox' }), true,
      'the matcher reads the fields, as Node sets them, not the prototype');
  });
});

describe('scrubText', () => {
  const scrub = (value) => scrubText(value, { homeDir: HOME, username: USER });

  it('replaces the home folder with ~', () => {
    assert.equal(scrub(`at foo (${HOME}/Developer/cuewell/main.js:10:5)`), 'at foo (~/Developer/cuewell/main.js:10:5)');
  });

  it('replaces a Windows home folder in either slash style, any case', () => {
    const win = { homeDir: 'C:\\Users\\JDoe', username: 'JDoe' };
    assert.equal(scrubText('at x (C:\\Users\\JDoe\\AppData\\main.js:1:1)', win), 'at x (~\\AppData\\main.js:1:1)');
    assert.equal(scrubText('file:///c:/users/jdoe/app/main.js', win), 'file:///~/app/main.js');
  });

  it('replaces the user name elsewhere', () => {
    assert.equal(scrub('cannot open /private/var/jdoe-cache for jdoe'), 'cannot open /private/var/<user>-cache for <user>');
    assert.equal(scrub('jdoes and xjdoe stay'), 'jdoes and xjdoe stay');
  });

  it('drops keys and tokens', () => {
    const secrets = [
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx',
      'sk-or-v1-0123456789abcdef0123',
      'sk-proj-ABCDEFGHIJKLMNOP1234',
      'AIzaSyTESTKEY0000000000000000000000000',
      'gsk_FAKEnewGroqKey00007890',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      [b64url('{"alg":"HS256"}'), b64url('{"sub":"test"}'), 'c2lnbmF0dXJlLWZvci10ZXN0cy1vbmx5'].join('.'),
      '0123456789abcdef0123456789abcdef',
      'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWpr',
    ];
    for (const secret of secrets) {
      const out = scrub(`request failed with ${secret} today`);
      assert.ok(!out.includes(secret), `${secret} survived: ${out}`);
      assert.match(out, /^request failed with .*today$/);
    }
  });

  it('drops values after key, token, secret and password names', () => {
    const out = scrub('url ?key=abc123&x=1 api_key: "hunter2" Authorization: Bearer abc.def token=t0k password=pw');
    for (const value of ['abc123', 'hunter2', 'abc.def', 't0k', '=pw']) assert.ok(!out.includes(value), `${value}: ${out}`);
    assert.match(out, /x=1/);
  });

  it('drops Basic and other scheme credentials', () => {
    const credential = Buffer.from('tester:not-a-password').toString('base64');
    for (const header of [`Authorization: Basic ${credential}`, `proxy uses Basic ${credential}`,
      `Digest ${credential}`, `Token ${credential}`]) {
      assert.ok(!scrub(header).includes(credential.slice(0, 16)), scrub(header));
    }
  });

  it('replaces any user folder, including Windows short names', () => {
    assert.equal(scrub('open C:\\Users\\JOHNAT~1\\AppData\\Local\\Temp\\x.wav'), 'open C:\\Users\\<user>\\AppData\\Local\\Temp\\x.wav');
    assert.equal(scrub('at /home/jo/app/main.js and /Users/other/x'), 'at /home/<user>/app/main.js and /Users/<user>/x');
  });

  it('replaces the user name next to an underscore or digit', () => {
    assert.equal(scrub('/tmp/jdoe_cache and jdoe2'), '/tmp/<user>_cache and <user>2');
  });

  it('stays fast on huge input', () => {
    for (const input of ['a-'.repeat(100000), 'data:'.repeat(50000), 'eyJ'.repeat(70000), `key${'_'.repeat(200000)}`]) {
      const start = process.hrtime.bigint();
      const out = scrubText(input, { homeDir: HOME, username: USER, maxLength: 9000 });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 500, `${input.slice(0, 10)}: ${ms} ms`);
      assert.ok(out.length <= 9000 + 100);
    }
  });

  it('cuts long input at a space, so no secret is split', () => {
    const out = scrubText(`${'word '.repeat(3)}sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx tail`, { maxLength: 30 });
    assert.equal(out, 'word word word ');
  });

  it('drops image data', () => {
    const out = scrub('bad image data:image/png;base64,iVBORw0KGgo/AAAA+BBBB/CCCC== end');
    assert.equal(out, 'bad image data:<redacted> end');
  });

  it('keeps ordinary stack text', () => {
    const stack = 'TypeError: x is not a function\n    at Object.<anonymous> (~/app.asar/src/core/winston-daily-rotate-file.js:12:3)';
    assert.equal(scrub(stack), stack);
  });

  it('returns a string for anything', () => {
    assert.equal(scrub(undefined), '');
    assert.equal(scrub(42), '42');
  });
});

describe('errorFields', () => {
  it('reads an Error', () => {
    const error = new RangeError('bad range');
    const fields = errorFields(error);
    assert.equal(fields.name, 'RangeError');
    assert.equal(fields.message, 'bad range');
    assert.match(fields.stack, /^RangeError: bad range\n\s+at /);
  });

  it('never throws, even for values that cannot become text', () => {
    const fields = errorFields({ message: Object.create(null) });
    assert.equal(fields.name, 'Error');
    assert.equal(typeof fields.message, 'string');
    const nasty = { get message() { throw new Error('getter'); } };
    assert.equal(typeof errorFields(nasty).message, 'string');
    assert.equal(typeof errorFields(Object.create(null)).message, 'string');
  });

  it('reads anything that was thrown', () => {
    assert.deepEqual(errorFields('boom'), { name: 'Error', message: 'boom', stack: '' });
    assert.deepEqual(errorFields(undefined), { name: 'Error', message: 'undefined', stack: '' });
    assert.deepEqual(errorFields({ message: 'm', name: 5 }), { name: 'Error', message: 'm', stack: '' });
  });
});

describe('isAppCodeError', () => {
  const root = '/Applications/Cuewell.app/Contents/Resources/app.asar';
  const withStack = (stack) => Object.assign(new Error('x'), { stack });

  it('is true when a frame is in the app code', () => {
    assert.equal(isAppCodeError(withStack(`Error: x\n    at run (${root}/main.js:1:1)`), root), true);
    assert.equal(isAppCodeError(withStack(`Error: x\n    at ${root}/src/core/tray.js:1:1`), root), true);
  });

  it('is false for library-only, Node-only or non-Error reasons', () => {
    assert.equal(isAppCodeError(withStack(`Error: x\n    at f (${root}/node_modules/ws/index.js:1:1)`), root), false);
    assert.equal(isAppCodeError(withStack('Error: x\n    at process.processTicksAndRejections (node:internal/x:1:1)'), root), false);
    assert.equal(isAppCodeError(withStack(`Error: x\n    at f (${root}-other/main.js:1:1)`), root), false);
    assert.equal(isAppCodeError(`at f (${root}/main.js:1:1)`, root), false);
    assert.equal(isAppCodeError(undefined, root), false);
  });
});

describe('buildCrashRecord', () => {
  it('holds only the documented fields', () => {
    const record = buildCrashRecord({ kind: 'fatal', ...errorFields(new Error('boom')) },
      { ...CONTEXT, now: new Date('2025-01-02T03:04:05Z') });
    assert.deepEqual(Object.keys(record).sort(), [...CRASH_RECORD_FIELDS].sort());
    assert.deepEqual(Object.keys(record).sort(), ['appVersion', 'arch', 'kind', 'message', 'name', 'platform', 'stack', 'time']);
    assert.equal(record.time, '2025-01-02T03:04:05.000Z');
    assert.equal(record.appVersion, '1.2.3');
    assert.equal(record.platform, 'darwin');
    assert.equal(record.arch, 'arm64');
    assert.equal(record.kind, 'fatal');
    assert.equal(record.message, 'boom');
  });

  it('ignores extra fields on the error', () => {
    const fields = { kind: 'fatal', name: 'Error', message: 'm', stack: '', transcript: 'my answer', apiKey: 'k' };
    const record = buildCrashRecord(fields, CONTEXT);
    assert.ok(!JSON.stringify(record).includes('my answer'));
    assert.deepEqual(Object.keys(record).sort(), [...CRASH_RECORD_FIELDS].sort());
  });

  it('scrubs the home folder, user name and keys from message and stack', () => {
    const error = new Error(`open ${HOME}/x failed for key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx`);
    error.stack = `Error: ${error.message}\n    at f (${HOME}/Developer/cuewell/main.js:3:9)`;
    const record = buildCrashRecord({ kind: 'fatal', ...errorFields(error) }, CONTEXT);
    const json = JSON.stringify(record);
    assert.ok(!json.includes(HOME));
    assert.ok(!json.includes(USER));
    assert.ok(!json.includes('sk-ant'));
    assert.match(record.stack, /~\/Developer\/cuewell\/main\.js:3:9/);
  });

  it('never cuts an emoji in half', () => {
    const record = buildCrashRecord({ kind: 'fatal', name: 'Error', message: `a${'\u{1F600}'.repeat(1200)}`,
      stack: `x${'\u{1F600}'.repeat(6000)}` }, CONTEXT);
    assert.doesNotThrow(() => encodeURIComponent(record.message));
    assert.doesNotThrow(() => encodeURIComponent(record.stack));
  });

  it('caps the length of each field', () => {
    const record = buildCrashRecord({ kind: 'fatal', name: 'N'.repeat(500), message: 'm '.repeat(5000),
      stack: 'at f (x.js:1:1)\n'.repeat(5000) }, CONTEXT);
    assert.ok(record.name.length <= 100);
    assert.ok(record.message.length <= 1000);
    assert.ok(record.stack.length <= 8000);
  });

  it('only accepts known kinds', () => {
    assert.equal(buildCrashRecord({ kind: 'weird', message: 'm' }, CONTEXT).kind, 'error');
  });
});

describe('createCrashRecorder', () => {
  it('writes last-crash.json, readable by the owner only', (t) => {
    const filePath = path.join(tempDir(t), 'nested', CRASH_RECORD_FILE);
    const recorder = createCrashRecorder({ filePath, context: CONTEXT });
    assert.equal(recorder.save('fatal', errorFields(new Error('boom'))), true);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(record.message, 'boom');
    assert.equal(record.kind, 'fatal');
    if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(filePath)), [CRASH_RECORD_FILE], 'no temp file left');
  });

  it('keeps the first record of a run, unless a fatal one follows', (t) => {
    const filePath = path.join(tempDir(t), CRASH_RECORD_FILE);
    const recorder = createCrashRecorder({ filePath, context: CONTEXT });
    assert.equal(recorder.save('renderer', { name: 'RendererCrash', message: 'first' }), true);
    assert.equal(recorder.save('error', { message: 'second' }), false);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).message, 'first');
    assert.equal(recorder.save('fatal', { message: 'fatal one' }), true);
    assert.equal(recorder.save('fatal', { message: 'fatal two' }), false);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).message, 'fatal one');
  });

  it('puts back an unoffered record from last time, unless this run saved one', (t) => {
    const filePath = path.join(tempDir(t), CRASH_RECORD_FILE);
    createCrashRecorder({ filePath, context: CONTEXT }).save('fatal', { message: 'last time' });
    const recorder = createCrashRecorder({ filePath, context: CONTEXT });
    const record = recorder.takePrevious();
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(recorder.restore(record), true);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).message, 'last time');
    assert.equal(takeCrashRecord(filePath, CONTEXT).time, record.time, 'the original time is kept');

    const busy = createCrashRecorder({ filePath, context: CONTEXT });
    busy.save('renderer', { message: 'this run' });
    assert.equal(busy.restore(record), false);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).message, 'this run');
    assert.equal(busy.restore(null), false);
  });

  it('never throws when the folder cannot be written', (t) => {
    const dir = tempDir(t);
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, '');
    const recorder = createCrashRecorder({ filePath: path.join(blocker, CRASH_RECORD_FILE), context: CONTEXT });
    assert.equal(recorder.save('fatal', { message: 'x' }), false);
  });
});

describe('next-launch offer', () => {
  function writeRecord(dir, value) {
    const filePath = path.join(dir, CRASH_RECORD_FILE);
    fs.writeFileSync(filePath, typeof value === 'string' ? value : JSON.stringify(value));
    return filePath;
  }

  it('returns the last record once and deletes it', (t) => {
    const dir = tempDir(t);
    const previous = createCrashRecorder({ filePath: path.join(dir, CRASH_RECORD_FILE), context: CONTEXT });
    previous.save('fatal', errorFields(new Error('last time')));

    const recorder = createCrashRecorder({ filePath: path.join(dir, CRASH_RECORD_FILE), context: CONTEXT });
    const record = recorder.takePrevious();
    assert.equal(record.message, 'last time');
    assert.equal(record.kind, 'fatal');
    assert.equal(fs.existsSync(path.join(dir, CRASH_RECORD_FILE)), false);
    assert.equal(recorder.takePrevious(), null, 'offered once');
  });

  it('ignores and deletes a malformed record', (t) => {
    const dir = tempDir(t);
    for (const bad of ['{not json', '[]', '"text"', JSON.stringify({ time: 1 }), JSON.stringify({ message: '' }), '']) {
      const filePath = writeRecord(dir, bad);
      assert.equal(takeCrashRecord(filePath, CONTEXT), null, bad);
      assert.equal(fs.existsSync(filePath), false, `${bad} was not deleted`);
    }
  });

  it('ignores and deletes an oversized record', (t) => {
    const filePath = writeRecord(tempDir(t), { message: 'x'.repeat(200 * 1024) });
    assert.equal(takeCrashRecord(filePath, CONTEXT), null);
    assert.equal(fs.existsSync(filePath), false);
  });

  it('re-scrubs and drops unknown fields from a hand-edited record', (t) => {
    const filePath = writeRecord(tempDir(t), {
      time: '2025-01-01T00:00:00.000Z', appVersion: '1.0.0', platform: 'linux', arch: 'x64', kind: 'fatal',
      name: 'Error', message: `boom in ${HOME}`, stack: '', transcript: 'secret answer',
    });
    const record = takeCrashRecord(filePath, CONTEXT);
    assert.equal(record.message, 'boom in ~');
    assert.equal(record.appVersion, '1.0.0');
    assert.equal(record.platform, 'linux');
    assert.deepEqual(Object.keys(record).sort(), [...CRASH_RECORD_FIELDS].sort());
  });

  it('returns null when there is no record', (t) => {
    assert.equal(takeCrashRecord(path.join(tempDir(t), CRASH_RECORD_FILE), CONTEXT), null);
  });

  it('does not offer a record written by this run as last time', (t) => {
    const filePath = path.join(tempDir(t), CRASH_RECORD_FILE);
    const recorder = createCrashRecorder({ filePath, context: CONTEXT });
    recorder.save('error', { message: 'this run' });
    assert.equal(recorder.takePrevious(), null);
    assert.equal(fs.existsSync(filePath), true);
  });

  it('words the offer by kind', () => {
    assert.equal(crashOfferText({ kind: 'fatal' }).title, 'Cuewell quit unexpectedly last time');
    assert.match(crashOfferText({ kind: 'fatal' }).body, /Report a problem\?/);
    assert.match(crashOfferText({ kind: 'fatal' }).notificationBody, /^Click to report a problem\./);
    assert.equal(crashOfferText({ kind: 'renderer' }).title, 'Part of Cuewell stopped working last time');
    assert.equal(crashOfferText({ kind: 'error' }).title, 'Cuewell ran into an error last time');
  });

  it('plans the least intrusive offer that can be shown', () => {
    const record = { kind: 'fatal' };
    assert.equal(crashOfferPlan(null, { reportConfigured: true }), 'none');
    assert.equal(crashOfferPlan(record, { reportConfigured: false, notificationsSupported: true }), 'none');
    assert.equal(crashOfferPlan(record, { reportConfigured: true, notificationsSupported: true }), 'notification');
    assert.equal(crashOfferPlan(record, { reportConfigured: true, notificationsSupported: false }), 'dialog');
  });
});

describe('processCrashFields', () => {
  it('describes a crashed window without page data', () => {
    const fields = processCrashFields({ source: 'window', type: 'chat', reason: 'crashed', exitCode: 11 });
    assert.deepEqual(fields, { name: 'WindowCrash', message: 'The chat window stopped (crashed, exit code 11)', stack: '' });
  });

  it('describes a crashed helper process', () => {
    const fields = processCrashFields({ source: 'helper', type: 'GPU', name: 'GPU Process', reason: 'oom', exitCode: 3 });
    assert.equal(fields.name, 'HelperProcessCrash');
    assert.equal(fields.message, 'The GPU Process helper process stopped (oom, exit code 3)');
  });

  it('ignores clean exits and kills', () => {
    for (const reason of ['clean-exit', 'killed', 'memory-eviction', undefined]) {
      assert.equal(processCrashFields({ source: 'window', type: 'main', reason, exitCode: 0 }), null, String(reason));
    }
  });

  it('keeps odd names out of the message', () => {
    const fields = processCrashFields({ source: 'helper', type: 'Utility', name: 'x"<script>/../..', reason: 'crashed' });
    assert.doesNotMatch(fields.message, /[<>"/]/);
  });
});

describe('createFatalErrorHandler', () => {
  function setup({ ready = true, quitting = false, response = 0, dialogFails = false, beforeDialogFails = false } = {}) {
    const calls = [];
    const saved = [];
    const logs = [];
    let resolveDialog;
    const dialogShown = new Promise((resolve) => { resolveDialog = resolve; });
    const app = {
      isReady: () => ready,
      relaunch: (options) => calls.push(options ? `relaunch ${options.args.join(' ')}` : 'relaunch'),
      exit: (code) => calls.push(`exit ${code}`),
    };
    const dialog = {
      showMessageBox: async (options) => {
        calls.push('dialog');
        resolveDialog(options);
        if (dialogFails) throw new Error('no dialog');
        return { response };
      },
      showErrorBox: (title) => {
        calls.push(`errorBox ${title}`);
        if (dialogFails) throw new Error('no dialog');
      },
    };
    const logger = { error: (message, meta) => logs.push({ message, meta }), warn: (message, meta) => logs.push({ message, meta }) };
    const handle = createFatalErrorHandler({
      app, dialog, logger,
      saveCrash: (kind, fields) => saved.push({ kind, ...fields }),
      beforeDialog: () => {
        calls.push('hide windows');
        if (beforeDialogFails) throw new Error('windows are gone');
      },
      isQuitting: () => quitting,
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    return { handle, calls, saved, logs, dialogShown, settle };
  }

  it('logs with the stack, saves a record and offers Restart', async () => {
    const s = setup({ response: 0 });
    s.handle(new Error('boom'));
    const options = await s.dialogShown;
    await s.settle();
    assert.deepEqual(options.buttons, ['Restart Cuewell', 'Quit']);
    assert.equal(options.cancelId, 1);
    assert.deepEqual(s.calls, ['hide windows', 'dialog', 'relaunch', 'exit 0']);
    assert.equal(s.saved.length, 1);
    assert.equal(s.saved[0].kind, 'fatal');
    assert.equal(s.saved[0].message, 'boom');
    assert.match(s.logs[0].meta.stack, /Error: boom/);
  });

  it('quits when the user chooses Quit', async () => {
    const s = setup({ response: 1 });
    s.handle(new Error('boom'));
    await s.dialogShown;
    await s.settle();
    assert.deepEqual(s.calls, ['hide windows', 'dialog', 'exit 1']);
  });

  it('shows one dialog per run', async () => {
    const s = setup({ response: 1 });
    s.handle(new Error('first'));
    s.handle(new Error('second'));
    s.handle(new Error('third'));
    await s.dialogShown;
    await s.settle();
    assert.equal(s.calls.filter((c) => c === 'dialog').length, 1);
    assert.equal(s.saved.length, 1, 'later errors are only logged');
    assert.equal(s.logs.length, 3);
    s.handle(new Error('after the choice'));
    assert.equal(s.calls.filter((c) => c === 'dialog').length, 1);
  });

  it('exits when the dialog itself fails', async () => {
    const s = setup({ dialogFails: true });
    s.handle(new Error('boom'));
    await s.dialogShown;
    await s.settle();
    assert.deepEqual(s.calls, ['hide windows', 'dialog', 'exit 1']);
  });

  it('still shows the dialog when hiding the windows fails', async () => {
    const s = setup({ beforeDialogFails: true, response: 1 });
    s.handle(new Error('boom'));
    await s.dialogShown;
    await s.settle();
    assert.deepEqual(s.calls, ['hide windows', 'dialog', 'exit 1']);
  });

  it('uses the error box before the app is ready, then exits', () => {
    const s = setup({ ready: false });
    s.handle(new Error('early'));
    assert.deepEqual(s.calls, ['errorBox Cuewell could not continue', 'exit 1']);
  });

  it('exits even when the error box fails', () => {
    const s = setup({ ready: false, dialogFails: true });
    s.handle(new Error('early'));
    assert.deepEqual(s.calls, ['errorBox Cuewell could not continue', 'exit 1']);
  });

  it('survives an error whose fields cannot be read', async () => {
    const s = setup({ response: 1 });
    s.handle({ message: Object.create(null) });
    await s.dialogShown;
    await s.settle();
    assert.deepEqual(s.calls, ['hide windows', 'dialog', 'exit 1']);
  });

  it('exits without a dialog while quitting', () => {
    const s = setup({ quitting: true });
    s.handle(new Error('late'));
    assert.deepEqual(s.calls, ['exit 1']);
    assert.equal(s.saved.length, 1);
  });

  it('survives a failing record writer', async () => {
    const s = setup({ response: 1 });
    const handle = createFatalErrorHandler({
      app: { isReady: () => true, relaunch: () => {}, exit: (code) => s.calls.push(`exit ${code}`) },
      dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox: () => {} },
      logger: { error: () => {}, warn: () => {} },
      saveCrash: () => { throw new Error('disk full'); },
    });
    handle(new Error('boom'));
    await s.settle();
    assert.deepEqual(s.calls, ['exit 1']);
  });
});

describe('buildProblemReportUrl with a crash', () => {
  const INFO = { appVersion: '1.2.3', platform: 'darwin', osVersion: '15.1', arch: 'arm64' };
  const bodyOf = (url) => decodeURIComponent(new URL(url).searchParams.get('body'));

  it('adds the error message and stack', () => {
    const crash = { kind: 'fatal', name: 'TypeError', message: 'x is not a function',
      stack: 'TypeError: x is not a function\n    at f (~/main.js:1:1)' };
    const body = bodyOf(buildProblemReportUrl('ankit1324/cuewell', { ...INFO, crash }));
    assert.match(body, /\*\*Crash details\*\*/);
    assert.match(body, /```\nTypeError: x is not a function\n {4}at f \(~\/main\.js:1:1\)\n```/);
    assert.equal(body.split('x is not a function').length, 2, 'message not repeated when the stack has it');
    assert.match(body, /Cuewell 1\.2\.3/);
  });

  it('adds the message when the stack does not start with it', () => {
    const crash = { kind: 'renderer', name: 'WindowCrash', message: 'The chat window stopped (crashed, exit code 11)', stack: '' };
    const body = bodyOf(buildProblemReportUrl('ankit1324/cuewell', { ...INFO, crash }));
    assert.match(body, /```\nWindowCrash: The chat window stopped \(crashed, exit code 11\)\n```/);
  });

  it('truncates a long stack to fit a URL, keeping the top frames', () => {
    const frames = Array.from({ length: 400 }, (_, i) => `    at frame${i} (~/src/some/long/path/module-${i}.js:${i}:1)`);
    const crash = { kind: 'fatal', name: 'Error', message: 'deep', stack: ['Error: deep', ...frames].join('\n') };
    const url = buildProblemReportUrl('ankit1324/cuewell', { ...INFO, crash });
    assert.ok(url.length <= MAX_REPORT_URL_LENGTH, `${url.length}`);
    const body = bodyOf(url);
    assert.match(body, /at frame0 /);
    assert.doesNotMatch(body, /at frame399 /);
    assert.match(body, /\(stack truncated\)/);
    assert.match(body, /Cuewell 1\.2\.3/, 'the system line is kept');
  });

  it('truncates a huge message too', () => {
    const crash = { kind: 'fatal', name: 'Error', message: '%'.repeat(5000), stack: '' };
    const url = buildProblemReportUrl('ankit1324/cuewell', { ...INFO, crash });
    assert.ok(url.length <= MAX_REPORT_URL_LENGTH, `${url.length}`);
  });

  it('survives emoji and lone surrogates in the crash text', () => {
    for (const message of [`a${'\u{1F600}'.repeat(3000)}`, `bad \uD83D half`, `${'\uD83D'.repeat(4000)}`]) {
      const crash = { kind: 'fatal', name: 'Error', message, stack: '' };
      const url = buildProblemReportUrl('ankit1324/cuewell', { ...INFO, crash });
      assert.ok(url.length <= MAX_REPORT_URL_LENGTH, `${url.length}`);
    }
  });

  it('scrubs the crash text again', () => {
    const crash = { kind: 'fatal', name: 'Error', message: 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', stack: '' };
    const body = bodyOf(buildProblemReportUrl('ankit1324/cuewell', { ...INFO, crash }));
    assert.ok(!body.includes('sk-ant-api03'));
  });

  it('is unchanged without a crash', () => {
    const body = bodyOf(buildProblemReportUrl('ankit1324/cuewell', INFO));
    assert.doesNotMatch(body, /Crash details/);
  });
});
