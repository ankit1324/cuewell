/**
 * When a spoken question has ended, and whether it may replace the answer
 * on screen.
 *
 * Voice arrives as transcript fragments, one per pause the speech service
 * hears. main.js joins them into one question and asks the AI once the
 * speaker has been quiet long enough. Two things go wrong with a fixed
 * wait:
 *
 *   1. The interviewer pauses for 2 to 4 seconds to think in the middle of
 *      a question, and the half question is answered.
 *   2. The microphone also hears the user thinking aloud ("umm, let me
 *      think") or starting to answer, and that becomes a new question that
 *      replaces the answer the user is reading.
 *
 * endOfQuestionDelayMs() fixes the first: how long to wait after the last
 * word depends on how finished the transcript looks and on the user's
 * "Pause before answering" setting (VOICE_PAUSE). decideVoiceUtterance()
 * fixes the second: while an answer is on screen, an utterance replaces it
 * only when it is substantial and sounds like a question from the
 * interviewer. Typed questions and screenshots do not go through here; they
 * always start a new answer.
 *
 * Pure functions, no Electron: tested in test/voice-turn.test.js.
 */

const VOICE_PAUSES = Object.freeze(['short', 'normal', 'long']);
const DEFAULT_VOICE_PAUSE = 'normal';

// Silence after the speaker's last word, in ms, before the question is
// answered, by how the transcript ends:
//   complete    a clear question ("...a thread?", "Tell me about yourself.")
//   open        ends a sentence, but not clearly a question
//   unfinished  no ending punctuation, or ends with "and", "um", "the", "matlab"...
// Before this setting existed the wait was about 2 s whatever was said
// (0.7 s for the speech service to end a segment, plus 0.8 s here, plus
// transcription), so a thinking pause of 2 s or more split the question.
const PAUSE_PROFILES = Object.freeze({
  short: Object.freeze({ complete: 1500, open: 2000, unfinished: 3000 }),
  normal: Object.freeze({ complete: 2500, open: 3500, unfinished: 5000 }),
  long: Object.freeze({ complete: 3500, open: 5000, unfinished: 8000 }),
});

// While an answer is on screen it is protected from voice that does not
// sound like a new question: while it is written, and this long after.
const ANSWER_ON_SCREEN_MS = 90000;
// A question heard this soon after the last voice question was sent is the
// rest of it (the speaker paused after a part that looked complete), so the
// two are asked together.
const MERGE_WINDOW_MS = 15000;
// Words a replacing question needs: with a question mark, and without.
const MIN_QUESTION_WORDS = 3;
const MIN_PLAIN_WORDS = 4;

const words = (list) => new Set(list.split(/\s+/).filter(Boolean));

// Last words that leave a sentence hanging even before a question mark
// (Whisper often punctuates a cut-off fragment anyway): conjunctions and
// hesitation sounds, English, Hinglish and Hindi.
const HANGING_WORDS = words(`
  and or but because cause plus also um umm ummm uh uhh uhm er erm hmm hmmm mm ah
  aur ya lekin kyunki kyonki matlab yaani toh
  और या लेकिन क्योंकि मतलब यानी तो
`);
// Last words that usually mean more is coming, unless a question mark ends
// the transcript ("Why do you think so?", "What would that look like?").
const DANGLING_WORDS = words(`
  so like the a an of between than is are was were my your our their his her its
  which whose basically actually
  ki ke ka ko se mein par pe jaise ek
  कि के का की को से में पर जैसे एक
`);
// Two-word endings that leave a sentence hanging.
const DANGLING_PAIRS = ['you know', 'i mean', 'kind of', 'sort of', 'such as', 'for example', "let's say", 'lets say'];

