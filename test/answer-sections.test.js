'use strict';
// Screen Help sections in the answer window (src/ui/answer-page.js) and chat
// (src/ui/chat-page.js). normalizeSectionHeadings turns the section labels a
// model writes ("### Steps", "**Dry run:**", "4) Complexity") into the
// "#### <Heading>" lines the pages style as section labels. It is a page
// script function, so its source is pulled out of each file; the copies are
// meant to stay in sync, so every case runs against each of them.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loadFunction, readSource } = require('./helpers/source');

const F = '```';
const PAGES = ['src/ui/answer-page.js', 'src/ui/chat-page.js'];
const IMPLEMENTATIONS = Object.fromEntries(PAGES.map((page) => [page, loadFunction(page, 'normalizeSectionHeadings')]));

// A Screen Help answer as a model writes it for a LeetCode-style screenshot.
const SCREEN_HELP_ANSWER = [
  'Use binary search on the rotated array: one half around mid is always sorted.',
  '',
  '#### Problem',
  'Given a sorted array rotated at an unknown pivot and a target, return its index or -1, in O(log n).',
  '',
  '#### Approach',
  'Binary search on a rotated array: the sorted half tells us which side can hold the target.',
  '- **Brute force:** scan every element, O(n).',
  '- **Optimal:** binary search, keep the half whose range contains the target, O(log n).',
  '',
  '#### Steps',
  '1. Set `lo = 0` and `hi = n - 1`.',
  '2. Take `mid`; if `nums[mid]` is the target, return `mid`.',
  '3. If the left half is sorted, move into it when the target is in its range.',
  '4. Otherwise do the same check on the right half.',
  '5. Return -1 when the range is empty.',
  '',
  '#### Dry run',
  '- `nums = [4,5,6,7,0,1,2]`, `target = 0`: `mid = 3` (7), left sorted, 0 not in [4,7], go right.',
  '- `lo = 4`, `mid = 5` (1), left half [0,1] sorted, 0 in range, go left; `mid = 4` is 0, return 4.',
  '',
  '#### Complexity',
  '- **Time:** O(log n), the range halves each step.',
  '- **Space:** O(1), only two indexes.',
  '',
  '#### Edge cases',
  '- One element, or no rotation at all.',
  '- Target absent.',
  '',
  `${F}cpp`,
  'int search(vector<int>& nums, int target) {',
  '    int lo = 0, hi = nums.size() - 1;',
  '    return -1;',
  '}',
  F,
].join('\n');

