const test = require('node:test');
const assert = require('node:assert');

const { childProcessEnv } = require('../src/core/whisper-installer');

// An app opened from Finder (for example after installing the .dmg) gets
// PATH=/usr/bin:/bin:/usr/sbin:/sbin, which hides Homebrew and python.org
// Python. Only the old /usr/bin/python3 (3.9) is found then.
test('childProcessEnv adds Homebrew and python.org folders to a short macOS PATH', () => {
  const saved = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    const parts = childProcessEnv({}, 'darwin').PATH.split(':');
    assert.deepStrictEqual(parts.slice(0, 4), ['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    assert.ok(parts.includes('/opt/homebrew/bin'));
    assert.ok(parts.includes('/usr/local/bin'));
    assert.ok(parts.includes('/Library/Frameworks/Python.framework/Versions/Current/bin'));
  } finally {
    process.env.PATH = saved;
  }
});

test('childProcessEnv does not repeat folders already on PATH', () => {
  const saved = process.env.PATH;
  process.env.PATH = '/opt/homebrew/bin:/usr/bin';
  try {
    const parts = childProcessEnv({}, 'darwin').PATH.split(':');
    assert.strictEqual(parts.filter((p) => p === '/opt/homebrew/bin').length, 1);
    assert.strictEqual(parts[0], '/opt/homebrew/bin');
  } finally {
    process.env.PATH = saved;
  }
});

test('childProcessEnv leaves PATH alone off macOS', () => {
  const saved = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    assert.strictEqual(childProcessEnv({}, 'linux').PATH, '/usr/bin:/bin');
  } finally {
    process.env.PATH = saved;
  }
});
