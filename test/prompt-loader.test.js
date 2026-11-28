'use strict';
// prompt-loader.js: the system prompt for every mode, channel, answer length,
// About you details, answer style and interview context.
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

const ABOUT_PROFILE = {
  fullName: 'Priya Sharma',
  preferredName: 'Priya',
  currentTitle: 'SDE 2',
  currentCompany: 'Globex',
  yearsExperience: '4.5',
  skills: 'Go, Kafka, PostgreSQL',
  achievements: '- Cut checkout latency 40%\n\n\n- Led the Kubernetes move',
  education: 'B.Tech CSE, NIT Trichy, 2019\nM.Tech, IIT Delhi, 2021',
  location: 'Pune',
  relocation: 'maybe',
  noticePeriod: '30 days',
  expectedSalary: '18-22 LPA',
  languages: 'English, Hindi',
  tone: 'confident',
  answerLanguage: 'Hindi',
};
const EMPTY_ABOUT = Object.fromEntries(Object.keys(ABOUT_PROFILE).map((key) => [key, '']));

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
    const blanks = [null, undefined, {}, 'text', { role: '', company: '   ', notes: '\n\n' }, { role: 5 }, EMPTY_ABOUT,
      { fullName: '  ', achievements: '\n\n', yearsExperience: 'lots', relocation: 'sometimes', tone: 'loud' },
      { yearsExperience: '61' }, { relocation: 'constructor', tone: '__proto__' }, { answerLanguage: 'English' },
      { answerLanguage: ' english ' }, { yearsExperience: 5.25 }];
    for (const profile of blanks) {
      const prompt = build({ mode: 'auto', profile });
      assert.ok(!prompt.includes(HEADING), JSON.stringify(profile));
      assert.equal(prompt, withoutProfile);
    }
    assert.equal(loader.formatProfile({}), '');
    assert.equal(loader.formatAnswerStyle({}), '');
    assert.doesNotMatch(build({ mode: 'auto', profile: EMPTY_ABOUT }), /ANSWER STYLE/);
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

  it('comes after the answer format, followed only by the answer style, in every mode and channel', () => {
    for (const profile of [FULL_PROFILE, { ...FULL_PROFILE, ...ABOUT_PROFILE }]) {
      for (const mode of MODE_IDS) {
        for (const channel of CHANNELS) {
          const where = `${mode}/${channel}`;
          const prompt = build({ mode, channel, profile, programmingLanguage: 'python' });
          const at = prompt.indexOf(HEADING);
          assert.ok(at > 0, where);
          assert.ok(prompt.indexOf('## ANSWER FORMAT') < at, where);
          assert.ok(prompt.indexOf('Keep answers short.') > at, where);
          const style = prompt.indexOf('## ANSWER STYLE');
          if (profile === FULL_PROFILE) {
            assert.equal(style, -1, where);
            assert.match(prompt.slice(at), /### How to use it\n(- .+\n?)+$/, where);
          } else {
            assert.ok(style > at, where);
            assert.ok(prompt.trimEnd().endsWith('as they are usually written.'), where);
          }
          assert.doesNotMatch(prompt, /\$\{|undefined|null|\[object Object\]|NaN/, where);
        }
      }
    }
  });

  it('tells the model to use real details instead of placeholders, and never invent', () => {
    for (const profile of [{ company: 'Acme' }, { fullName: 'Priya' }, ABOUT_PROFILE]) {
      const section = loader.formatProfile(profile);
      assert.match(section, /using these real details instead of placeholders/);
      assert.match(section, /\[placeholder\] only where a detail the answer needs is truly missing/);
      assert.match(section, /Never invent employers, titles, numbers, dates or degrees/);
      assert.match(section, /in the first person/);
    }
  });
});

