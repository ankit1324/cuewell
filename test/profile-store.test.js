'use strict';
// src/core/profile-store.js: About you and the interview context in
// userData/profile.json.
// All file work happens in a temp folder.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./helpers/env');
const {
  PROFILE_FIELD_LIMITS, ABOUT_FIELD_LIMITS, ABOUT_FIELD_CHOICES, ALL_FIELDS,
  ProfileValidationError, emptyProfile, validateProfile, readProfile, writeProfile,
} = require('../src/core/profile-store');

const CONTEXT_FIELDS = ['role', 'company', 'jobDescription', 'resume', 'notes'];
const ABOUT_TEXT_FIELDS = ['fullName', 'preferredName', 'currentTitle', 'currentCompany', 'skills', 'achievements',
  'education', 'location', 'noticePeriod', 'expectedSalary', 'languages', 'answerLanguage'];
const FIELDS = [...CONTEXT_FIELDS, ...ABOUT_TEXT_FIELDS, 'yearsExperience', 'relocation', 'tone'];
const ALL_LIMITS = { ...PROFILE_FIELD_LIMITS, ...ABOUT_FIELD_LIMITS };
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
    assert.deepEqual({ ...ABOUT_FIELD_LIMITS }, {
      fullName: 100, preferredName: 60, currentTitle: 150, currentCompany: 150, skills: 500, achievements: 4000,
      education: 500, location: 150, noticePeriod: 100, expectedSalary: 100, languages: 200, answerLanguage: 40,
    });
    assert.deepEqual(ABOUT_FIELD_CHOICES, {
      relocation: ['yes', 'no', 'maybe'], tone: ['confident', 'friendly', 'formal', 'concise'],
    });
    assert.deepEqual([...ALL_FIELDS], FIELDS);
    for (const frozen of [PROFILE_FIELD_LIMITS, ABOUT_FIELD_LIMITS, ABOUT_FIELD_CHOICES, ALL_FIELDS,
      ABOUT_FIELD_CHOICES.relocation, ABOUT_FIELD_CHOICES.tone]) {
      assert.ok(Object.isFrozen(frozen));
    }
  });

  it('has every field empty in an empty profile', () => {
    const empty = emptyProfile();
    assert.deepEqual(Object.keys(empty), FIELDS);
    assert.ok(Object.values(empty).every((value) => value === ''));
  });

  it('fills missing and null fields with empty strings', () => {
    assert.deepEqual(validateProfile({}), emptyProfile());
    assert.deepEqual(Object.keys(validateProfile({ role: null })), FIELDS);
    assert.equal(validateProfile({ role: null }).role, '');
  });

  it('accepts every field at its limit and rejects one character more', () => {
    for (const [field, limit] of Object.entries(ALL_LIMITS)) {
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
    rejects({ fullName: 1 }, 'fullName');
    rejects({ achievements: ['a'] }, 'achievements');
    rejects({ tone: 1 }, 'tone');
    rejects({ relocation: true }, 'relocation');
    rejects({ yearsExperience: true }, 'yearsExperience');
    rejects({ yearsExperience: ['5'] }, 'yearsExperience');
  });

  it('loads a profile from before About you existed', () => {
    const old = { role: 'SWE', company: 'Acme', jobDescription: 'JD', resume: 'CV', notes: 'n' };
    assert.deepEqual(validateProfile(old), { ...emptyProfile(), ...old });
  });

  it('accepts and normalizes years of experience from 0 to 60', () => {
    const years = (value) => validateProfile({ yearsExperience: value }).yearsExperience;
    assert.equal(years(''), '');
    assert.equal(years('   '), '');
    assert.equal(years('0'), '0');
    assert.equal(years(' 5 '), '5');
    assert.equal(years('05'), '5');
    assert.equal(years('3.5'), '3.5');
    assert.equal(years('3.0'), '3');
    assert.equal(years('2,5'), '2.5');
    assert.equal(years('60'), '60');
    assert.equal(years(7), '7');
    assert.equal(years(4.25), '4.3');
    assert.equal(years(0), '0');
  });

  it('rejects years of experience that are not a number from 0 to 60', () => {
    for (const value of ['61', '60.5', '-1', '100', 'five', '5 years', '5+', '1e1', '3.25', '.5', '5.', 'Infinity',
      '0x10', -1, 61, NaN, Infinity]) {
      assert.throws(() => validateProfile({ yearsExperience: value }), (error) => {
        assert.ok(error instanceof ProfileValidationError, String(value));
        assert.equal(error.field, 'yearsExperience');
        assert.equal(error.message, 'Years of experience must be a number from 0 to 60.');
        return true;
      }, String(value));
    }
  });

  it('accepts the listed choices, lowercased, and empty', () => {
    for (const [field, choices] of Object.entries(ABOUT_FIELD_CHOICES)) {
      for (const choice of choices) {
        assert.equal(validateProfile({ [field]: choice })[field], choice);
        assert.equal(validateProfile({ [field]: ` ${choice.toUpperCase()} ` })[field], choice);
      }
      assert.equal(validateProfile({ [field]: '' })[field], '');
    }
  });

  it('rejects any other choice without echoing it', () => {
    for (const [field, value] of [['relocation', 'sometimes'], ['tone', 'sarcastic'], ['tone', 'constructor'],
      ['relocation', '__proto__'], ['tone', 'toString']]) {
      assert.throws(() => validateProfile({ [field]: value }), (error) => {
        assert.equal(error.field, field);
        assert.ok(!error.message.includes(value), error.message);
        return true;
      });
    }
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

  it('keeps About you fields on one line except achievements and education', () => {
    const input = {};
    for (const field of ABOUT_TEXT_FIELDS) input[field] = 'a\nb';
    const clean = validateProfile(input);
    for (const field of ABOUT_TEXT_FIELDS) {
      const multiLine = field === 'achievements' || field === 'education';
      assert.equal(clean[field], multiLine ? 'a\nb' : 'a b', field);
    }
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
      'string.json': '"role"',
      'null.json': 'null',
      'wrong-type.json': '{"role": 7}',
      'too-long.json': JSON.stringify({ role: 'x'.repeat(201) }),
      'bad-years.json': '{"yearsExperience": "lots"}',
      'bad-choice.json': '{"tone": "sarcastic"}',
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

  it('loads a file from before About you existed', (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    const old = { role: 'SWE', company: 'Acme', jobDescription: 'JD', resume: 'CV', notes: 'n' };
    fs.writeFileSync(file, JSON.stringify(old, null, 2));
    assert.deepEqual(readProfile(file), { profile: { ...emptyProfile(), ...old }, error: null });
  });

  it('ignores unknown fields in the file, for example from a newer version', (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    fs.writeFileSync(file, '{"role": "SWE", "fullName": "Priya", "futureField": "x", "__proto__": {"tone": "formal"}}');
    const { profile, error } = readProfile(file);
    assert.equal(error, null);
    assert.deepEqual(profile, { ...emptyProfile(), role: 'SWE', fullName: 'Priya' });
    assert.ok(!Object.prototype.hasOwnProperty.call(profile, 'futureField'));
  });

  it('keeps the valid fields when one field is invalid, and names the bad ones', (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    fs.writeFileSync(file, JSON.stringify({
      role: 'SWE', fullName: 'Priya', yearsExperience: 'lots', tone: 'sarcastic', company: 7, notes: 'n',
    }));
    const { profile, error } = readProfile(file);
    assert.deepEqual(profile, { ...emptyProfile(), role: 'SWE', fullName: 'Priya', notes: 'n' });
    assert.match(error, /company/);
    assert.match(error, /yearsExperience/);
    assert.match(error, /tone/);
    assert.doesNotMatch(error, /Priya|lots|sarcastic/);
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

  it('reads back every About you field', (t) => {
    const file = path.join(tempDir(t), 'profile.json');
    const written = writeProfile(file, {
      fullName: 'Priya Sharma', preferredName: 'Priya', currentTitle: 'SDE 2', currentCompany: 'Globex',
      yearsExperience: '4.5', skills: 'Go, Kafka', achievements: '- Cut latency 40%\n- Led a migration',
      education: 'B.Tech, NIT Trichy, 2019', location: 'Pune', relocation: 'Maybe', noticePeriod: '30 days',
      expectedSalary: '18-22 LPA', languages: 'English, Hindi', tone: 'Formal', answerLanguage: 'Hindi',
    });
    assert.equal(written.relocation, 'maybe');
    assert.equal(written.tone, 'formal');
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
    assert.throws(() => writeProfile(file, { yearsExperience: '99' }), ProfileValidationError);
    assert.throws(() => writeProfile(file, { tone: 'loud' }), ProfileValidationError);
    assert.equal(readProfile(file).profile.role, 'Original');
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });

  it('throws the file system error when the folder does not exist', (t) => {
    const file = path.join(tempDir(t), 'missing', 'profile.json');
    assert.throws(() => writeProfile(file, { role: 'SWE' }), { code: 'ENOENT' });
  });
});
