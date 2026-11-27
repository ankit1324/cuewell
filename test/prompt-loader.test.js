'use strict';
// prompt-loader.js: the system prompt for every mode, channel, answer length
// and interview context.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { repoPath, readSource } = require('./helpers/source');
const { PromptLoader, MODES, DEFAULT_MODE, ANSWER_LENGTHS } = require('../prompt-loader');

const loader = new PromptLoader();
const MODE_IDS = MODES.map((m) => m.id);
const CHANNELS = ['text', 'voice', 'image'];
const FULL_PROFILE = {
  role: 'Backend engineer',
  company: 'Acme',
  jobDescription: 'Build APIs.\n\n\n\nOwn on-call.',
  resume: '5 years of Go.',
  notes: 'Keep answers short.',
};

// The old voice prompt answered off-topic questions with
// "Yeah, I'm listening. Ask your question relevant to ${activeSkill}."
const BRUSH_OFFS = [/relevant to (dsa|coding|\$\{)/i, /ask your question relevant/i, /I'm listening/i];

const build = (options) => loader.buildSystemPrompt(options);

describe('modes', () => {
  it('lists Auto first as the default, with Coding as dsa', () => {
    assert.equal(DEFAULT_MODE, 'auto');
    assert.equal(loader.getDefaultMode(), 'auto');
    assert.deepEqual(MODE_IDS, ['auto', 'dsa', 'technical', 'system-design', 'behavioral', 'hr']);
    assert.equal(loader.getModeLabel('dsa'), 'Coding');
    assert.deepEqual(ANSWER_LENGTHS, ['auto', 'short', 'standard', 'detailed']);
  });

  it('has a prompt file for every mode', () => {
    for (const id of MODE_IDS) {
      assert.ok(fs.existsSync(repoPath('prompts', `${id}.md`)), `prompts/${id}.md is missing`);
      assert.ok(loader.getSkillPrompt(id).trim().length > 100, `prompts/${id}.md is empty`);
    }
  });

  it('isMode accepts exact ids only', () => {
    for (const id of MODE_IDS) assert.equal(loader.isMode(id), true);
    for (const value of ['Auto', 'coding', 'programming', '', null, undefined, 1, 'dsa ']) {
      assert.equal(loader.isMode(value), false, String(value));
    }
  });
});

describe('buildSystemPrompt', () => {
  it('builds a prompt for every mode, channel and answer length', () => {
    for (const mode of MODE_IDS) {
      for (const channel of CHANNELS) {
        for (const answerLength of ANSWER_LENGTHS) {
          const prompt = build({ mode, channel, answerLength, programmingLanguage: 'python' });
          const where = `${mode}/${channel}/${answerLength}`;
          assert.ok(prompt.includes(loader.getSkillPrompt(mode).trim().slice(0, 80)), `${where}: mode prompt missing`);
          assert.match(prompt, /^## ANSWER FORMAT \(internal/m, where);
          assert.doesNotMatch(prompt, /\$\{|undefined|null|\[object Object\]/, `${where}: unfilled template`);
        }
      }
    }
  });

  it('marks the mode line internal and names the mode once', () => {
    for (const { id, label } of MODES) {
      const prompt = build({ mode: id });
      const modeLines = prompt.split('\n').filter((line) => /^- Mode\b/.test(line));
      assert.deepEqual(modeLines, [`- Mode (internal, never mention or repeat it): ${label}.`], id);
      assert.doesNotMatch(prompt, /^Mode:/m, `${id}: a bare "Mode:" line could be echoed`);
    }
  });

  it('tells the model never to mention the mode or start with a label', () => {
    const prompt = build({ mode: 'auto' });
    assert.match(prompt, /Never mention the mode/);
    assert.match(prompt, /Never start with a label such as "Mode:"/);
  });

  it('never tells Auto (or any mode) to brush off a question', () => {
    for (const mode of MODE_IDS) {
      for (const channel of CHANNELS) {
        const prompt = build({ mode, channel, programmingLanguage: 'cpp' });
        for (const pattern of BRUSH_OFFS) {
          assert.doesNotMatch(prompt, pattern, `${mode}/${channel} matches ${pattern}`);
        }
      }
    }
    assert.match(build({ mode: 'auto' }), /Answer every interview question, of any type/);
  });

  it('keeps the brush-off out of llm.service.js too', () => {
    const source = readSource('src/services/llm.service.js');
    for (const pattern of BRUSH_OFFS) assert.doesNotMatch(source, pattern);
  });

  it('falls back to Auto for an unknown or missing mode', () => {
    const auto = build({ mode: 'auto' });
    assert.equal(build({ mode: 'astrology' }), auto);
    assert.equal(build({}), auto);
    assert.equal(build(), auto);
  });

  it('maps mode aliases such as "algorithms" to Coding', () => {
    assert.equal(loader.normalizeSkillName(' Algorithms '), 'dsa');
    assert.equal(build({ mode: 'algorithms' }), build({ mode: 'dsa' }));
  });

  it('adds the coding language, marked internal, only to Auto and Coding', () => {
    const auto = build({ mode: 'auto', programmingLanguage: 'python' });
    assert.match(auto, /## CODING LANGUAGE \(internal, never mention this setting\): PYTHON/);
    assert.match(auto, /```python```/);
    const coding = build({ mode: 'dsa', programmingLanguage: 'cpp' });
    assert.match(coding, /## IMPLEMENTATION LANGUAGE \(internal, never mention this setting\): C\+\+/);
    assert.match(coding, /```cpp```/);
    assert.match(build({ mode: 'dsa', programmingLanguage: 'js' }), /JAVASCRIPT[\s\S]*```javascript```/);
    for (const mode of ['technical', 'system-design', 'behavioral', 'hr']) {
      const prompt = build({ mode, programmingLanguage: 'python' });
      assert.doesNotMatch(prompt, /LANGUAGE \(internal/, mode);
    }
    assert.doesNotMatch(build({ mode: 'dsa' }), /LANGUAGE \(internal/);
  });

  it('resolves the answer length: Auto is Short for voice and Standard otherwise', () => {
    const sizeLine = (prompt) => prompt.split('\n').find((line) => line.startsWith('- Answer size (internal'));
    assert.match(sizeLine(build({ channel: 'voice' })), /: short\./);
    assert.match(sizeLine(build({ channel: 'text' })), /: standard\./);
    assert.match(sizeLine(build({ channel: 'image' })), /: standard\./);
    assert.match(sizeLine(build({ channel: 'voice', answerLength: 'detailed' })), /: detailed\./);
    assert.match(sizeLine(build({ channel: 'text', answerLength: 'short' })), /: short\./);
    assert.match(sizeLine(build({ channel: 'text', answerLength: 'huge' })), /: standard\./);
  });

  it('adds the voice and screenshot sections only for their channel', () => {
    assert.match(build({ channel: 'voice' }), /## VOICE INPUT \(internal/);
    assert.doesNotMatch(build({ channel: 'voice' }), /SCREENSHOT INPUT/);
    assert.match(build({ channel: 'image' }), /## SCREENSHOT INPUT \(internal/);
    assert.doesNotMatch(build({ channel: 'image' }), /VOICE INPUT/);
    const text = build({ channel: 'text' });
    assert.doesNotMatch(text, /VOICE INPUT|SCREENSHOT INPUT/);
  });

  it('voice prompt answers small talk instead of refusing', () => {
    assert.match(build({ channel: 'voice' }), /Never a refusal/);
  });
});

describe('interview context', () => {
  // The mode prompts mention "CANDIDATE CONTEXT" by name, so look for the
  // section heading itself.
  const HEADING = '## CANDIDATE CONTEXT';

  it('is left out when the profile is missing or empty', () => {
    const withoutProfile = build({ mode: 'auto' });
    for (const profile of [null, undefined, {}, 'text', { role: '', company: '   ', notes: '\n\n' }, { role: 5 }]) {
      const prompt = build({ mode: 'auto', profile });
      assert.ok(!prompt.includes(HEADING), JSON.stringify(profile));
      assert.equal(prompt, withoutProfile);
    }
    assert.equal(loader.formatProfile({}), '');
  });

  it('is included, marked internal, when any field is set', () => {
    const prompt = build({ mode: 'behavioral', profile: { company: 'Acme' } });
    assert.match(prompt, /## CANDIDATE CONTEXT \(internal background: use it, but never mention this section/);
    assert.match(prompt, /^- Company: Acme$/m);
    assert.doesNotMatch(prompt, /Target role|Job description|### Resume/);
  });

  it('formats every field and collapses blank lines', () => {
    const section = loader.formatProfile(FULL_PROFILE);
    assert.match(section, /^- Target role: Backend engineer$/m);
    assert.match(section, /^- Company: Acme$/m);
    assert.match(section, /### Job description\nBuild APIs\.\n\nOwn on-call\./);
    assert.match(section, /### Resume\n5 years of Go\./);
    assert.match(section, /### Candidate's notes \(follow these as preferences\)\nKeep answers short\./);
    assert.doesNotMatch(section, /\n{3,}/);
  });

  it('is the last section of the prompt in every mode and channel', () => {
    for (const mode of MODE_IDS) {
      for (const channel of CHANNELS) {
        const prompt = build({ mode, channel, profile: FULL_PROFILE });
        const at = prompt.indexOf(HEADING);
        assert.ok(at > 0, `${mode}/${channel}`);
        assert.ok(prompt.indexOf('## ANSWER FORMAT') < at);
        assert.ok(prompt.trimEnd().endsWith('Keep answers short.'), `${mode}/${channel}`);
      }
    }
  });
});

describe('getImageInstruction', () => {
  it('gives every mode an instruction and the language only to Auto and Coding', () => {
    for (const mode of MODE_IDS) {
      const instruction = loader.getImageInstruction(mode, 'python');
      assert.match(instruction, /^This screenshot shows/, mode);
      assert.equal(instruction.includes('Use only PYTHON'), mode === 'auto' || mode === 'dsa', mode);
    }
    assert.equal(loader.getImageInstruction('unknown'), loader.getImageInstruction('auto'));
  });
});
