'use strict';
// src/core/profile-store.js: the interview context in userData/profile.json.
// All file work happens in a temp folder.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers/env');
const {
  PROFILE_FIELD_LIMITS, ProfileValidationError, emptyProfile, validateProfile, readProfile, writeProfile,
} = require('../src/core/profile-store');

const FIELDS = ['role', 'company', 'jobDescription', 'resume', 'notes'];
const isPosix = process.platform !== 'win32';

function rejects(input, field) {
  assert.throws(() => validateProfile(input), (error) => {
    assert.ok(error instanceof ProfileValidationError, `expected ProfileValidationError, got ${error}`);
    assert.equal(error.field, field);
    assert.ok(error.message.length > 0);
    return true;
  });
}

describe('validateProfile', () => {
  it('has the documented limits', () => {
    assert.deepEqual({ ...PROFILE_FIELD_LIMITS },
      { role: 200, company: 200, jobDescription: 20000, resume: 20000, notes: 20000 });
    assert.ok(Object.isFrozen(PROFILE_FIELD_LIMITS));
  });

  it('fills missing and null fields with empty strings', () => {
    assert.deepEqual(validateProfile({}), emptyProfile());
    assert.deepEqual(Object.keys(validateProfile({ role: null })), FIELDS);
    assert.equal(validateProfile({ role: null }).role, '');
  });

  it('accepts every field at its limit and rejects one character more', () => {
    for (const [field, limit] of Object.entries(PROFILE_FIELD_LIMITS)) {
      assert.equal(validateProfile({ [field]: 'x'.repeat(limit) })[field].length, limit);
      rejects({ [field]: 'x'.repeat(limit + 1) }, field);
    }
  });

  it('measures the limit after trimming', () => {
    assert.equal(validateProfile({ role: `  ${'x'.repeat(200)}  ` }).role.length, 200);
  });

  it('rejects unknown fields, including prototype keys', () => {
    rejects({ role: 'SWE', salary: '1' }, 'salary');
    rejects(JSON.parse('{"__proto__": {"x": 1}}'), '__proto__');
    rejects({ constructor: 'x' }, 'constructor');
  });

  it('rejects values that are not text', () => {
    rejects({ role: 42 }, 'role');
    rejects({ notes: ['a'] }, 'notes');
    rejects({ resume: { text: 'a' } }, 'resume');
    rejects({ company: true }, 'company');
  });

  it('rejects input that is not an object', () => {
    for (const input of [null, undefined, 'text', 1, [], ['role']]) rejects(input, null);
  });

  it('normalizes line endings, drops control characters and trims', () => {
    const clean = validateProfile({ resume: '  a\r\nb\rc\u0000\u0007\u001b[0m\td\u007f  ', notes: '\n\nnote\n' });
    assert.equal(clean.resume, 'a\nb\nc[0m\td');
    assert.equal(clean.notes, 'note');
  });

  it('keeps role and company on one line', () => {
    const clean = validateProfile({ role: 'Senior\n\nEngineer', company: 'Acme\t\tInc\r\n' });
    assert.equal(clean.role, 'Senior Engineer');
    assert.equal(clean.company, 'Acme Inc');
  });

  it('keeps non-ASCII text', () => {
    assert.equal(validateProfile({ company: 'Zürich AG — 東京' }).company, 'Zürich AG — 東京');
  });

  it('returns a copy, never the input', () => {
    const input = { role: 'SWE' };
    const clean = validateProfile(input);
    assert.notEqual(clean, input);
    clean.role = 'changed';
    assert.equal(input.role, 'SWE');
  });
});

describe('readProfile', () => {
  it('treats a missing file as an empty profile without an error', (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    assert.deepEqual(readProfile(file), { profile: emptyProfile(), error: null });
  });

  it('loads a broken file as empty and reports why', (t) => {
    const dir = tempDir(t);
    const cases = {
      'not-json.json': '{"role": "SWE"',
      'array.json': '["role"]',
      'unknown-field.json': '{"role": "SWE", "extra": 1}',
      'wrong-type.json': '{"role": 7}',
      'too-long.json': JSON.stringify({ role: 'x'.repeat(201) }),
      'empty.json': '',
    };
    for (const [name, content] of Object.entries(cases)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content);
      const { profile, error } = readProfile(file);
      assert.deepEqual(profile, emptyProfile(), name);
      assert.equal(typeof error, 'string', name);
      assert.ok(error.length > 0, name);
    }
  });

  it('refuses a folder and an oversized file', (t) => {
    const dir = tempDir(t);
    assert.match(readProfile(dir).error, /not a file/);
    const big = path.join(dir, 'big.json');
    fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1, 0x20));
    assert.match(readProfile(big).error, /too large/);
  });

  it('reads back what writeProfile wrote', (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    const written = writeProfile(file, { role: 'Backend engineer', resume: 'Line 1\nLine 2' });
    assert.deepEqual(readProfile(file), { profile: written, error: null });
  });
});

describe('writeProfile', () => {
  it('writes the clean profile as JSON', (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    const clean = writeProfile(file, { role: ' SWE ', notes: 'a\r\nb' });
    assert.deepEqual(clean, { ...emptyProfile(), role: 'SWE', notes: 'a\nb' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), clean);
  });

  it('creates the file with mode 0600', { skip: !isPosix && 'POSIX file modes only' }, (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    writeProfile(file, { role: 'SWE' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('tightens an existing world-readable file to 0600', { skip: !isPosix && 'POSIX file modes only' }, (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    writeProfile(file, { role: 'SWE' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });

  it('replaces a leftover temp file instead of keeping its mode', { skip: !isPosix && 'POSIX file modes only' }, (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    fs.writeFileSync(`${file}.tmp`, 'stale', { mode: 0o666 });
    fs.chmodSync(`${file}.tmp`, 0o666);
    writeProfile(file, { company: 'Acme' });
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(readProfile(file).profile.company, 'Acme');
  });

  it('leaves no temp file behind', (t) => {
    const dir = tempDir(t);
    writeProfile(path.join(dir, 'profile.json'), { role: 'SWE' });
    assert.deepEqual(fs.readdirSync(dir), ['profile.json']);
  });

  it('keeps the old file when validation fails', (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    writeProfile(file, { role: 'Original' });
    assert.throws(() => writeProfile(file, { role: 'x'.repeat(201) }), ProfileValidationError);
    assert.throws(() => writeProfile(file, { unknown: 'x' }), ProfileValidationError);
    assert.equal(readProfile(file).profile.role, 'Original');
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });

  it('throws the file system error when the folder does not exist', (t) => {
    const file = path.join(tempDir(t), 'missing', 'profile.json');
    assert.throws(() => writeProfile(file, { role: 'SWE' }), { code: 'ENOENT' });
  });
});
