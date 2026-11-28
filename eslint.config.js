'use strict';
// ESLint flat config: the recommended rules only, no formatting rules.
// Main-process code, scripts and tests run in Node; page scripts run in the
// sandboxed renderers as classic <script> files that share one global scope;
// the preloads see both (require('electron'), process and document).
const js = require('@eslint/js');
const globals = require('globals');

// Loaded with <script src> by the HTML pages.
const PAGE_SCRIPTS = ['src/ui/**/*.js', 'lib/**/*.js', 'onboarding.js'];
const PRELOADS = ['preload.js', 'preload-content.js'];

const UNUSED_VARS = {
  args: 'after-used',
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  caughtErrors: 'all',
  caughtErrorsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  ignoreRestSiblings: true,
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'vendor/**',
      'website/**',
      'assests/**',
      'coverage/**',
      '.venv-whisper/**',
    ],
  },
  js.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    languageOptions: { ecmaVersion: 2024 },
    rules: {
      // `catch (_) {}` is the project's way to ignore a best-effort failure.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', UNUSED_VARS],
    },
  },
  {
    // Node: the main process and its modules, build and setup scripts, tests.
    files: ['**/*.js'],
    ignores: [...PAGE_SCRIPTS, ...PRELOADS],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    files: PAGE_SCRIPTS,
    languageOptions: {
      sourceType: 'script',
      globals: {
        ...globals.browser,
        // Set by other <script> files on the same page.
        Prism: 'readonly', // node_modules/prismjs/prism.js
        sanitizeHtml: 'readonly', // lib/safe-html.js
      },
    },
  },
  {
    // Sandboxed preloads: require('electron') and process, plus the page's DOM.
    files: PRELOADS,
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser },
    },
  },
];
