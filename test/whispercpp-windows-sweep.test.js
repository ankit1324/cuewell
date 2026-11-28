'use strict';
// The Windows sweep in src/services/whispercpp-engine.service.js: after a
// crash, whisper-server.exe processes whose Cuewell is gone are stopped,
// but only when the pid, full program path and creation time all match the
// record. Process inspection, kill and liveness are injected, so this runs
// on any OS and never touches a real process. Records go to temp folders.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers/env');

const {
  sweepWindowsServers, parseWindowsProcessInfo, inspectWindowsProcess, killWindowsProcess,
} = require('../src/services/whispercpp-engine.service');

const EXE = 'C:\\Program Files\\Cuewell\\resources\\whisper\\win32-x64\\whisper-server.exe';
const CREATED = '2025-01-02T03:04:05.1234560Z';
const OWNER = 4100; // a Cuewell that is gone
const SERVER = 5200;

function writeRecord(tmp, name, content, { mtime } = {}) {
  const dir = path.join(tmp, `cuewell-wcpp-${name}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'owner.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  if (mtime) fs.utimesSync(dir, mtime, mtime);
  return dir;
}

function record(fields = {}) {
  return { owner: OWNER, server: SERVER, path: EXE, created: CREATED, ...fields };
}

/** Injected tools: `processes` maps pid -> { path, created } (missing = gone). */
function tools({
  alive = [], processes = { [SERVER]: { path: EXE, created: CREATED } }, inspectError, killError, killResult = true,
} = {}) {
  const calls = { inspected: [], killed: [], expected: [], logs: [] };
  return {
    calls,
    options: {
      isAliveFn: (pid) => alive.includes(pid),
      inspectProcessFn: async (pid) => {
        calls.inspected.push(pid);
        if (inspectError) throw inspectError;
        return processes[pid] || null;
      },
      killProcessFn: async (pid, expected) => {
        calls.killed.push(pid);
        calls.expected.push(expected);
        if (killError) throw killError;
        return killResult;
      },
      logger: {
        info: (message, meta) => calls.logs.push({ level: 'info', message, meta }),
        warn: (message, meta) => calls.logs.push({ level: 'warn', message, meta }),
      },
    },
  };
}

describe('Windows stale whisper-server sweep', () => {
  it('leaves a server alone while its Cuewell still runs', async (t) => {
    const tmp = tempDir(t);
    const dir = writeRecord(tmp, 'a', record());
    const { calls, options } = tools({ alive: [OWNER] });
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.inspected, []);
    assert.deepEqual(calls.killed, []);
    assert.ok(fs.existsSync(dir), 'the record stays');
  });

  it('stops a leftover server when pid, path and creation time match, and removes the record', async (t) => {
    const tmp = tempDir(t);
    const dir = writeRecord(tmp, 'b', record());
    const { calls, options } = tools();
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.inspected, [SERVER]);
    assert.deepEqual(calls.killed, [SERVER]);
    assert.deepEqual(calls.expected, [{ path: EXE, created: CREATED }], 'the kill checks the same path and time again');
    assert.equal(fs.existsSync(dir), false);
    assert.ok(calls.logs.some((l) => /Stopped a whisper.cpp server/.test(l.message) && l.meta.pid === SERVER));
  });

  it('a kill that finds the process gone or changed by then reports it and removes the record', async (t) => {
    const tmp = tempDir(t);
    const dir = writeRecord(tmp, 'b2', record());
    const { calls, options } = tools({ killResult: false });
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.killed, [SERVER]);
    assert.equal(calls.logs.some((l) => /Stopped/.test(l.message)), false);
    assert.ok(calls.logs.some((l) => /already gone or changed/.test(l.message)));
    assert.equal(fs.existsSync(dir), false);
  });

  it('matches the path ignoring case and separators', async (t) => {
    const tmp = tempDir(t);
    writeRecord(tmp, 'c', record());
    const { calls, options } = tools({
      processes: { [SERVER]: { path: EXE.toUpperCase().replace(/\\/g, '/'), created: CREATED } },
    });
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.killed, [SERVER]);
  });

  it('never stops a process with another program path', async (t) => {
    const tmp = tempDir(t);
    const dir = writeRecord(tmp, 'd', record());
    const { calls, options } = tools({
      processes: { [SERVER]: { path: 'C:\\Windows\\System32\\notepad.exe', created: CREATED } },
    });
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.inspected, [SERVER]);
    assert.deepEqual(calls.killed, []);
    assert.equal(fs.existsSync(dir), false, 'the record is removed');
  });

  it('never stops a process that reused the pid (other creation time)', async (t) => {
    const tmp = tempDir(t);
    writeRecord(tmp, 'e', record());
    const { calls, options } = tools({
      processes: { [SERVER]: { path: EXE, created: '2025-01-03T00:00:00.0000000Z' } },
    });
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.killed, []);
  });

  it('removes the record when the server is already gone', async (t) => {
    const tmp = tempDir(t);
    const dir = writeRecord(tmp, 'f', record());
    const { calls, options } = tools({ processes: {} });
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.inspected, [SERVER]);
    assert.deepEqual(calls.killed, []);
    assert.equal(fs.existsSync(dir), false);
  });

  it('never stops anything when the check fails, and logs it', async (t) => {
    const tmp = tempDir(t);
    const dir = writeRecord(tmp, 'g', record());
    const { calls, options } = tools({ inspectError: new Error('PowerShell exited with code 1') });
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.killed, []);
    assert.ok(calls.logs.some((l) => l.level === 'warn' && /Could not check/.test(l.message)));
    assert.equal(fs.existsSync(dir), false);
  });

  it('logs a kill that fails and carries on', async (t) => {
    const tmp = tempDir(t);
    writeRecord(tmp, 'h1', record());
    writeRecord(tmp, 'h2', record({ server: SERVER + 1 }));
    const { calls, options } = tools({
      processes: { [SERVER]: { path: EXE, created: CREATED }, [SERVER + 1]: { path: EXE, created: CREATED } },
      killError: new Error('PowerShell exited with code 1'),
    });
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.killed.sort(), [SERVER, SERVER + 1]);
    assert.ok(calls.logs.some((l) => /Could not stop/.test(l.message)));
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  it('ignores malformed records and never inspects or stops for them', async (t) => {
    const tmp = tempDir(t);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const bad = [
      record({ server: 'calc' }),
      record({ server: -1 }),
      record({ server: 1.5 }),
      record({ path: 'whisper-server.exe' }), // not absolute
      record({ path: 'C:\\Windows\\System32\\cmd.exe' }), // not our program
      record({ path: null }),
      record({ created: null }), // creation time not read yet
      record({ created: '' }),
      record({ created: 5 }),
    ];
    bad.forEach((content, i) => writeRecord(tmp, `bad${i}`, content));
    const fresh = writeRecord(tmp, 'json-new', '{not json');
    writeRecord(tmp, 'json-old', '{not json', { mtime: old });
    writeRecord(tmp, 'owner-old', JSON.stringify(record({ owner: 'x' })), { mtime: old });
    const array = writeRecord(tmp, 'array-new', '[]');
    fs.writeFileSync(path.join(tmp, 'cuewell-wcpp-file'), 'a file, not a folder');
    const other = path.join(tmp, 'unrelated');
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, 'owner.json'), JSON.stringify(record()));

    const { calls, options } = tools();
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.deepEqual(calls.inspected, []);
    assert.deepEqual(calls.killed, []);
    // Dead owner, nothing to check: removed. Unreadable and new: maybe a
    // start in progress, kept; unreadable and old: removed.
    assert.deepEqual(fs.readdirSync(tmp).sort(),
      [path.basename(array), path.basename(fresh), 'cuewell-wcpp-file', 'unrelated'].sort());
  });

  it('checks at most five leftover servers per sweep', async (t) => {
    const tmp = tempDir(t);
    const processes = {};
    for (let i = 0; i < 7; i += 1) {
      writeRecord(tmp, `many${String(i).padStart(2, '0')}`, record({ server: SERVER + i }));
      processes[SERVER + i] = { path: EXE, created: CREATED };
    }
    const { calls, options } = tools({ processes });
    await sweepWindowsServers({ tmpdir: tmp, ...options });
    assert.equal(calls.killed.length, 5);
    assert.equal(fs.readdirSync(tmp).length, 2, 'the rest wait for the next run');
  });

  it('a missing temp folder is not an error', async (t) => {
    const { calls, options } = tools();
    await sweepWindowsServers({ tmpdir: path.join(tempDir(t), 'missing'), ...options });
    assert.deepEqual(calls.inspected, []);
  });
});

describe('Windows process check output', () => {
  it('parses "found" with a base64 UTF-8 path, and "gone"', () => {
    const exe = 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Cuewell\\whisper-server.exe';
    const line = `found|${Buffer.from(exe, 'utf8').toString('base64')}|${CREATED}`;
    assert.deepEqual(parseWindowsProcessInfo(`\r\n${line}\r\n`), { path: exe, created: CREATED });
    assert.deepEqual(parseWindowsProcessInfo('found||'), { path: '', created: '' });
    assert.equal(parseWindowsProcessInfo('gone\r\n'), null);
  });

  it('throws on anything else, so a broken check never reads as "gone"', () => {
    assert.throws(() => parseWindowsProcessInfo(''));
    assert.throws(() => parseWindowsProcessInfo('Get-CimInstance : Access denied'));
    assert.throws(() => parseWindowsProcessInfo('found|not base64!|x'));
  });

  it('accepts only numeric pids and runs nothing for others', async () => {
    const expected = { path: EXE, created: CREATED };
    for (const pid of ['1234', '1; Stop-Process', -1, 0, 1.5, NaN, null]) {
      await assert.rejects(inspectWindowsProcess(pid), /Not a process id/);
      await assert.rejects(killWindowsProcess(pid, expected), /Not a process id/);
    }
  });

  it('never kills without a path and creation time to compare with', async () => {
    for (const expected of [undefined, {}, { path: EXE }, { created: CREATED }, { path: '', created: CREATED }]) {
      await assert.rejects(killWindowsProcess(SERVER, expected), /No process to compare with/);
    }
  });
});