const CASES = [
  {
    name: 'keeps canonical "####" section headings as they are',
    input: 'Say it.\n\n#### Problem\nFind x.\n\n#### Steps\n1. a\n2. b',
    expected: 'Say it.\n\n#### Problem\nFind x.\n\n#### Steps\n1. a\n2. b',
  },
  {
    name: 'moves known section headings of other levels to "####"',
    input: '# Problem\nx\n## Approach\ny\n### Steps\nz\n##### Dry run\nw',
    expected: '#### Problem\nx\n#### Approach\ny\n#### Steps\nz\n#### Dry run\nw',
  },
  {
    name: 'turns a bold label on its own line into a heading',
    input: 'Say it.\n\n**Steps:**\n1. a\n\n__Dry run__\n- b\n\n**Edge cases**:\n- c',
    expected: 'Say it.\n\n#### Steps\n1. a\n\n#### Dry run\n- b\n\n#### Edge cases\n- c',
  },
  {
    name: 'drops the numbering in front of a label',
    input: '### 3. Steps\n1. a\n**4) Dry run**\n- b\n## Step 5: Complexity\n- c',
    expected: '#### Steps\n1. a\n#### Dry run\n- b\n#### Complexity\n- c',
  },
  {
    name: 'accepts closing hashes and spelling variants',
    input: '### Steps ###\n### Time and space complexity\n### Corner cases\n### Step-by-step\n### Dry-run',
    expected: '#### Steps\n#### Time and space complexity\n#### Corner cases\n#### Step-by-step\n#### Dry-run',
  },
  {
    name: 'knows the system design sections',
    input: '**Requirements**\n### High-level design\n## Components\n**Data model:**\n### Scaling\n### Tradeoffs\n### Trade-offs',
    expected: '#### Requirements\n#### High-level design\n#### Components\n#### Data model\n#### Scaling\n#### Tradeoffs\n#### Trade-offs',
  },
  {
    name: 'leaves other headings and bold lines alone',
    input: '### Why this matters\n**Note:**\n**Approach this with care because the input may be huge and unsorted.**',
    expected: '### Why this matters\n**Note:**\n**Approach this with care because the input may be huge and unsorted.**',
  },
  {
    name: 'leaves inline bold labels with text after them alone',
    input: '- **Time:** O(n)\n**Steps:** read, then write.',
    expected: '- **Time:** O(n)\n**Steps:** read, then write.',
  },
  {
    name: 'drops a "Say this" label: the card shows it already',
    input: '#### Say this\nUse a hash map.\n\n#### Steps\n1. a',
    expected: 'Use a hash map.\n\n#### Steps\n1. a',
  },
  {
    name: 'drops a "Say this:" prefix on the first line',
    input: '**Say this:** Use a hash map.\n\n#### Steps\n1. a',
    expected: 'Use a hash map.\n\n#### Steps\n1. a',
  },
  {
    name: 'keeps "say this" later in the answer',
    input: 'Use a map.\n\nSay this: then explain.',
    expected: 'Use a map.\n\nSay this: then explain.',
  },
  {
    name: 'drops a code heading: the code panel has its own',
    input: 'Use a map.\n\n#### Complexity\n- O(n)\n\n#### Code\n\n### Solution code\n**Code (C++)**\n### Code in Python',
    expected: 'Use a map.\n\n#### Complexity\n- O(n)\n\n',
  },
  {
    name: 'keeps headings that only start with "code"',
    input: '### Code review checklist',
    expected: '### Code review checklist',
  },
  {
    name: 'never touches lines inside a fence or indented code',
    input: `${F}\n### Steps\n**Dry run**\n${F}\n\n    ### Steps`,
    expected: `${F}\n### Steps\n**Dry run**\n${F}\n\n    ### Steps`,
  },
  {
    name: 'keeps a heading that is still streaming in',
    input: 'Use a map.\n\n#### Ste',
    expected: 'Use a map.\n\n#### Ste',
  },
  {
    name: 'handles CRLF line endings',
    input: 'Say it.\r\n\r\n**Steps**\r\n1. a',
    expected: 'Say it.\n\n#### Steps\n1. a',
  },
  {
    name: 'returns an empty string for empty input',
    input: null,
    expected: '',
  },
];

for (const [file, normalizeSectionHeadings] of Object.entries(IMPLEMENTATIONS)) {
  describe(`normalizeSectionHeadings in ${file}`, () => {
    for (const { name, input, expected } of CASES) {
      it(name, () => {
        assert.equal(normalizeSectionHeadings(input), expected);
      });
    }

    it('is idempotent', () => {
      for (const { input } of CASES) {
        const once = normalizeSectionHeadings(input);
        assert.equal(normalizeSectionHeadings(once), once, JSON.stringify(input));
      }
    });

    it('keeps the Screen Help answer the prompt asks for unchanged', () => {
      assert.equal(normalizeSectionHeadings(SCREEN_HELP_ANSWER), SCREEN_HELP_ANSWER);
    });
  });
}

