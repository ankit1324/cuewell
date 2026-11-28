'use strict';
// Light and dark variants of the Cue Card theme: theme.css defines the same
// tokens for both, component CSS uses tokens instead of light-only colors,
// text pairs meet WCAG AA in both, and main.js / the window manager agree on
// the theme values and paper colors.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readSource, loadConstant, loadFunction } = require('./helpers/source');

const THEME_CSS = readSource('src/styles/theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
const COMPONENT_CSS = ['toolbar.css', 'answer.css', 'chat.css', 'settings.css', 'onboarding.css', 'common.css', 'icons.css'];
const PAGES = ['index.html', 'llm-response.html', 'chat.html', 'settings.html', 'onboarding.html'];

/** Body of the block opened by the first `selector {` at or after `from`. */
function blockBody(css, selector, from = 0) {
  const open = css.indexOf(`${selector} {`, from);
  assert.ok(open >= 0, `no ${selector} block`);
  let depth = 0;
  const start = css.indexOf('{', open);
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(start + 1, i);
  }
  throw new Error(`unclosed ${selector} block`);
}

/** { property: value } of a block body; ';' inside quotes or parentheses does not end a value. */
function declarations(body) {
  const out = {};
  let current = '';
  let depth = 0;
  let quote = null;
  const flush = () => {
    const text = current.trim();
    current = '';
    if (!text) return;
    const colon = text.indexOf(':');
    assert.ok(colon > 0, `bad declaration: ${text}`);
    const name = text.slice(0, colon).trim();
    assert.ok(!(name in out), `${name} is declared twice`);
    out[name] = text.slice(colon + 1).trim().replace(/\s+/g, ' ');
  };
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === ';' && depth === 0) {
      flush();
      continue;
    }
    current += ch;
  }
  flush();
  return out;
}

const LIGHT = declarations(blockBody(THEME_CSS, ':root'));
const DARK = declarations(blockBody(THEME_CSS, 'html[data-theme="dark"]'));
const MEDIA = blockBody(THEME_CSS, '@media (prefers-color-scheme: dark)');
const SYSTEM_DARK = declarations(blockBody(MEDIA, 'html[data-theme="system"]'));

