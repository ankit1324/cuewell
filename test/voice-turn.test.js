'use strict';
// src/core/voice-turn.js: when a spoken question has ended (how finished
// the transcript looks, and the "Pause before answering" setting), and
// whether a voice utterance may replace the answer on screen.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  VOICE_PAUSES, DEFAULT_VOICE_PAUSE, PAUSE_PROFILES, MERGE_WINDOW_MS,
  parseVoicePause, looksLikeQuestion, transcriptEnding, endOfQuestionDelayMs, decideVoiceUtterance,
} = require('../src/core/voice-turn');

describe('parseVoicePause', () => {
  it('accepts short, normal and long in any case, and nothing else', () => {
    assert.deepEqual(VOICE_PAUSES, ['short', 'normal', 'long']);
    assert.equal(DEFAULT_VOICE_PAUSE, 'normal');
    assert.equal(parseVoicePause('short'), 'short');
    assert.equal(parseVoicePause(' LONG '), 'long');
    for (const bad of ['', 'forever', '5000', '../long', null, undefined, 3, {}, ['long']]) {
      assert.equal(parseVoicePause(bad), null, String(bad));
    }
  });
});

describe('transcriptEnding', () => {
  const cases = {
    complete: [
      'What is the difference between a process and a thread?',
      'Can you walk me through your resume?',
      'Tell me about yourself.',
      'Explain how a hash map handles collisions.',
      'Why do you think so?',
      'What would that look like?',
      'Who did you report to?',
      'Aap React mein hooks kaise use karte ho?',
      'Kya aap apne last project ke baare mein bata sakte hain.',
      'आप अपने प्रोजेक्ट के बारे में बताइए।',
    ],
    open: [
      'I worked at Acme for three years.',
      'That is a good point!',
      'Okay, that sounds good.',
    ],
    unfinished: [
      // No ending punctuation.
      'What is the difference between a process and a thread',
      // Conjunctions and hesitation, even with a full stop or question mark.
      'What is the difference between a process and',
      'What is the difference between a process and.',
      'How would you scale it, um',
      'Tell me about a time when you disagreed with your manager, and?',
      'So the question is, uh.',
      // Articles, prepositions and hanging pairs.
      'Can you explain the',
      'What is the time complexity of.',
      'You have an array of integers, you know',
      // A trailing comma, ellipsis or dash.
      'Design a URL shortener,',
      'Think about a system that...',
      'So imagine a cache —',
      // Hinglish and Hindi fillers.
      'Aapka last project kya tha matlab',
      'Toh aap React mein state kaise manage karte ho, aur',
      'Kya aap explain kar sakte ho toh',
      'Is problem ko solve karne ke liye aap kya karoge ya',
      'आप अपने प्रोजेक्ट के बारे में और',
      'मतलब आप क्या करेंगे तो',
      '',
    ],
  };
  for (const [ending, texts] of Object.entries(cases)) {
    for (const text of texts) {
      it(`${ending}: ${JSON.stringify(text)}`, () => assert.equal(transcriptEnding(text), ending));
    }
  }
});

describe('endOfQuestionDelayMs', () => {
  const unfinished = 'What is the difference between a process and';
  const complete = 'What is the difference between a process and a thread?';
  const open = 'I worked at Acme for three years.';

  it('waits longer for an unfinished transcript than an open one, and longest for each setting', () => {
    for (const pause of VOICE_PAUSES) {
      const times = [complete, open, unfinished].map((text) => endOfQuestionDelayMs(text, pause));
      assert.ok(times[0] < times[1] && times[1] < times[2], `${pause}: ${times}`);
      assert.deepEqual(times, [PAUSE_PROFILES[pause].complete, PAUSE_PROFILES[pause].open, PAUSE_PROFILES[pause].unfinished]);
    }
  });

  it('waits longer with each setting from Short to Long', () => {
    for (const text of [complete, open, unfinished]) {
      const [short, normal, long] = VOICE_PAUSES.map((pause) => endOfQuestionDelayMs(text, pause));
      assert.ok(short < normal && normal < long, `${text}: ${short} ${normal} ${long}`);
    }
  });

  it('outlasts a 3 second thinking pause by default when the question is unfinished', () => {
    assert.ok(endOfQuestionDelayMs(unfinished) > 4000);
    assert.ok(endOfQuestionDelayMs('Aap React mein state kaise manage karte ho, matlab') > 4000);
    // Short still waits 3 s, a bit more than the old fixed 2 s.
    assert.ok(endOfQuestionDelayMs(unfinished, 'short') >= 3000);
  });

  it('answers a clear question no slower than before on Normal (about 2.5 s after the last word)', () => {
    assert.equal(endOfQuestionDelayMs(complete), 2500);
  });

  it('uses Normal for an unknown setting', () => {
    for (const bad of ['forever', '', undefined, null]) {
      assert.equal(endOfQuestionDelayMs(unfinished, bad), PAUSE_PROFILES.normal.unfinished, String(bad));
    }
  });
});

describe('looksLikeQuestion', () => {
  it('finds questions and requests in English, Hinglish and Hindi', () => {
    for (const text of [
      'What is a mutex', 'Okay so how would you design it', 'Tell me about your last project.',
      'Walk me through your resume', 'Design a URL shortener.', 'Given an array, find two numbers that sum to k.',
      "Let's say the traffic doubles. What changes", 'React mein hooks kaise kaam karte hain',
      'Apne baare mein batao', 'आप क्या करेंगे', 'Is that clear?',
    ]) {
      assert.equal(looksLikeQuestion(text), true, text);
    }
  });

  it('does not take statements for questions', () => {
    for (const text of ['So basically a hash map stores key value pairs.', 'I worked at Acme.', 'Okay.', 'umm let me think', '']) {
      assert.equal(looksLikeQuestion(text), false, text);
    }
  });
});