describe('Screen Help answer rendering', () => {
  let renderMarkdown;
  before(() => {
    const context = { console: { log() {}, warn() {}, error() {} } };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(readSource('node_modules/marked/lib/marked.umd.js'), context);
    vm.runInContext(readSource('src/ui/markdown-render.js'), context);
    renderMarkdown = context.window.renderMarkdown;
  });

  for (const page of PAGES) {
    it(`renders each section as an h4 label in ${page}, with the code split out`, () => {
      const splitCodeBlocks = loadFunction(page, 'splitCodeBlocks');
      const normalize = IMPLEMENTATIONS[page];
      // Headings written as bold labels and h3s render the same as canonical ones.
      const loose = SCREEN_HELP_ANSWER.replace('#### Problem', '**Problem:**').replace('#### Steps', '### 4. Steps');
      for (const answer of [SCREEN_HELP_ANSWER, loose]) {
        const { text, blocks } = splitCodeBlocks(answer);
        assert.deepEqual(blocks.map((b) => b.language), ['cpp']);
        const html = renderMarkdown(normalize(text));
        const labels = [...html.matchAll(/<h4>([^<]+)<\/h4>/g)].map((m) => m[1]);
        assert.deepEqual(labels, ['Problem', 'Approach', 'Steps', 'Dry run', 'Complexity', 'Edge cases']);
        assert.match(html, /^<p>Use binary search on the rotated array/);
        assert.match(html, /<h4>Steps<\/h4>\n<ol>\n<li>Set <code>lo = 0<\/code>/);
        assert.doesNotMatch(html, /<h[1-3]>|<pre>/);
      }
    });
  }

  it('runs every answer through the normalizer before markdown in both pages', () => {
    const marked = (text) => `<md>${text}</md>`;
    const answer = loadFunction('src/ui/answer-page.js', 'renderAnswerMarkdown', {
      window: { renderMarkdown: marked },
      normalizeSectionHeadings: IMPLEMENTATIONS['src/ui/answer-page.js'],
      escapeHtml: String,
    });
    assert.equal(answer('Go.\n**Steps:**\n1. a'), '<md>Go.\n#### Steps\n1. a</md>');
    const chat = loadFunction('src/ui/chat-page.js', 'formatMarkdown', {
      window: { renderMarkdown: marked },
      normalizeSectionHeadings: IMPLEMENTATIONS['src/ui/chat-page.js'],
      escapeHtml: String,
      console,
    });
    assert.equal(chat('Go.\n**Steps:**\n1. a'), '<md>Go.\n#### Steps\n1. a</md>');
  });
});

// A coding Screen Help answer brings its code last. While a screenshot
// answer streams, the answer window opens the text + code layout early (from
// the first text in Coding mode, otherwise once a coding-only section
// shows), so the text does not re-wrap into the left panel when the code
// starts at the end.
describe('expectsCodePanel in src/ui/answer-page.js', () => {
  const normalize = IMPLEMENTATIONS['src/ui/answer-page.js'];
  const expectsCodePanel = loadFunction('src/ui/answer-page.js', 'expectsCodePanel', { normalizeSectionHeadings: normalize });

  it('expects code once a coding-only section shows', () => {
    assert.equal(expectsCodePanel('Use binary search.\n\n#### Problem\nFind it.\n\n#### Approach\nBinary'), true);
    assert.equal(expectsCodePanel('Use a map.\n\n**Dry run:**\n- `a`'), true);
    assert.equal(expectsCodePanel('Use a map.\n\n### 2. Approach\nx'), true);
    assert.equal(expectsCodePanel('Use a map.\n\n#### Time and space complexity\n- O(n)'), true);
    assert.equal(expectsCodePanel('Use a map.\n\n#### Edge cases\n- empty'), true);
  });

  it('does not expect code before then, or for other answers', () => {
    for (const prose of [
      '', null, 'Use binary search.', 'Use binary search.\n\n#### Problem\nFind it.',
      'Use a queue.\n\n#### Steps\n1. a', 'Use a cache.\n\n#### Components\n- x\n\n#### Trade-offs\n- y',
      'The approach is simple.', '#### Approaching deadlines', '**Approach:** use a map.',
    ]) {
      assert.equal(expectsCodePanel(prose), false, JSON.stringify(prose));
    }
  });

  it('opens the split layout early only while a screenshot answer streams, with a pending code card', () => {
    const source = readSource('src/ui/answer-page.js');
    assert.match(source, /const codePending = screen && !final && !hasCode && \(codingMode \|\| expectsCodePanel\(prose\)\);/);
    assert.match(source, /screen: stream\.source === 'screenshot',\s+codingMode: stream\.skill === 'dsa'/);
    assert.match(source, /class="code-block code-block--pending"/);
    assert.match(readSource('src/styles/answer.css'), /\.code-block--pending/);
  });
});

describe('Screen Help section labels in CSS', () => {
  it('styles top-level h4 headings as section labels in the answer card and chat', () => {
    assert.match(readSource('src/styles/answer.css'), /\.answer-body \.markdown-content > h4 \{/);
    assert.match(readSource('src/styles/chat.css'), /\.chat-messages \.message\.assistant \.message-text > h4 \{/);
  });
});