// Words that start a question or a request from the interviewer, after any
// opening filler ("Okay so, how would you...").
const QUESTION_STARTS = words(`
  what what's whats why how how's hows when where which who who's whom whose
  can could would will should shall do does did is are was were have has had may might
  tell explain describe walk give show design implement write compare define list name
  suppose imagine consider given find solve share talk discuss build
  reverse sort merge optimize optimise scale code create calculate count return print check convert detect
  question problem
`);
const OPENING_FILLERS = words(`
  so okay ok alright right now and well um umm uh hmm great good cool next then also
  toh to accha acha achha haan chalo theek ji
`);
const QUESTION_PHRASES = [
  'tell me', 'walk me through', 'can you', 'could you', 'would you', 'will you', 'do you', 'did you', 'have you',
  'how would', 'what would', 'what is', 'what are', 'difference between', "let's say", 'talk about',
  'what about', 'how about', 'why did', 'why do', 'explain', 'describe',
  'next question', 'next problem', 'move on', 'moving on', 'follow up', 'follow-up', 'what if',
];
// Hindi and Hinglish question words, anywhere in the utterance.
const HINDI_QUESTION_WORDS = words(`
  kya kaise kaisa kaisi kyun kyu kyon kaun kab kahan kahaan kitna kitne kitni
  batao bataiye bataye samjhao samjhaiye samjhaye
  क्या कैसे कैसा कैसी क्यों क्यूं कौन कब कहाँ कहां कितना कितने कितनी बताइए बताओ बताएं बताइये समझाइए समझाओ समझाइये
`);
// Words that alone are not a question: acknowledgements and hesitation.
const FILLER_WORDS = words(`
  um umm ummm uh uhh uhm er erm hmm hmmm mm mhm huh ah oh okay ok yeah yes yep no nope right
  so well like sure alright great good nice cool thanks thank you got it fine
  accha acha achha haan han theek thik hai ji matlab toh to bas
  हाँ हां अच्छा ठीक है जी मतलब तो बस
`);
// Talking about oneself. On their own these only mark self-talk in speech
// that is not a question: "So my question is, how does a hash map work?"
// and "What is the main difference...?" come from the interviewer.
const FIRST_PERSON = words(`
  i i'm im i'd i'll i've my mine myself
  main mai mujhe mera meri mere maine
  मैं मुझे मेरा मेरी मेरे मैंने
`);
const SECOND_PERSON = words(`
  you your yours yourself you're youre you've you'd you'll u
  aap aapka aapki aapke aapne aapko tum tumhara tumhari tumhare tumne tumko
  आप आपका आपकी आपके आपने आपको तुम तुम्हारा तुम्हारी तुमने
`);
// Phrases people say to themselves while thinking or answering, self-talk
// even in question form ("I think it is O(n log n), right?").
const SELF_TALK_PHRASES = [
  'let me think', 'let me see', 'let me check', 'let me try', 'let me just', 'lemme think', 'lemme see',
  "let's see", 'lets see', 'give me a second', 'give me a moment', 'one second', 'one moment',
  'i think', 'i guess', 'i believe', 'i would', "i'd", "i'll", 'i will', "i'm thinking", 'i am thinking',
  'my approach', 'my answer', 'my idea',
  'ek second', 'ek minute', 'mujhe lagta', 'mere hisaab', 'main sochta', 'main sochti', 'main pehle',
  'मुझे लगता', 'मेरे हिसाब', 'मैं सोचता', 'मैं सोचती', 'मैं पहले',
];
// Statements that add to the question just asked ("Assume the input is
// sorted."), joined to it within MERGE_WINDOW_MS.
const ADDS_TO_QUESTION = [
  'assume', 'assuming', 'constraint', 'constraints', 'requirement', 'requirements', 'given', 'what if',
  'follow up', 'follow-up', 'in place', 'without using',
];
// First words that join an utterance onto the question before it.
const CONTINUATION_STARTS = words(`
  and also or but plus then specifically especially particularly
  aur ya lekin
  और या लेकिन
`);

/** `raw` as a "Pause before answering" setting, or null when it is not one. */
function parseVoicePause(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return VOICE_PAUSES.includes(value) ? value : null;
}