describe('decideVoiceUtterance', () => {
  const now = 1_000_000;
  const decide = (text, extra = {}) => decideVoiceUtterance({ text, now, onScreen: true, previous: null, ...extra });

  it('answers anything when no answer is on screen', () => {
    for (const text of ['umm let me think', 'So basically I would use a hash map', 'Why?']) {
      assert.deepEqual(decideVoiceUtterance({ text, now, onScreen: false }),
        { action: 'answer', reason: 'nothing-on-screen', question: text });
    }
  });

  it('ignores hesitation and acknowledgements while an answer is on screen', () => {
    for (const text of ['Umm.', 'Okay, got it.', 'Hmm, hmm.', 'Haan accha.', 'Theek hai.', 'Right, right.', 'हाँ ठीक है']) {
      assert.deepEqual(decide(text), { action: 'ignore', reason: 'filler', question: '' }, text);
    }
  });

  it('ignores the user thinking aloud or starting to answer', () => {
    for (const text of [
      'Umm, let me think.',
      'Let me think about this for a second.',
      'So I would probably use a hash map here.',
      "I think the answer is O of n log n, right?",
      "I'd start with a brute force solution.",
      'Matlab mujhe lagta hai ki hash map use karna chahiye.',
      'Main pehle array ko sort karunga.',
      'मुझे लगता है कि यह सही है',
    ]) {
      assert.deepEqual(decide(text), { action: 'ignore', reason: 'self-talk', question: '' }, text);
    }
  });

  it('ignores speech that is not a question, such as reading the answer aloud', () => {
    for (const text of ['So basically a hash map stores key value pairs.', 'The time complexity is linear.', 'Yeah that makes sense to the team.']) {
      assert.equal(decide(text).action, 'ignore', text);
      assert.equal(decide(text).reason, 'not-a-question', text);
    }
  });

  it('ignores questions too short to be a new one', () => {
    for (const text of ['Why?', 'And then?', 'How come']) {
      assert.deepEqual(decide(text), { action: 'ignore', reason: 'too-short', question: '' }, text);
    }
  });

  it('replaces the answer with a substantial new question from the interviewer', () => {
    for (const text of [
      'Why this company?',
      'Tell me about a time you disagreed with your manager.',
      'Okay, now can you design a rate limiter?',
      'Walk me through your resume',
      'Give me an example.',
      'Aap apne last project ke baare mein batao',
      'Can I ask you about your notice period?',
      'आप अपने प्रोजेक्ट के बारे में बताइए',
      // First person, or a hesitation, inside an interviewer's question.
      'What is the main difference between TCP and UDP?',
      'So my question is, how does a hash map work?',
      'Let me rephrase: what is a deadlock?',
      'I have a follow-up: what is a mutex?',
      'Um, what is polymorphism?',
      // Tasks without a question word.
      'Now reverse a linked list in place.',
      'Next problem: two sum.',
    ]) {
      assert.deepEqual(decide(text), { action: 'replace', reason: 'new-question', question: text }, text);
    }
  });

  describe('the rest of the voice question just asked', () => {
    const previous = { question: 'What is the difference between a process and a thread?', askedAt: now - 6000 };

    it('is joined to it when it continues it or asks more', () => {
      for (const text of ['And when would you use each?', 'Also how do they share memory', 'Aur dono mein memory kaise share hoti hai?', 'How do they communicate?']) {
        assert.deepEqual(decide(text, { previous }),
          { action: 'merge', reason: 'same-question', question: `${previous.question} ${text}` }, text);
      }
    });

    it('is joined to it when it adds a constraint', () => {
      const asked = { question: 'Design a URL shortener.', askedAt: now - 5000 };
      for (const text of ['Assume it handles a million requests per second.', 'What if the links have to expire?']) {
        assert.deepEqual(decide(text, { previous: asked }),
          { action: 'merge', reason: 'same-question', question: `Design a URL shortener. ${text}` }, text);
      }
    });

    it('is joined to an unfinished question even when it is not a question itself', () => {
      const cut = { question: 'Explain the difference between a process and', askedAt: now - 4000 };
      assert.deepEqual(decide('a thread in an operating system.', { previous: cut }),
        { action: 'merge', reason: 'same-question', question: 'Explain the difference between a process and a thread in an operating system.' });
    });

    it('still ignores thinking aloud', () => {
      assert.equal(decide('Umm, let me think.', { previous }).action, 'ignore');
      assert.equal(decide('So a process has its own memory.', { previous }).action, 'ignore');
    });

    it('is a separate question once the merge window has passed', () => {
      const old = { ...previous, askedAt: now - MERGE_WINDOW_MS - 1 };
      assert.equal(decide('How do they communicate?', { previous: old }).action, 'replace');
      assert.equal(decide('And when would you use each one?', { previous: old }).action, 'replace');
      assert.equal(decide('a thread in an operating system.', { previous: { question: 'Explain a process and', askedAt: now - MERGE_WINDOW_MS - 1 } }).action, 'ignore');
    });

    it('ignores a malformed previous question', () => {
      for (const bad of [{ question: '', askedAt: now }, { question: 'What?', askedAt: NaN }, { question: 7, askedAt: now }, { question: 'Hi?', askedAt: now + 5000 }]) {
        assert.equal(decide('How do they communicate?', { previous: bad }).action, 'replace');
      }
    });
  });
});
