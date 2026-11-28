'use strict';

// NOTICE must name every third-party component the builds bundle, and each
// license file it points to must exist (they ship inside the app).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const notice = fs.readFileSync(path.join(root, 'NOTICE'), 'utf8');

describe('NOTICE', () => {
  it('names the bundled voice engine and its runtimes', () => {
    for (const name of ['whisper.cpp', 'ggml', 'libgomp', 'GCC Runtime Library Exception', 'Visual C++ runtime', 'MIT License']) {
      assert.ok(notice.includes(name), `NOTICE should mention ${name}`);
    }
  });

  it('points only at license files that exist', () => {
    const referenced = notice.match(/(?:licenses|assests\/[\w/-]+)\/[\w.-]+\.txt/g) || [];
    assert.ok(referenced.length >= 4);
    for (const file of referenced) {
      assert.ok(fs.existsSync(path.join(root, file)), `${file} is referenced in NOTICE but missing`);
    }
  });

  it('ships the full license texts the GPL and MIT require', () => {
    assert.match(fs.readFileSync(path.join(root, 'licenses/GPL-3.0.txt'), 'utf8'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/);
    assert.match(fs.readFileSync(path.join(root, 'licenses/GCC-Runtime-Library-Exception-3.1.txt'), 'utf8'), /GCC RUNTIME LIBRARY EXCEPTION/);
    assert.match(fs.readFileSync(path.join(root, 'licenses/whisper.cpp-MIT.txt'), 'utf8'), /MIT License[\s\S]*The ggml authors/);
  });
});
