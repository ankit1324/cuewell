// renderMarkdown(text): model markdown to an HTML string, using the vendored
// marked (load after ./node_modules/marked/lib/marked.umd.js). The result is
// not safe on its own: callers pass it through sanitizeHtml (lib/safe-html.js)
// before assigning it to innerHTML. Used by chat.html and llm-response.html.
(function () {
    'use strict';

    // Inline links and images, [text](url "title"). marked's own link rule
    // backtracks badly: many unclosed "[x](" or a long run of "(" after a
    // link take seconds to minutes. This rule stays linear: every part has
    // a length cap, the destination has no spaces (as in CommonMark) and at
    // most one level of balanced parentheses, and a title must follow
    // whitespace. <url> destinations and "title", 'title', (title) work.
    var SP = '[ \\t]{0,64}(?:\\n[ \\t]{0,64})?';        // optional spacing, one line break
    var SP1 = '(?:[ \\t]{1,64}(?:\\n[ \\t]{0,64})?|\\n[ \\t]{0,64})'; // required spacing
    var ESC = '\\\\[\\s\\S]';
    var LINK_RE = new RegExp(
        '^(!?)\\[' +
        // 1-2. label: text, escapes, `code` and one level of [brackets]
        '((?:\\[(?:' + ESC + '|[^\\[\\]\\\\]){0,500}\\]|' + ESC + '|`[^`]{0,500}`|[^\\[\\]\\\\`]){0,1000}?)' +
        '\\]\\(' + SP +
        // 3. destination: <...>, or text with balanced (...) one level deep
        '(<(?:' + ESC + '|[^<>\\n\\\\]){0,2048}>' +
        '|(?:[^\\s()\\\\]|' + ESC + '|\\((?:[^\\s()\\\\]|' + ESC + '){0,2048}\\)){0,2048})' +
        // 4. optional title
        '(?:' + SP1 + '("(?:' + ESC + '|[^"\\\\]){0,1000}"' +
        '|\'(?:' + ESC + '|[^\'\\\\]){0,1000}\'' +
        '|\\((?:' + ESC + '|[^()\\\\]){0,1000}\\)))?' +
        SP + '\\)'
    );
    var BACKSLASH_PUNCT = /\\([!-\/:-@\[-`{-~])/g;

    function linkTokenizer(src) {
        var cap = LINK_RE.exec(src);
        // undefined (not false) means "no link here" without falling back to
        // marked's own link rule.
        if (!cap) return undefined;
        var href = cap[3];
        if (href.charAt(0) === '<') href = href.slice(1, -1);
        var title = cap[4] ? cap[4].slice(1, -1).replace(BACKSLASH_PUNCT, '$1') : null;
        var text = cap[2].replace(/\\([\[\]])/g, '$1');
        var lexer = this.lexer;
        lexer.state.inLink = true;
        var token = {
            type: cap[1] === '!' ? 'image' : 'link',
            raw: cap[0],
            href: href.replace(BACKSLASH_PUNCT, '$1'),
            title: title,
            text: text,
            tokens: lexer.inlineTokens(text)
        };
        lexer.state.inLink = false;
        return token;
    }

    // marked's emphasis and strikethrough rules rescan the rest of a
    // paragraph for every *, _ or ~ that has no closer, so their cost grows
    // with delimiters x paragraph length (10,000 "#*a" take about 4 s).
    // Past this budget the answer is shown as plain text. Normal answers stay
    // far below it: a 2,000-char paragraph with 40 delimiters scores 80,000.
    var EMPHASIS_BUDGET = 5e6;
    var DELIMITER = /[*~]|(?:^|[^A-Za-z0-9])_/g;

    function emphasisCost(src) {
        var cost = 0;
        var blocks = src.split(/\n[ \t]*\n/);
        for (var i = 0; i < blocks.length; i++) {
            var delimiters = blocks[i].match(DELIMITER);
            if (delimiters) cost += delimiters.length * blocks[i].length;
        }
        return cost;
    }

    function escapeHtml(text) {
        return String(text == null ? '' : text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function plainText(text) {
        return escapeHtml(text).replace(/\n/g, '<br>');
    }

    var md = null;
    if (window.marked && typeof window.marked.Marked === 'function') {
        md = new window.marked.Marked({ gfm: true, breaks: false, async: false });
        md.use({
            tokenizer: {
                link: linkTokenizer,
                // No raw HTML, block or inline: it stays text, as with the old
                // markdown.js parser, so "vector<int>" keeps its "<int>" and a
                // "<details>" line does not swallow the markdown after it.
                // (marked's inline tag rule also flips a raw-text state on
                // <code>/<pre> that leaves later text unescaped.)
                html: function () { return undefined; },
                tag: function () { return undefined; }
            },
            renderer: {
                // Backstop in case an html token still appears.
                html: function (token) {
                    var text = escapeHtml(token.text);
                    return token.block ? '<p>' + text + '</p>\n' : text;
                },
                // marked puts unescaped alt text inside alt="...", so a quote
                // in it could add attributes.
                image: function (token) {
                    var alt = token.tokens ? this.parser.parseInline(token.tokens, this.parser.textRenderer) : token.text;
                    var out = '<img src="' + escapeHtml(token.href) + '" alt="' + escapeHtml(alt) + '"';
                    if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
                    return out + '>';
                },
                // Task list items keep their "[x]" / "[ ]" as text; the
                // sanitizer removes <input>.
                checkbox: function (token) {
                    return token.checked ? '[x]' : '[ ]';
                }
            }
        });
    } else {
        console.error('[markdown-render] marked unavailable; rendering answers as plain text');
    }

    window.renderMarkdown = function renderMarkdown(text) {
        var src = String(text == null ? '' : text);
        if (!src) return '';
        if (!md) return plainText(src);
        if (emphasisCost(src) > EMPHASIS_BUDGET) {
            console.warn('[markdown-render] answer too costly to format; showing plain text');
            return plainText(src);
        }
        try {
            return md.parse(src);
        } catch (error) {
            console.error('[markdown-render] markdown parsing failed:', error);
            return plainText(src);
        }
    };
})();
