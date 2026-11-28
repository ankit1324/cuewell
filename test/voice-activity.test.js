'use strict';
// The speech service's voice-activity events (src/services/speech.service.js
// _updateVoiceActivity): busy from the first sound of speech until its
// segment is transcribed, with the time of the last word heard. main.js
// holds a heard question while busy, and counts the pause before answering
// from that last word.
//
// Synthetic 16 kHz PCM goes straight into the VAD; transcription is a stub,
// and nothing is spawned.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { tempDir, stubLogger, clearAppEnv } = require('./helpers/env');
const { repoPath } = require('./helpers/source');
const { createElectronMock, installElectronMock } = require('./helpers/electron-mock');

// 256 ms of 16 kHz mono 16-bit PCM: a tone (speech) or silence.
const CHUNK_SAMPLES = 4096;
function chunk(amplitude) {
  const buffer = Buffer.alloc(CHUNK_SAMPLES * 2);
  for (let i = 0; i < CHUNK_SAMPLES; i++) {
    buffer.writeInt16LE(Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / 16000)), i * 2);
  }
  return buffer;
}
const SPEECH = chunk(0.3);
const SILENCE = chunk(0);

describe('speech service voice-activity', () => {
  const ROOT = tempDir(null, 'cuewell-vad-');
  let service;
  let events;
  let transcribed;
  let savedSpawn;

  before(() => {
    clearAppEnv();
    stubLogger();
    const { electron } = createElectronMock({ userData: path.join(ROOT, 'userData'), appData: path.join(ROOT, 'appData'), appPath: repoPath() });
    installElectronMock(electron);
    savedSpawn = {};
    for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
      savedSpawn[fn] = childProcess[fn];
      childProcess[fn] = () => { throw new Error(`${fn} is blocked in tests`); };
    }
    process.env.SPEECH_PROVIDER = 'whisper';
    process.env.WHISPER_CAPTURE_MODE = 'vad';
    service = require('../src/services/speech.service');
    service.on('voice-activity', (activity) => events.push({ ...activity, at: Date.now() }));
    service.on('transcription', (text) => events.push({ transcription: text, at: Date.now() }));
    service.on('error', () => {});
  });

  after(() => {
    if (service) service.shutdown();
    for (const [fn, original] of Object.entries(savedSpawn || {})) childProcess[fn] = original;
  });

  beforeEach(() => {
    service._cleanup();
    service.voiceBusy = false;
    service.voiceLastAt = 0;
    events = [];
    transcribed = [];
    // Recording with the local engine, audio from the toolbar, no watchdog.
    service.provider = 'whisper';
    service.isRecording = true;
    service._transcribeWhisperBuffer = async (audio) => {
      transcribed.push(audio.length);
      await sleep(60);
      return 'What is a mutex?';
    };
  });

  const feed = async (buffers) => {
    for (const buffer of buffers) {
      service._ingestWhisperAudio(buffer);
      await sleep(1);
    }
  };
  const settle = () => sleep(120);

  it('is busy from the first word until the segment is transcribed, then idle with the last word time', async () => {
    await feed([SILENCE, SILENCE]);
    assert.deepEqual(events, [], 'no event for silence');
    await feed([SPEECH, SPEECH, SPEECH]);
    const lastWordAt = Date.now();
    await feed([SPEECH]);
    const lastWordAtLatest = Date.now();
    await feed([SILENCE, SILENCE, SILENCE]); // 768 ms > the 700 ms pause that ends a segment
    await settle();

    assert.equal(transcribed.length, 1);
    const kinds = events.map((e) => (e.transcription ? 'transcription' : e.busy ? 'busy' : 'idle'));
    assert.deepEqual(kinds, ['busy', 'transcription', 'idle']);
    const idle = events[2];
    assert.equal(idle.recording, true);
    assert.ok(idle.lastVoiceAt >= lastWordAt && idle.lastVoiceAt <= lastWordAtLatest, 'last word time is the last loud chunk');
    assert.equal(events[0].lastVoiceAt, 0, 'no word kept yet when the first starts');
  });

  it('stays busy while the speaker resumes during transcription', async () => {
    await feed([SPEECH, SPEECH, SILENCE, SILENCE, SILENCE]);
    // Transcribing now; the speaker goes on before it ends.
    await feed([SPEECH, SPEECH]);
    await sleep(80);
    assert.deepEqual(events.map((e) => (e.transcription ? 'transcription' : e.busy ? 'busy' : 'idle')), ['busy', 'transcription']);
    await feed([SILENCE, SILENCE, SILENCE]);
    await settle();
    assert.deepEqual(events.map((e) => (e.transcription ? 'transcription' : e.busy ? 'busy' : 'idle')),
      ['busy', 'transcription', 'transcription', 'idle']);
  });

  it('goes idle after a click too short to be speech, keeping the earlier last word time', async () => {
    service.voiceLastAt = 12345;
    await feed([SPEECH, SILENCE, SILENCE, SILENCE]); // 256 ms of sound < the 350 ms minimum
    await settle();
    assert.equal(transcribed.length, 0);
    assert.deepEqual(events.map((e) => [e.busy, e.lastVoiceAt]), [[true, 12345], [false, 12345]]);
  });

  it('reports recording false once listening stops, so the question is sent right away', async () => {
    await feed([SPEECH, SPEECH, SPEECH]);
    service.stopRecording();
    await settle();
    const idle = events.filter((e) => e.busy === false);
    assert.equal(idle.length, 1);
    assert.equal(idle[0].recording, false);
    assert.ok(events.some((e) => e.transcription), 'the final segment was transcribed');
  });

  it('stays busy through a transcription that is running when listening stops', async () => {
    await feed([SPEECH, SPEECH, SPEECH, SILENCE, SILENCE, SILENCE]);
    // The segment is being transcribed (60 ms); stop now.
    service.stopRecording();
    await settle();
    const kinds = events.map((e) => (e.transcription ? 'transcription' : e.busy ? 'busy' : 'idle'));
    assert.deepEqual(kinds, ['busy', 'transcription', 'idle']);
    assert.equal(events[2].recording, false);
  });

  it('sends nothing in manual capture', async () => {
    process.env.WHISPER_CAPTURE_MODE = 'manual';
    try {
      await feed([SPEECH, SPEECH, SPEECH, SILENCE, SILENCE, SILENCE]);
      await settle();
      assert.deepEqual(events, []);
    } finally {
      process.env.WHISPER_CAPTURE_MODE = 'vad';
    }
  });
});
