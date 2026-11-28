const test = require('node:test');
const assert = require('node:assert');

const { childProcessEnv } = require('../src/core/whisper-installer');

// Run `fn` with PATH set to `value`. On Windows the variable is usually
// stored as "Path": process.env finds it under any case, but the plain object
// childProcessEnv copies it into does not. So every spelling is removed
// first and the value is stored as "PATH", then the originals come back.
function withPath(value, fn) {
  const saved = Object.keys(process.env).filter((k) => /^path$/i.test(k)).map((k) => [k, process.env[k]]);
  for (const [k] of saved) delete process.env[k];
  process.env.PATH = value;
  try {
    return fn();
  } finally {
    delete process.env.PATH;
    for (const [k, v] of saved) process.env[k] = v;
  }
}

// An app opened from Finder (for example after installing the .dmg) gets
// PATH=/usr/bin:/bin:/usr/sbin:/sbin, which hides Homebrew and python.org
// Python. Only the old /usr/bin/python3 (3.9) is found then.
test('childProcessEnv adds Homebrew and python.org folders to a short macOS PATH', () => {
  withPath('/usr/bin:/bin:/usr/sbin:/sbin', () => {
    const parts = childProcessEnv({}, 'darwin').PATH.split(':');
    assert.deepStrictEqual(parts.slice(0, 4), ['/usr/bin', '/bin', '/usr/sbin', '/sbin']);
    assert.ok(parts.includes('/opt/homebrew/bin'));
    assert.ok(parts.includes('/usr/local/bin'));
    assert.ok(parts.includes('/Library/Frameworks/Python.framework/Versions/Current/bin'));
  });
});

test('childProcessEnv does not repeat folders already on PATH', () => {
  withPath('/opt/homebrew/bin:/usr/bin', () => {
    const parts = childProcessEnv({}, 'darwin').PATH.split(':');
    assert.strictEqual(parts.filter((p) => p === '/opt/homebrew/bin').length, 1);
    assert.strictEqual(parts[0], '/opt/homebrew/bin');
  });
});

test('childProcessEnv leaves PATH alone off macOS', () => {
  withPath('/usr/bin:/bin', () => {
    assert.strictEqual(childProcessEnv({}, 'linux').PATH, '/usr/bin:/bin');
  });
});
