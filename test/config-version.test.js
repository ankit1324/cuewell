'use strict';

// The app version comes from package.json, never a hard-coded copy.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');

describe('config app.version', () => {
  it('matches package.json', () => {
    const config = require('../src/core/config');
    assert.equal(config.get('app.version'), pkg.version);
    assert.notEqual(config.get('app.version'), '1.0.0');
  });
});