// A token whose value carries a color: it has to be redefined for dark.
const isColorToken = (name, value) =>
  /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|url\(/i.test(value) || /-rgb$/.test(name);

// ---- WCAG 2.x contrast ----
function rgb(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  assert.ok(hex, `not a #rrggbb color: ${value}`);
  return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
}
function luminance([r, g, b]) {
  const lin = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a, b) {
  const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** A token's #rrggbb value in `tokens`, following var() references. */
function color(tokens, name) {
  let value = tokens[name] !== undefined ? tokens[name] : LIGHT[name];
  for (let i = 0; i < 5 && /^var\(/.test(value || ''); i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value)[1];
    value = tokens[ref] !== undefined ? tokens[ref] : LIGHT[ref];
  }
  return value;
}

describe('theme.css variants', () => {
  it('redefines every color token of the light variant for dark', () => {
    const missing = Object.entries(LIGHT)
      .filter(([name, value]) => name.startsWith('--') && isColorToken(name, value) && !(name in DARK))
      .map(([name]) => name);
    assert.deepEqual(missing, []);
    assert.ok(Object.keys(DARK).length > 40, 'dark block looks empty');
  });

  it('defines no token that light does not have (one token set)', () => {
    const extra = Object.keys(DARK).filter((name) => name !== 'color-scheme' && !(name in LIGHT));
    assert.deepEqual(extra, []);
  });

  it('uses the same dark tokens for data-theme="dark" and for "system" on a dark system', () => {
    assert.deepEqual(SYSTEM_DARK, DARK);
  });

  it('sets color-scheme so native controls and scrollbars match', () => {
    assert.equal(LIGHT['color-scheme'], 'light');
    assert.equal(DARK['color-scheme'], 'dark');
  });

  const TEXT_ON = {
    // Body text and status text on the card, raised chips and fields.
    surfaces: ['--paper', '--paper-2', '--paper-field'],
    texts: ['--ink', '--ink-2', '--ink-3', '--red-ink', '--warn-ink', '--info-ink', '--code-key', '--code-type',
      '--code-fn', '--code-str', '--code-num'],
  };
  for (const [variant, tokens] of [['light', LIGHT], ['dark', DARK]]) {
    it(`meets WCAG AA (4.5:1) for text tokens in ${variant}`, () => {
      const low = [];
      for (const surface of TEXT_ON.surfaces) {
        for (const text of TEXT_ON.texts) {
          const ratio = contrast(color(tokens, text), color(tokens, surface));
          if (ratio < 4.5) low.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
        }
      }
      // Primary buttons: paper text on the red fill, also when hovered.
      for (const fill of ['--red-fill', '--red-fill-2']) {
        const ratio = contrast(color(tokens, '--paper'), color(tokens, fill));
        if (ratio < 4.5) low.push(`--paper on ${fill}: ${ratio.toFixed(2)}`);
      }
      // The code card (--on-slate-3 is for the card body only; the bar uses --on-slate).
      for (const surface of ['--slate', '--slate-2']) {
        for (const text of ['--on-slate', '--on-slate-2', '--syn-key', '--syn-type', '--syn-fn', '--syn-str',
          '--syn-num', '--syn-com', ...(surface === '--slate' ? ['--on-slate-3'] : [])]) {
          const ratio = contrast(color(tokens, text), color(tokens, surface));
          if (ratio < 4.5) low.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
        }
      }
      assert.deepEqual(low, []);
    });

    it(`keeps the red pencil marks at 3:1 on the card in ${variant}`, () => {
      assert.ok(contrast(color(tokens, '--red'), color(tokens, '--paper')) >= 3);
    });
  }

  it('keeps the code card distinct from the dark paper', () => {
    assert.notEqual(DARK['--slate'], DARK['--paper']);
    assert.ok(luminance(rgb(DARK['--slate'])) < luminance(rgb(DARK['--paper'])), 'code card is a darker well');
  });
});

describe('component CSS', () => {
  // Colors of the light variant written out instead of a token. The code
  // card is dark in both variants, so its own cream washes may stay.
  const LIGHT_ONLY = [/29,\s*27,\s*22/, /212,\s*64,\s*42/, /255,\s*255,\s*255/, /#1d1b16/i, /#f6f1e7/i, /%23f6f1e7/i,
    /#121317/i, /\bwhite\b(?!-space)/, /\bblack\b/];
  for (const file of COMPONENT_CSS) {
    it(`${file} uses theme tokens, not light-only colors`, () => {
      const css = readSource(`src/styles/${file}`).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const pattern of LIGHT_ONLY) {
        const line = css.split('\n').find((l) => pattern.test(l));
        assert.equal(line, undefined, `${file}: ${line && line.trim()}`);
      }
    });
  }

  // Inline styles built by the page scripts.
  for (const file of ['src/ui/main-window.js', 'src/ui/answer-page.js', 'src/ui/chat-page.js',
    'src/ui/settings-window.js', 'onboarding.js']) {
    it(`${file} sets no light-only colors in inline styles`, () => {
      const css = (readSource(file).match(/cssText\s*=\s*`[^`]*`/g) || []).join('\n');
      for (const pattern of LIGHT_ONLY.filter((p) => !/255/.test(p.source))) {
        const line = css.split('\n').find((l) => pattern.test(l));
        assert.equal(line, undefined, `${file}: ${line && line.trim()}`);
      }
    });
  }

  for (const page of PAGES) {
    it(`${page} loads theme.css`, () => {
      assert.match(readSource(page), /<link rel="stylesheet" href="\.\/src\/styles\/theme\.css"/);
    });
  }
});

describe('theme setting', () => {
  const THEMES = loadConstant('main.js', 'THEMES');
  const parseTheme = loadFunction('main.js', 'parseTheme', { THEMES });
  const nativeThemeSourceFor = loadFunction('main.js', 'nativeThemeSourceFor', { THEMES });

  it('offers Light, Dark and Match system, default Match system', () => {
    assert.deepEqual(THEMES, ['light', 'dark', 'system']);
    assert.equal(loadConstant('main.js', 'DEFAULT_THEME'), 'system');
    assert.deepEqual(loadConstant('src/managers/window.manager.js', 'THEMES'), THEMES);
    assert.equal(loadConstant('src/managers/window.manager.js', 'DEFAULT_THEME'), 'system');
  });

  it('parses saved values', () => {
    assert.equal(parseTheme('dark'), 'dark');
    assert.equal(parseTheme(' Light '), 'light');
    assert.equal(parseTheme('system'), 'system');
    for (const bad of ['', 'auto', 'sepia', '../dark', null, undefined, 3]) assert.equal(parseTheme(bad), null, String(bad));
  });

  it('maps each theme to the same nativeTheme.themeSource, unknown to system', () => {
    assert.equal(nativeThemeSourceFor('light'), 'light');
    assert.equal(nativeThemeSourceFor('dark'), 'dark');
    assert.equal(nativeThemeSourceFor('system'), 'system');
    assert.equal(nativeThemeSourceFor('sepia'), 'system');
    assert.equal(nativeThemeSourceFor(undefined), 'system');
  });

  it('uses each variant\'s --paper (onboarding: --paper-2) as the native window background', () => {
    const paper = loadConstant('src/managers/window.manager.js', 'PAPER_COLORS', { Object });
    assert.equal(paper.light, LIGHT['--paper']);
    assert.equal(paper.dark, DARK['--paper']);
    const raised = loadConstant('src/managers/window.manager.js', 'RAISED_PAPER_COLORS', { Object });
    assert.equal(raised.light, LIGHT['--paper-2']);
    assert.equal(raised.dark, DARK['--paper-2']);
    assert.match(readSource('src/styles/onboarding.css'), /\.wizard \{[^}]*background: var\(--paper-2\)/);
  });

  it('is a Settings field with every option', () => {
    const html = readSource('settings.html');
    const select = /<select[^>]*id="theme"[^>]*data-setting="theme"[^>]*>([\s\S]*?)<\/select>/.exec(html);
    assert.ok(select, 'no theme select in settings.html');
    const values = [...select[1].matchAll(/value="([^"]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(values, [...THEMES].sort());
  });
});
