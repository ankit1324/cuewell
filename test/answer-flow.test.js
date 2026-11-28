'use strict';
// main.js keeps one answer at a time: a new question of any kind (typed,
// voice after the debounce, screenshot) stops the answer still streaming,
// and the Stop button (stop-answer) or shortcut stops it on request. A
// stopped answer keeps the text received so far, is stored once in session
// memory marked as stopped, gets no chunk after the stop, and shows no
// error or fallback answer.
//
// main.js runs in a child process (test/helpers/answer-harness.js) with a
// mocked electron module and the real LLMService and OpenAI-compatible
// provider over a fake, slow SSE fetch.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConstant, readSource } = require('./helpers/source');
const { RESULT_MARKER } = require('./helpers/answer-harness');

const HARNESS = path.join(__dirname, 'helpers', 'answer-harness.js');
const IPC_ALLOWED_WINDOWS = loadConstant('main.js', 'IPC_ALLOWED_WINDOWS', { Object });
const SHORTCUT_ACTIONS = loadConstant('main.js', 'SHORTCUT_ACTIONS', { Object });
const STOPPED_NOTE = loadConstant('main.js', 'STOPPED_ANSWER_NOTE');

function runHarness(root) {
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
    TMPDIR: root, TEMP: root, TMP: root, NODE_ENV: 'test' };
  for (const name of ['SystemRoot', 'windir', 'ComSpec']) if (process.env[name]) env[name] = process.env[name];
  const child = spawnSync(process.execPath, [HARNESS, root], {
    cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
  });
  const report = `exit ${child.status}${child.error ? `, ${child.error.message}` : ''}\n` +
    `${(child.stdout || '').slice(-3000)}\n${(child.stderr || '').slice(-2000)}`;
  const line = (child.stdout || '').split('\n').find((l) => l.startsWith(RESULT_MARKER));
  assert.ok(line, `harness printed no result: ${report}`);
  const output = JSON.parse(line.slice(RESULT_MARKER.length));
  assert.equal(output.fatal, undefined, `${output.fatal}\n${JSON.stringify(output.debug || {}, null, 1).slice(0, 4000)}`);
  assert.equal(child.status, 0, report);
  return output;
}

const idOf = (event) => event.data && (event.data.messageId || (event.data.metadata && event.data.metadata.messageId));
const isChunk = (event, id) => event.channel === 'transcription-llm-response-chunk' && idOf(event) === id && event.data.delta;
const isStopped = (event, id) => event.channel === 'transcription-llm-response' && idOf(event) === id && event.data.stopped === true;

/** Text of answer `id` as `to` received it before its stopped event. */
function streamedText(events, id, to = 'chat') {
  return events.filter((e) => e.to === to && isChunk(e, id)).map((e) => e.data.delta).join('');
}

function assertNoErrorUi(scenario, id) {
  for (const event of scenario.events) {
    if (idOf(event) !== id) continue;
    assert.notEqual(event.channel, 'llm-error', `${id} showed an error`);
    if (event.channel === 'display-llm-response') {
      assert.equal(event.data.metadata.isError, undefined, `${id} showed an error`);
    }
  }
}

function assertNothingAfterStop(scenario, id) {
  const stopAt = scenario.events.findIndex((e) => isStopped(e, id));
  assert.ok(stopAt >= 0, `${id} was not reported as stopped`);
  const late = scenario.events.slice(stopAt + 1).filter((e) => idOf(e) === id && e.channel !== 'transcription-llm-response' &&
    e.channel !== 'display-llm-response');
  assert.deepEqual(late, [], `${id} sent events after the stop`);
  assert.equal(scenario.fetchCalls[0].aborted, true, 'the HTTP request was not aborted');
  assert.equal(scenario.fetchCalls[0].sentAfterAbort, 0);
}

/** The stopped answer `id` in session memory: once, marked, with the text shown so far. */
function assertStoredOnce(scenario, id, reason) {
  const partial = streamedText(scenario.events, id).trim();
  const stopped = scenario.memory.filter((e) => e.stopped);
  assert.equal(stopped.length, 1, `stored ${stopped.length} times`);
  assert.equal(stopped[0].role, 'model');
  assert.equal(stopped[0].stopReason, reason);
  assert.equal(stopped[0].content, `${partial}\n\n${STOPPED_NOTE}`);
  assert.ok(partial.length > 0);
}

