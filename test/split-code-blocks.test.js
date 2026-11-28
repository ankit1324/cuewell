'use strict';
// splitCodeBlocks: splits a model answer into prose and code blocks for the
// chat and answer windows. The function is a page script, not a module, so
// its source is pulled out of each file and compiled on its own. The copies
// are meant to stay in sync, so every case runs against each of them.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { loadFunction } = require('./helpers/source');

const F = '```';
const IMPLEMENTATIONS = {
  'src/ui/chat-page.js': loadFunction('src/ui/chat-page.js', 'splitCodeBlocks'),
  'src/ui/answer-page.js': loadFunction('src/ui/answer-page.js', 'splitCodeBlocks'),
};

const CASES = [
  {
    name: 'separates prose and a code block',
    input: `Use a hash map.\n\n${F}python\nseen = {}\n${F}\n\nTime is O(n).`,
    expected: { text: 'Use a hash map.\n\nTime is O(n).', blocks: [{ language: 'python', code: 'seen = {}' }] },
  },
  {
    name: 'defaults the language to text',
    input: `${F}\nx\n${F}`,
    expected: { text: '', blocks: [{ language: 'text', code: 'x' }] },
  },
  {
    name: 'uses only the first word of the info string',
    input: `${F} python  title=a.py\nx\n${F}`,
    expected: { text: '', blocks: [{ language: 'python', code: 'x' }] },
  },
  {
    name: 'reads tilde fences',
    input: '~~~cpp\nint a;\n~~~',
    expected: { text: '', blocks: [{ language: 'cpp', code: 'int a;' }] },
  },
  {
    name: 'keeps inline triple backticks in the prose',
    input: `Call ${F}solve()${F} once.`,
    expected: { text: `Call ${F}solve()${F} once.`, blocks: [] },
  },
  {
    name: 'runs an unclosed fence to the end',
    input: `Intro\n${F}js\nlet a;\nlet b;`,
    expected: { text: 'Intro', blocks: [{ language: 'js', code: 'let a;\nlet b;' }] },
  },
  {
    name: 'only closes on a fence of the same kind and at least the same length',
    input: `${F}\`\n${F}js\ninner\n${F}\n~~~\n${F}\``,
    expected: { text: '', blocks: [{ language: 'text', code: `${F}js\ninner\n${F}\n~~~` }] },
  },
  {
    name: 'leaves no stray language word when the closer repeats the tag',
    input: `Answer:\n${F}python\nx = 1\n${F}python\nDone.`,
    expected: { text: 'Answer:\n\nDone.', blocks: [{ language: 'python', code: 'x = 1' }] },
  },
  {
    name: 'handles CRLF line endings',
    input: `a\r\n${F}c\r\nint x;\r\n${F}\r\nb`,
    expected: { text: 'a\n\nb', blocks: [{ language: 'c', code: 'int x;' }] },
  },
  {
    name: 'drops the fence indentation but keeps the code indentation',
    input: `- one\n  ${F}py\n  x = 1\n    y\n  ${F}\n- two`,
    expected: { text: '- one\n- two', blocks: [{ language: 'py', code: 'x = 1\n  y' }] },
  },
  {
    name: 'drops an empty block and keeps the paragraphs apart',
    input: `p\n${F}js\n\n\n${F}\nq`,
    expected: { text: 'p\n\nq', blocks: [] },
  },
  {
    name: 'trims blank lines inside a block',
    input: `${F}js\n\n  x\n\n${F}`,
    expected: { text: '', blocks: [{ language: 'js', code: '  x' }] },
  },
  {
    name: 'keeps several blocks in order',
    input: `A\n${F}c\none\n${F}\nB\n~~~java\ntwo\n~~~\nC`,
    expected: {
      text: 'A\n\nB\n\nC',
      blocks: [{ language: 'c', code: 'one' }, { language: 'java', code: 'two' }],
    },
  },
  {
    name: 'returns empty results for empty input',
    input: null,
    expected: { text: '', blocks: [] },
  },
  {
    name: 'leaves prose without code unchanged',
    input: 'Line one.\n\nLine two with `code`.',
    expected: { text: 'Line one.\n\nLine two with `code`.', blocks: [] },
  },
];

for (const [file, splitCodeBlocks] of Object.entries(IMPLEMENTATIONS)) {
  describe(`splitCodeBlocks in ${file}`, () => {
    for (const { name, input, expected } of CASES) {
      it(name, () => {
        assert.deepEqual(splitCodeBlocks(input), expected);
      });
    }

    it('never leaves a fence line or its language in the prose', () => {
      for (const language of ['python', 'cpp', 'javascript', 'java']) {
        const { text } = splitCodeBlocks(`Say this.\n\n${F}${language}\ncode()\n${F}\n\nThen this.`);
        assert.doesNotMatch(text, /```|~~~/);
        assert.ok(!text.includes(language), `"${language}" left in ${JSON.stringify(text)}`);
      }
    });
  });
}
