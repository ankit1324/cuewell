'use strict';
// onboarding.js: every screen change also updates the "Set up later" button.
// showScreen used to be wrapped by reassigning the function declaration
// (ESLint no-func-assign); the update now lives in showScreen itself.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readSource, extractFunctionSource } = require('./helpers/source');

describe('onboarding showScreen', () => {
  const source = readSource('onboarding.js');

  it('is one function that refreshes the stepper and the skip button', () => {
    const body = extractFunctionSource(source, 'showScreen'); // throws when defined twice
    assert.match(body, /refreshStepper\(\);/);
    assert.match(body, /refreshSkipVisibility\(\);\s*\}$/);
  });

  it('is never reassigned', () => {
    assert.doesNotMatch(source, /(^|[^.\w])showScreen\s*=[^=]/);
  });
});
