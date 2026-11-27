'use strict';
// Helpers for testing code that is not exported: read a file from the repo
// and pull one function (or expression) out of its source, the way a browser
// would see it, then compile it on its own.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');

function repoPath(...parts) {
  return path.join(ROOT, ...parts);
}

function readSource(relativePath) {
  return fs.readFileSync(repoPath(relativePath), 'utf8');
}

function compiles(code) {
  try {
    new vm.Script(code);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The shortest slice of `source` from `start` that ends at one of the
 * `closers` characters and compiles as `(<slice>)`. Shorter slices end
 * inside the body and do not compile, so the first match is the whole thing.
 */
function sliceCompiling(source, start, closers, wrap) {
  for (let i = start; i < source.length; i++) {
    if (!closers.includes(source[i])) continue;
    const slice = source.slice(start, i + 1);
    if (compiles(wrap(slice))) return slice;
  }
  throw new Error(`No complete expression found at offset ${start}`);
}

/**
 * Source of `function <name>(...) {...}` in `source`, or of a class method
 * `<name>(...) {...}` (returned as a function declaration). Throws when the
 * name is not found, so a rename fails the test instead of skipping it, and
 * when it is defined more than once, so the wrong copy is never tested.
 */
function extractFunctionSource(source, name) {
  const declarations = matchAll(source, new RegExp(`(^|\\n)[ \\t]*(?:async[ \\t]+)?function[ \\t]+${name}[ \\t]*\\(`, 'g'));
  const methods = matchAll(source, new RegExp(`(^|\\n)[ \\t]+${name}[ \\t]*\\([^)]*\\)[ \\t]*\\{`, 'g'));
  if (declarations.length + methods.length > 1) {
    throw new Error(`Function ${name} is defined ${declarations.length + methods.length} times; expected one`);
  }
  if (declarations.length) {
    const start = source.indexOf('function', declarations[0].index);
    return sliceCompiling(source, start, '}', (s) => `(${s})`);
  }
  if (methods.length) {
    const start = source.indexOf(name, methods[0].index);
    return 'function ' + sliceCompiling(source, start, '}', (s) => `(function ${s})`);
  }
  throw new Error(`Function ${name} not found`);
}

function matchAll(source, regex) {
  return [...source.matchAll(regex)];
}

// Compiled in this realm (not a vm context) so returned objects and arrays
// have the normal prototypes and assert.deepStrictEqual compares them. The
// code only sees the names in `globals` besides the usual built-ins.
function evaluate(expression, globals, label) {
  const names = Object.keys(globals);
  const factory = new Function(...names, `return (${expression});\n//# sourceURL=${label}`);
  return factory(...names.map((n) => globals[n]));
}

/** Compile function `name` from `relativePath`; `globals` are the free names it may use. */
function loadFunction(relativePath, name, globals = {}) {
  const code = extractFunctionSource(readSource(relativePath), name);
  return evaluate(code, globals, `${relativePath}#${name}`);
}

/** Evaluate the initializer of `const <name> = ...;` in `relativePath`. */
function loadConstant(relativePath, name, globals = {}) {
  const source = readSource(relativePath);
  const matches = matchAll(source, new RegExp(`(^|\\n)const[ \\t]+${name}[ \\t]*=[ \\t]*`, 'g'));
  if (matches.length !== 1) throw new Error(`Constant ${name} found ${matches.length} times in ${relativePath}; expected one`);
  const match = matches[0];
  const start = match.index + match[0].length;
  const expression = sliceCompiling(source, start, ';', (s) => `(${s.replace(/;$/, '')})`).replace(/;$/, '');
  return evaluate(expression, globals, `${relativePath}#${name}`);
}

module.exports = { ROOT, repoPath, readSource, extractFunctionSource, loadFunction, loadConstant };