describe('answers in main.js', () => {
  let out;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cuewell-answers-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  before(() => {
    out = runHarness(root);
  });

  it('logs no errors', () => {
    assert.deepEqual(out.errors, []);
  });

  for (const [name, source] of [['typed', 'typed chat'], ['voice', 'a voice question'], ['screenshot', 'a screenshot']]) {
    describe(`${source} while an answer streams`, () => {
      const scenario = () => out.scenarios[name];

      it('stops the previous answer before the new one starts', () => {
        const { events, first, second } = scenario();
        assert.ok(first && second && first !== second);
        const stopAt = events.findIndex((e) => isStopped(e, first));
        const startAt = events.findIndex((e) => e.channel === 'transcription-llm-response-start' && idOf(e) === second);
        assert.ok(stopAt >= 0 && startAt > stopAt, 'the new answer started before the old one stopped');
        // The answer window moves straight on to the new answer.
        assert.equal(events.filter((e) => isStopped(e, first)).map((e) => e.to).join(), 'chat');
        assert.equal(events.some((e) => e.channel === 'display-llm-response' && idOf(e) === first), false);
      });

      it('keeps the text received so far, with no later chunk and no error', () => {
        const { events, first } = scenario();
        const stoppedEvent = events.find((e) => isStopped(e, first));
        assert.equal(stoppedEvent.data.response, streamedText(events, first));
        assert.ok(scenario().firstChunksAtStop >= 2);
        assertNothingAfterStop(scenario(), first);
        assertNoErrorUi(scenario(), first);
      });

      it('finishes the new answer normally', () => {
        const { events, second, fetchCalls } = scenario();
        const final = events.find((e) => e.channel === 'transcription-llm-response' && idOf(e) === second);
        assert.ok(final, 'no final answer for the new question');
        assert.equal(final.data.stopped, undefined);
        assert.match(final.data.response, /^Say this first\. Then the details follow here\.$/);
        assert.equal(fetchCalls.length, 2);
        assert.equal(fetchCalls[1].aborted, false);
        assertNoErrorUi(scenario(), second);
      });

      it('stores the stopped answer once, marked, before the next question', () => {
        assertStoredOnce(scenario(), scenario().first, 'replaced');
        const memory = scenario().memory;
        const roles = memory.map((e) => `${e.role}${e.stopped ? ' (stopped)' : ''}`);
        const expected = name === 'screenshot'
          ? ['user', 'model (stopped)', 'model'] // screenshots store no question
          : ['user', 'model (stopped)', 'user', 'model'];
        assert.deepEqual(roles, expected);
      });
    });
  }

  it('marks the answer window Stopped when the new answer goes to chat only', () => {
    const { events, first, second } = out.scenarios.voiceChatOnly;
    assert.ok(second);
    const toOverlay = events.filter((e) => e.to === 'llmResponse' && idOf(e) === first &&
      (isStopped(e, first) || (e.channel === 'display-llm-response' && e.data.metadata.stopped === true)));
    assert.deepEqual(toOverlay.map((e) => e.channel).sort(), ['display-llm-response', 'transcription-llm-response']);
    assert.equal(events.some((e) => e.to === 'llmResponse' && idOf(e) === second), false, 'the voice answer reached the answer window');
  });

  it('lets an utterance too short to answer leave the running answer alone', () => {
    const { events, first, memory, started } = out.scenarios.shortUtterance;
    assert.deepEqual(started, [first]);
    assert.equal(events.some((e) => isStopped(e, first)), false);
    assert.deepEqual(memory.map((e) => `${e.role}${e.stopped ? ' (stopped)' : ''}`), ['user', 'user', 'model']);
  });

  describe('Stop button (stop-answer)', () => {
    const scenario = () => out.scenarios.userStop;

    it('stops the answer with that id and ignores other ids', () => {
      const { ipc } = scenario();
      assert.deepEqual(ipc.wrongId.value, { success: true, stopped: false });
      assert.deepEqual(ipc.stop.value, { success: true, stopped: true });
      assert.deepEqual(ipc.again.value, { success: true, stopped: false }, 'nothing is running any more');
    });

    it('rejects anything but an answer id', () => {
      const { ipc } = scenario();
      for (const label of ['bad object', 'bad number', 'bad empty', 'bad path', 'bad long', 'bad proto']) {
        assert.deepEqual(ipc[label].value, { success: false, error: 'Invalid answer id' }, label);
      }
    });

    it('marks the answer Stopped in both windows with the text so far', () => {
      const { events, first } = scenario();
      const partial = streamedText(events, first);
      const stopped = events.filter((e) => isStopped(e, first));
      assert.deepEqual(stopped.map((e) => e.to).sort(), ['chat', 'llmResponse']);
      for (const e of stopped) assert.equal(e.data.response, partial);
      const display = events.find((e) => e.channel === 'display-llm-response' && idOf(e) === first);
      assert.equal(display.data.content, partial);
      assert.equal(display.data.metadata.stopped, true);
      assert.ok(scenario().chunksAtStop >= 3);
      assertNothingAfterStop(scenario(), first);
      assertNoErrorUi(scenario(), first);
    });

    it('stores the partial answer once', () => {
      assertStoredOnce(scenario(), scenario().first, 'user');
      assert.deepEqual(scenario().memory.map((e) => e.role), ['user', 'model']);
    });

    it('stops while "Thinking…" with nothing stored and an empty stopped answer', () => {
      const s = out.scenarios.stopEarly;
      assert.deepEqual(s.ipc.early.value, { success: true, stopped: true });
      assert.deepEqual(s.memory.map((e) => e.role), ['user']);
      const stopped = s.events.filter((e) => isStopped(e, s.first));
      assert.deepEqual(stopped.map((e) => e.data.response), ['', '']);
      assert.equal(s.events.some((e) => isChunk(e, s.first)), false);
      assertNoErrorUi(s, s.first);
    });

    it('is allowed only for the two windows with the button', () => {
      assert.deepEqual([...IPC_ALLOWED_WINDOWS['stop-answer']].sort(), ['chat', 'llmResponse']);
    });
  });

  describe('Stop shortcut', () => {
    it('stops a voice answer', () => {
      const s = out.scenarios.shortcut;
      assert.equal(s.stoppedByShortcut, true);
      assertNothingAfterStop(s, s.first);
      assertStoredOnce(s, s.first, 'user');
    });

    it('is Cmd/Ctrl+Shift+X and listed everywhere shortcuts are, as working only while an answer is written', () => {
      assert.match(SHORTCUT_ACTIONS['CommandOrControl+Shift+X'], /Stop/);
      assert.equal(loadConstant('main.js', 'STOP_ANSWER_SHORTCUT'), 'CommandOrControl+Shift+X');
      // No other action uses X.
      assert.deepEqual(Object.keys(SHORTCUT_ACTIONS).filter((k) => /\+X$/i.test(k)), ['CommandOrControl+Shift+X']);
      assert.match(readSource('index.html'), /Stop the answer being written<\/span>[\s\S]*?<span class="oc-kbd">X<\/span>/);
      assert.match(readSource('src/ui/settings-window.js'),
        /s\.scope === 'answer'\)[\s\S]*?'Everywhere, while an answer is being written'/);
    });
  });

  describe('Stop shortcut registration', () => {
    const life = () => out.scenarios.stopShortcut;
    const STOP = 'CommandOrControl+Shift+X';

    it('is not registered at startup; the other global shortcuts are, unchanged', () => {
      const { registered } = out.scenarios.startup;
      assert.deepEqual(registered, ['CommandOrControl+Shift+S', 'CommandOrControl+Shift+V', 'CommandOrControl+Shift+I',
        'CommandOrControl+Shift+C', 'CommandOrControl+Shift+\\', 'Alt+A', 'Alt+R']);
      assert.equal(registered.includes(STOP), false);
      assert.equal(life().idle, false);
    });

    it('is listed in Settings as on demand, not as failed, while idle', () => {
      const { shortcuts, stop } = out.scenarios.startup;
      assert.deepEqual(stop, { scope: 'answer', registered: null, action: SHORTCUT_ACTIONS[STOP] });
      assert.equal(shortcuts.filter((s) => s.accelerator === STOP).length, 1);
      assert.deepEqual(shortcuts.filter((s) => s.registered === false), []);
    });

    it('is registered when an answer starts and released when it finishes', () => {
      assert.equal(life().firstStreaming, true);
      assert.equal(life().finished, false);
      assert.deepEqual(life().callsAfterFinish, ['register', 'unregister']);
      for (const name of ['typed', 'screenshot', 'userStop', 'shortcut', 'stopEarly', 'voiceChatOnly', 'shortUtterance']) {
        assert.deepEqual(out.scenarios[name].stopShortcut, ['register', 'unregister'], name);
        assert.equal(out.scenarios[name].stopShortcutHeld, false, name);
      }
    });

    it('stays registered, with no second registration, when a new question replaces the answer', () => {
      assert.equal(life().replacedStreaming, true);
      assert.deepEqual(life().callsWhileReplacing, ['register']);
    });

    it('is released when the answer is stopped by the button or by the shortcut itself', () => {
      assert.equal(life().nextAnswerStreaming, true, 'not registered again for the next answer');
      assert.equal(life().afterStopButton, false);
      assert.deepEqual(life().callsStopButton, ['register', 'unregister']);
      assert.equal(life().shortcutStopped, true, 'the registered handler did not stop the answer');
      assert.equal(life().afterShortcut, false);
      assert.deepEqual(life().callsShortcut, ['register', 'unregister']);
    });

    it('is released when the answer fails', () => {
      assert.equal(life().failingStreaming, true);
      assert.equal(life().afterError, false);
      assert.deepEqual(life().callsError, ['register', 'unregister']);
    });

    it('is released on quit, and an answer ending afterwards registers nothing', () => {
      assert.equal(life().quitError, undefined);
      assert.equal(life().beforeQuit, true);
      assert.equal(life().afterQuit, false);
      assert.equal(life().afterQuitAnswerEnded, false);
      assert.deepEqual(life().callsQuit, ['register', 'unregisterAll']);
    });

    it('tolerates another app owning the keys: answers work, one warning, nothing unregistered', () => {
      assert.equal(life().heldFinals, 2);
      // One try per answer, and never an unregister of keys Cuewell does not hold.
      assert.deepEqual(life().heldCalls, ['register', 'register']);
      assert.equal(life().heldWarnings, 1);
      assert.deepEqual(life().heldInfo, { scope: 'answer', registered: false, action: SHORTCUT_ACTIONS[STOP] });
    });

    it('is registered again once the other app lets go, and no longer shown as failed', () => {
      assert.equal(life().releasedStreaming, true);
      assert.equal(life().releasedAfter, false);
      assert.deepEqual(life().releasedInfo, { scope: 'answer', registered: null, action: SHORTCUT_ACTIONS[STOP] });
    });
  });

  describe('a screenshot macOS blocks (stale Screen Recording permission)', () => {
    const shot = () => out.scenarios.captureBlocked;
    const shown = () => shot().events.filter((e) => e.channel === 'display-llm-response');

    it('shows the steps once, as an error, with the settings and copy buttons', () => {
      assert.equal(shown().length, 1);
      const { content, metadata } = shown()[0].data;
      assert.equal(metadata.isError, true);
      assert.equal(metadata.action, 'screen-recording-settings');
      assert.equal(metadata.copyText, 'tccutil reset ScreenCapture com.ankitchaudhary.cuewell');
      assert.match(content, /came back blank/);
      assert.match(content, /earlier version/);
      assert.match(content, /Open Screen Recording Settings/);
      assert.match(content, /`tccutil reset ScreenCapture com\.ankitchaudhary\.cuewell`/);
    });

    it('starts no answer and sends nothing to the AI', () => {
      assert.deepEqual(shot().started, []);
      assert.deepEqual(shot().fetchCalls, []);
      assert.ok(!shot().events.some((e) => e.channel === 'show-loading'));
    });

    it('logs the reason and the permission status', () => {
      assert.equal(shot().captureLogs.length, 1);
      assert.equal(shot().captureLogs[0].reason, 'BLANK_IMAGE');
      assert.equal(shot().captureLogs[0].screenAccess, 'granted');
      assert.equal(shot().captureLogs[0].problem, 'stale-grant');
    });

    it('opens only the Screen Recording settings, whatever the page passes, and only for the answer window', () => {
      assert.deepEqual(shot().settingsIpc.fromAnswer, { ok: true, value: true });
      assert.deepEqual(shot().openedFromAnswer,
        ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
      assert.equal(shot().settingsIpc.fromChat.ok, false);
      assert.deepEqual(shot().openedFromChat, []);
      assert.deepEqual(IPC_ALLOWED_WINDOWS['open-screen-recording-settings'], ['llmResponse']);
    });
  });

  describe('voice turn-taking', () => {
    const startsOf = (scenario) => scenario.started;

    it('ignores thinking aloud while an answer is written, and stores nothing of it', () => {
      const { events, first, ignored, questions } = out.scenarios.voiceThinkingAloud;
      assert.deepEqual(startsOf(out.scenarios.voiceThinkingAloud), [first]);
      assert.equal(events.some((e) => isStopped(e, first)), false, 'the answer was stopped');
      assert.ok(events.some((e) => e.to !== 'llmResponse' && e.channel === 'transcription-llm-response' && idOf(e) === first));
      assert.equal(ignored.length, 1);
      assert.equal(ignored[0].to, 'chat');
      assert.equal(ignored[0].data.reason, 'self-talk');
      assert.match(ignored[0].data.message, /Kept the answer on screen/);
      assert.deepEqual(questions, ['What is a semaphore?']);
    });

    it('ignores the answer read aloud after it finished, then lets a real question replace it', () => {
      const { readAloud, second, questions, events } = out.scenarios.voiceAfterFinish;
      assert.equal(readAloud.started, 0);
      assert.deepEqual(readAloud.ignored.map((e) => e.data.reason), ['not-a-question']);
      assert.ok(second);
      assert.ok(events.some((e) => e.to === 'chat' && e.channel === 'transcription-llm-response' && idOf(e) === second && !e.data.stopped));
      assert.deepEqual(questions, ['What is a semaphore?', 'Tell me about a time you disagreed with your manager.']);
    });

    it('answers the rest of a voice question together with its first part', () => {
      const { events, first, second, questions, fetchCalls } = out.scenarios.voiceMerge;
      assert.ok(events.some((e) => isStopped(e, first)), 'the half-question answer was not replaced');
      assert.equal(questions.length, 2);
      assert.equal(questions[1], 'What is the difference between a process and a thread? And when would you use each?');
      assert.ok(events.some((e) => e.channel === 'transcription-llm-response' && idOf(e) === second && !e.data.stopped));
      assert.equal(fetchCalls.length, 2);
    });

    it('holds a question while someone is still speaking, then sends it once, whole', () => {
      const { heldStarts, started, questions } = out.scenarios.voiceHold;
      assert.equal(heldStarts, 0);
      assert.equal(started.length, 1);
      assert.deepEqual(questions, ['What is the difference between a process and a thread, and when would you use each?']);
    });

    it('sends a held question after the hold limit when speech never pauses', () => {
      const { beforeLimit, started, questions } = out.scenarios.voiceHoldLimit;
      assert.equal(beforeLimit, 0);
      assert.equal(started.length, 1);
      assert.deepEqual(questions, ['Explain how a load balancer works.']);
    });

    it('counts the pause from the last word, waits longer for unfinished questions and on Long', () => {
      const t = out.scenarios.voiceTiming;
      // Clear question: 2.5 s after a last word 2.3 s ago.
      assert.ok(t.completeMs >= 150 && t.completeMs < 900, `complete ${t.completeMs}`);
      // Unfinished: 5 s after a last word 4.5 s ago.
      assert.equal(t.unfinishedAt300, 0);
      assert.ok(t.unfinishedMs >= 450 && t.unfinishedMs < 1300, `unfinished ${t.unfinishedMs}`);
      // Stopped listening: at once.
      assert.ok(t.stoppedMs < 150, `stopped ${t.stoppedMs}`);
      // Long, clear question: 3.5 s after a last word 3.3 s ago.
      assert.ok(t.longCompleteMs >= 150 && t.longCompleteMs < 900, `long ${t.longCompleteMs}`);
    });

    it('lets a typed question replace a voice answer, however short', () => {
      const { events, first, second } = out.scenarios.typedAfterVoice;
      assert.ok(second);
      assert.ok(events.some((e) => isStopped(e, first)));
    });

    it('lets voice replace an answer the user stopped', () => {
      const { second, started } = out.scenarios.voiceAfterUserStop;
      assert.equal(started.length, 2);
      assert.ok(second);
    });
  });
});