describe('About you in the prompt', () => {
  const section = loader.formatProfile(ABOUT_PROFILE);

  it('lists every filled field compactly', () => {
    assert.match(section, /^### About the candidate$/m);
    assert.match(section, /^- Name: Priya Sharma \(preferred name: Priya\)$/m);
    assert.match(section, /^- Current job: SDE 2 at Globex$/m);
    assert.match(section, /^- Total experience: 4\.5 years$/m);
    assert.match(section, /^- Key skills: Go, Kafka, PostgreSQL$/m);
    assert.match(section, /^- Education: B\.Tech CSE, NIT Trichy, 2019; M\.Tech, IIT Delhi, 2021$/m);
    assert.match(section, /^- Location: Pune$/m);
    assert.match(section, /^- Open to relocation: maybe, open to discussing it$/m);
    assert.match(section, /^- Notice period: 30 days$/m);
    assert.match(section, /^- Expected salary: 18-22 LPA$/m);
    assert.match(section, /^- Languages spoken: English, Hindi$/m);
    assert.match(section, /### Notable projects and achievements\n- Cut checkout latency 40%\n- Led the Kubernetes move/);
    assert.doesNotMatch(section, /\n{3,}/);
    // Tone and language are instructions, not background.
    assert.doesNotMatch(section, /confident|Tone|write every answer/);
  });

  it('includes only the fields that are filled', () => {
    const only = loader.formatProfile({ ...EMPTY_ABOUT, currentTitle: 'SDE 2' });
    assert.match(only, /^- Current title: SDE 2$/m);
    assert.doesNotMatch(only, /Name:|Current job|Total experience|Key skills|Education|Location|relocation|Notice period|Expected salary|Languages spoken|### Notable projects/);
    assert.match(loader.formatProfile({ currentCompany: 'Globex' }), /^- Current company: Globex$/m);
    assert.match(loader.formatProfile({ preferredName: 'Priya' }), /^- Name: Priya$/m);
    assert.match(loader.formatProfile({ fullName: 'Priya', preferredName: 'priya' }), /^- Name: Priya$/m);
    assert.match(loader.formatProfile({ relocation: 'no' }), /^- Open to relocation: no$/m);
  });

  it('writes years of experience as a number of years', () => {
    const years = (value) => (loader.formatProfile({ yearsExperience: value }).match(/^- Total experience: (.+)$/m) || [])[1];
    assert.equal(years('0'), '0 years');
    assert.equal(years('1'), '1 year');
    assert.equal(years('12'), '12 years');
    assert.equal(years(3), '3 years');
    for (const bad of ['', '61', '-1', 'five', '5 years', null, true]) assert.equal(years(bad), undefined, String(bad));
  });

  it('adds the salary, relocation and notice rules only when those fields are set', () => {
    assert.match(section, /For salary or compensation questions, give the expected salary above/);
    assert.match(section, /For location or relocation questions, answer from the location and relocation details above/);
    assert.match(section, /For notice period, availability or start date questions, use the notice period above/);
    const bare = loader.formatProfile({ company: 'Acme' });
    assert.doesNotMatch(bare, /salary|relocation|notice period/i);
    assert.match(loader.formatProfile({ relocation: 'yes' }), /relocation questions/);
  });

  it('uses the preferred name only where natural', () => {
    assert.match(section, /Use the name Priya only where it is natural/);
    assert.match(loader.formatProfile({ fullName: 'Priya Sharma' }), /Use the name Priya Sharma only/);
    assert.doesNotMatch(loader.formatProfile({ company: 'Acme' }), /Use the name/);
  });

  it('puts About you before the interview context', () => {
    const both = loader.formatProfile({ ...FULL_PROFILE, ...ABOUT_PROFILE });
    const order = ['### About the candidate', '### Notable projects', '### The interview', '- Target role: Backend engineer',
      '### Job description', '### Resume', "### Candidate's notes", '### How to use it'];
    const positions = order.map((heading) => both.indexOf(heading));
    assert.ok(positions.every((at) => at >= 0), JSON.stringify(positions));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  });

  it('keeps single-line fields on one line in the prompt', () => {
    const section2 = loader.formatProfile({ fullName: 'Priya\n\nSharma', skills: 'Go,\r\nKafka', role: 'SWE\nII' });
    assert.match(section2, /^- Name: Priya; Sharma$/m);
    assert.match(section2, /^- Key skills: Go,; Kafka$/m);
    assert.match(section2, /^- Target role: SWE; II$/m);
  });
});

describe('answer style', () => {
  it('sets the tone', () => {
    const rules = {
      confident: /Tone: confident\. Sound assured and direct/,
      friendly: /Tone: friendly\. Sound warm and conversational/,
      formal: /Tone: formal\. Sound polished and professional/,
      concise: /Tone: concise\. Use the fewest words/,
    };
    for (const [tone, pattern] of Object.entries(rules)) {
      const style = loader.formatAnswerStyle({ tone });
      assert.match(style, /^## ANSWER STYLE \(internal, never mention it\)\n/);
      assert.match(style, pattern);
      assert.doesNotMatch(style, /Language:/);
    }
  });

  it('sets the answer language, with English as the default that adds nothing', () => {
    const style = loader.formatAnswerStyle({ answerLanguage: '  Hindi  ' });
    assert.match(style, /- Language: write every answer in Hindi, including the first line/);
    assert.match(style, /Keep code, identifiers and standard technical terms as they are usually written\./);
    assert.doesNotMatch(style, /Tone:/);
    for (const english of ['', 'English', 'ENGLISH', ' english ']) {
      assert.equal(loader.formatAnswerStyle({ answerLanguage: english }), '', english);
    }
  });

  it('answers in Hinglish written only in Roman script', () => {
    for (const value of ['Hinglish (Roman script)', 'hinglish', '  HINGLISH  ', 'Hinglish (Roman)']) {
      const style = loader.formatAnswerStyle({ answerLanguage: value });
      assert.match(style, /^## ANSWER STYLE \(internal, never mention it\)\n/, value);
      assert.match(style, /- Language: write every answer in natural Hinglish, the mix of Hindi and English/, value);
      assert.match(style, /including the first line/, value);
      assert.match(style, /only in Roman \(Latin\) script, never in Devanagari/, value);
      assert.match(style, /Time complexity O\(n log n\) hai\./, value);
      assert.match(style, /Keep technical terms, names, identifiers and complexity notation such as O\(n log n\) in English\./, value);
      assert.match(style, /Code blocks stay exactly as they would in an English answer, comments included\./, value);
      // Never the generic rule, which would ask for "Hinglish" with no script.
      assert.doesNotMatch(style, /write every answer in Hinglish/i, value);
      // The prompt itself is plain ASCII: no Devanagari slips into it.
      assert.doesNotMatch(style, /[\u0900-\u097F]/, value);
    }
  });

  it('keeps other languages that only mention Hindi on the generic rule', () => {
    for (const value of ['Hindi', 'Hindi and English', 'Roman Urdu']) {
      const style = loader.formatAnswerStyle({ answerLanguage: value });
      assert.match(style, new RegExp(`- Language: write every answer in ${value}, including the first line`), value);
      assert.doesNotMatch(style, /Devanagari/, value);
    }
  });

  it('puts the Hinglish rule in the system prompt for every mode and channel', () => {
    for (const mode of MODE_IDS) {
      for (const channel of CHANNELS) {
        const prompt = build({ mode, channel, profile: { answerLanguage: 'Hinglish (Roman script)', tone: 'friendly' } });
        assert.match(prompt, /Tone: friendly\./, `${mode}/${channel}`);
        assert.match(prompt, /natural Hinglish/, `${mode}/${channel}`);
        assert.match(prompt, /never in Devanagari/, `${mode}/${channel}`);
      }
    }
  });

  it('ignores unknown tones and values that are not text', () => {
    for (const profile of [{ tone: 'loud' }, { tone: 'constructor' }, { tone: 1 }, { answerLanguage: 5 }, null, 'x']) {
      assert.equal(loader.formatAnswerStyle(profile), '', JSON.stringify(profile));
    }
  });

  it('is the last section in every mode and channel', () => {
    for (const mode of MODE_IDS) {
      for (const channel of CHANNELS) {
        const prompt = build({ mode, channel, profile: { tone: 'formal' } });
        assert.ok(prompt.trimEnd().endsWith('no slang or casual phrases.'), `${mode}/${channel}`);
        // A style with no background adds no candidate context.
        assert.ok(!prompt.includes('## CANDIDATE CONTEXT'), `${mode}/${channel}`);
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