/** Lower-case words of `text`, without punctuation (apostrophes kept). */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .split(/[^\p{L}\p{M}\p{N}']+/u)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
}

/** Text with spaces around each word, for whole-phrase matching. */
const padded = (tokens) => ` ${tokens.join(' ')} `;
const hasPhrase = (tokens, phrases) => {
  const text = padded(tokens);
  return phrases.some((phrase) => text.includes(` ${phrase} `));
};

/** Words of `text` after the opening fillers ("Okay so, ..."). */
function withoutOpeningFillers(tokens) {
  let i = 0;
  while (i < tokens.length - 1 && OPENING_FILLERS.has(tokens[i])) i++;
  return tokens.slice(i);
}

/**
 * Whether `text` sounds like a question or a request from the interviewer:
 * a question mark, a question word or request verb at the start, a
 * question phrase ("can you", "walk me through"), or a Hindi or Hinglish
 * question word ("kya", "kaise", "batao").
 */
function looksLikeQuestion(text) {
  const raw = String(text || '');
  if (/[?？]/.test(raw)) return true;
  const tokens = tokenize(raw);
  if (!tokens.length) return false;
  const start = withoutOpeningFillers(tokens);
  if (QUESTION_STARTS.has(start[0])) return true;
  if (hasPhrase(tokens, QUESTION_PHRASES)) return true;
  return tokens.some((word) => HINDI_QUESTION_WORDS.has(word));
}

/**
 * How finished the transcript so far looks: "complete", "open" or
 * "unfinished" (see PAUSE_PROFILES).
 */
function transcriptEnding(text) {
  const raw = String(text || '').trim().replace(/["'”’)\]]+$/u, '').trim();
  const tokens = tokenize(raw);
  if (!tokens.length) return 'unfinished';
  const last = tokens[tokens.length - 1];
  const lastTwo = tokens.slice(-2).join(' ');
  if (HANGING_WORDS.has(last)) return 'unfinished';
  // A trailing ellipsis, dash, comma, colon or semicolon: the speaker stopped mid-sentence.
  if (/(\.\.\.|…|[-–—,;:،])$/u.test(raw)) return 'unfinished';
  if (/[?？]$/u.test(raw)) return 'complete';
  if (DANGLING_WORDS.has(last) || DANGLING_PAIRS.includes(lastTwo)) return 'unfinished';
  if (/[.!।॥]$/u.test(raw)) return looksLikeQuestion(raw) ? 'complete' : 'open';
  // No ending punctuation: Whisper punctuates finished sentences.
  return 'unfinished';
}

/** Silence after the last word, in ms, before `text` is answered with `pause`. */
function endOfQuestionDelayMs(text, pause = DEFAULT_VOICE_PAUSE) {
  const profile = PAUSE_PROFILES[parseVoicePause(pause) || DEFAULT_VOICE_PAUSE];
  return profile[transcriptEnding(text)];
}

/** Only acknowledgements and hesitation ("umm", "okay", "haan accha"). */
function isFillerOnly(tokens) {
  return tokens.length > 0 && tokens.every((word) => FILLER_WORDS.has(word));
}

/**
 * The user talking to themselves, without addressing anyone ("you",
 * "aap"): a thinking phrase ("let me think", "I would use a hash map"), or
 * first person ("my", "main") in speech that is not a question.
 */
function isSelfTalk(tokens, question) {
  if (tokens.some((word) => SECOND_PERSON.has(word))) return false;
  if (hasPhrase(tokens, SELF_TALK_PHRASES)) return true;
  return !question && tokens.some((word) => FIRST_PERSON.has(word));
}

/**
 * What to do with a finished voice utterance `text`.
 *
 *   onScreen   an answer is being written, or was shown recently and not
 *              stopped by the user
 *   previous   the last voice question sent: { question, askedAt }, or null
 *              when the answer on screen is not a voice answer
 *   now        Date.now()
 *
 * Returns { action, reason, question }:
 *   "answer"   nothing to protect: answer `question` (the utterance)
 *   "merge"    the rest of the previous voice question: answer
 *              `question`, both parts together, in place of that answer
 *   "replace"  a new question: answer it in place of the one on screen
 *   "ignore"   keep the answer on screen; nothing is asked. `reason` is
 *              "filler", "self-talk", "too-short" or "not-a-question".
 *
 * Ignored speech is not kept as context either: it is most likely the user
 * thinking aloud or reading the answer, and the next answer should not
 * respond to it.
 */
function decideVoiceUtterance({ text, onScreen = false, previous = null, now = Date.now() } = {}) {
  const utterance = String(text || '').trim();
  if (!onScreen) return { action: 'answer', reason: 'nothing-on-screen', question: utterance };

  const tokens = tokenize(utterance);
  if (!tokens.length || isFillerOnly(tokens)) return { action: 'ignore', reason: 'filler', question: '' };
  const question = looksLikeQuestion(utterance);
  if (isSelfTalk(tokens, question)) return { action: 'ignore', reason: 'self-talk', question: '' };

  const recent = previous && typeof previous.question === 'string' && previous.question.trim() &&
    Number.isFinite(previous.askedAt) && now - previous.askedAt >= 0 && now - previous.askedAt <= MERGE_WINDOW_MS;
  if (recent && tokens.length >= 2) {
    const continues = CONTINUATION_STARTS.has(tokens[0]) || hasPhrase(tokens, ADDS_TO_QUESTION);
    const previousUnfinished = transcriptEnding(previous.question) === 'unfinished';
    if (continues || question || previousUnfinished) {
      return { action: 'merge', reason: 'same-question', question: `${previous.question.trim()} ${utterance}` };
    }
  }

  if (!question) return { action: 'ignore', reason: 'not-a-question', question: '' };
  const needed = /[?？]/.test(utterance) ? MIN_QUESTION_WORDS : MIN_PLAIN_WORDS;
  if (tokens.length < needed) return { action: 'ignore', reason: 'too-short', question: '' };
  return { action: 'replace', reason: 'new-question', question: utterance };
}

module.exports = {
  VOICE_PAUSES,
  DEFAULT_VOICE_PAUSE,
  PAUSE_PROFILES,
  ANSWER_ON_SCREEN_MS,
  MERGE_WINDOW_MS,
  parseVoicePause,
  looksLikeQuestion,
  transcriptEnding,
  endOfQuestionDelayMs,
  decideVoiceUtterance,
};
