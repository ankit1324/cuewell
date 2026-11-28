'use strict';
// Screen captures macOS blocks. capture.service.js treats no sources, an
// empty thumbnail and an all-black or transparent one as failures (with a
// code), error-reporter.js picks the message and the answer window's
// button from that code and the Screen Recording status, and the answer
// page shows the buttons only for that error.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, loadFunction, loadConstant, readSource } = require('./helpers/source');
const { createElectronMock, installElectronMock } = require('./helpers/electron-mock');

// A silent logger, so loading the service writes no log files.
const warnings = [];
const loggerFile = require.resolve(path.join(ROOT, 'src', 'core', 'logger.js'));
const quiet = { debug: () => {}, info: () => {}, warn: (message, meta) => warnings.push({ message, meta }), error: () => {} };
require.cache[loggerFile] = {
  id: loggerFile, filename: loggerFile, loaded: true, children: [], paths: [],
  exports: { createServiceLogger: () => ({ ...quiet, logPerformance: () => 0 }), ...quiet, logPerformance: () => 0 },
};

const { electron } = createElectronMock({ userData: path.join(ROOT, 'no-user-data'), appData: ROOT, appPath: ROOT });
installElectronMock(electron);
const DISPLAY = { id: 7, bounds: { x: 0, y: 0, width: 4, height: 2 }, size: { width: 4, height: 2 }, scaleFactor: 1 };
electron.screen = {
  getAllDisplays: () => [DISPLAY],
  getPrimaryDisplay: () => DISPLAY,
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  getDisplayNearestPoint: () => DISPLAY,
};
let sources = [];
electron.desktopCapturer = { getSources: async () => sources };

const captureService = require('../src/services/capture.service');
const { CAPTURE_FAILURES, isBlankBitmap } = captureService;
const errorReporter = require('../src/core/error-reporter');
const {
  describeCaptureError, friendlyCaptureError, screenRecordingProblem,
  SCREEN_RECORDING_SETTINGS_URL, SCREEN_RECORDING_RESET_COMMAND, SCREEN_RECORDING_ACTION, MAC_BUNDLE_ID,
} = errorReporter;

/** A bitmap of `pixels` 4-byte pixels, all set to [c0, c1, c2, alpha]. */
function bitmap(pixels, rgba = [0, 0, 0, 255]) {
  const buffer = Buffer.alloc(pixels * 4);
  for (let i = 0; i < pixels; i++) buffer.set(rgba, i * 4);
  return buffer;
}

function fakeImage(pixels, { empty = false } = {}) {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width: 4, height: 2 }),
    toBitmap: () => pixels,
    toPNG: () => Buffer.from('png'),
    crop: () => fakeImage(pixels),
  };
}

const source = (thumbnail) => ({ id: 'screen:7:0', name: 'Screen', display_id: '7', thumbnail });

describe('isBlankBitmap', () => {
  it('treats black, near-black and fully transparent pixels as blank', () => {
    assert.equal(isBlankBitmap(bitmap(8)), true);
    assert.equal(isBlankBitmap(bitmap(8, [0, 0, 0, 0])), true);
    assert.equal(isBlankBitmap(bitmap(8, [255, 255, 255, 0])), true, 'transparent white');
    assert.equal(isBlankBitmap(bitmap(8, [3, 1, 2, 255])), true, 'colour-conversion noise');
  });

  it('finds a single visible pixel anywhere', () => {
    for (const at of [0, 3, 7]) {
      const pixels = bitmap(8);
      pixels.set([0, 0, 4, 255], at * 4);
      assert.equal(isBlankBitmap(pixels), false, `pixel ${at}`);
    }
    // Dim, but visible: dark grey text on a black terminal.
    const text = bitmap(8);
    text.set([40, 40, 40, 255], 20);
    assert.equal(isBlankBitmap(text), false);
  });

  it('reads buffers that do not start on a 4-byte boundary', () => {
    const backing = Buffer.alloc(8 * 4 + 1);
    const pixels = backing.subarray(1);
    assert.equal(pixels.byteOffset % 4, 1);
    assert.equal(isBlankBitmap(pixels), true);
    pixels.set([200, 10, 10, 255], 12);
    assert.equal(isBlankBitmap(pixels), false);
  });

  it('counts nothing as blank', () => {
    assert.equal(isBlankBitmap(Buffer.alloc(0)), true);
    assert.equal(isBlankBitmap(null), true);
  });

  it('reads a blank 4K capture quickly, and stops at once on a real one', (t) => {
    const pixels = 3840 * 2160;
    const blank = bitmap(pixels);
    let start = process.hrtime.bigint();
    assert.equal(isBlankBitmap(blank), true);
    const blankMs = Number(process.hrtime.bigint() - start) / 1e6;
    blank.set([30, 30, 30, 255], 0);
    start = process.hrtime.bigint();
    assert.equal(isBlankBitmap(blank), false);
    const realMs = Number(process.hrtime.bigint() - start) / 1e6;
    t.diagnostic(`blank 3840x2160: ${blankMs.toFixed(1)} ms, real: ${realMs.toFixed(3)} ms`);
    assert.ok(blankMs < 1000, `${blankMs} ms`);
  });
});

describe('captureScreenshot failures', () => {
  const failure = async (code) => {
    await assert.rejects(captureService.captureScreenshot(), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message, CAPTURE_FAILURES[code]);
      return true;
    });
  };

  it('fails with NO_SOURCES when there is nothing to capture', async () => {
    sources = [];
    await failure('NO_SOURCES');
  });

  it('fails with EMPTY_IMAGE for a missing or empty thumbnail', async () => {
    sources = [source(null)];
    await failure('EMPTY_IMAGE');
    sources = [source(fakeImage(bitmap(8, [255, 255, 255, 255]), { empty: true }))];
    await failure('EMPTY_IMAGE');
  });

  it('fails with BLANK_IMAGE for an all-black or transparent thumbnail', async () => {
    sources = [source(fakeImage(bitmap(8)))];
    await failure('BLANK_IMAGE');
    sources = [source(fakeImage(bitmap(8, [90, 90, 90, 0])))];
    await failure('BLANK_IMAGE');
    assert.ok(warnings.some((w) => w.message === 'Screen capture came back blank'));
  });

  it('returns a real screenshot, and captureAndProcess frees itself after a failure', async () => {
    sources = [source(fakeImage(bitmap(8)))];
    await assert.rejects(captureService.captureAndProcess(), { code: 'BLANK_IMAGE' });
    assert.equal(captureService.isProcessing, false);
    const pixels = bitmap(8);
    pixels.set([255, 255, 255, 255], 8);
    sources = [source(fakeImage(pixels))];
    const result = await captureService.captureAndProcess();
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.imageBuffer.toString(), 'png');
  });
});

describe('Screen capture error messages', () => {
  const mac = (screenAccess, reason, extra = {}) =>
    describeCaptureError(reason ? CAPTURE_FAILURES[reason] : 'Something else broke', { platform: 'darwin', screenAccess, reason, ...extra });

  it('calls a capture with nothing in it a stale grant when macOS says granted', () => {
    for (const reason of Object.keys(CAPTURE_FAILURES)) {
      const info = mac('granted', reason);
      assert.equal(info.problem, 'stale-grant', reason);
      assert.equal(info.action, SCREEN_RECORDING_ACTION);
      assert.equal(info.copyText, SCREEN_RECORDING_RESET_COMMAND);
      assert.match(info.message, /earlier version/);
      assert.match(info.message, /Open Screen Recording Settings/);
      assert.match(info.message, /remove it with \*\*–\*\*/);
      assert.match(info.message, /press Screenshot so macOS asks again/);
      assert.match(info.message, /Quit and restart Cuewell/);
      assert.ok(info.message.includes(`\`${SCREEN_RECORDING_RESET_COMMAND}\``));
    }
    assert.match(mac('granted', 'BLANK_IMAGE').message, /came back blank.*locked or asleep/s);
    assert.doesNotMatch(mac('granted', 'NO_SOURCES').message, /locked or asleep/);
  });

  it('recognises the failures by message when the code is lost', () => {
    for (const message of Object.values(CAPTURE_FAILURES)) {
      assert.equal(screenRecordingProblem(message, { platform: 'darwin', screenAccess: 'granted' }), 'stale-grant', message);
    }
    assert.equal(screenRecordingProblem('No screen sources available for capture', { platform: 'darwin' }), 'denied');
  });

  it('says denied, with the same fix, when macOS refuses (even for other errors)', () => {
    for (const status of ['denied', 'restricted']) {
      for (const reason of [undefined, 'NO_SOURCES', 'BLANK_IMAGE']) {
        const info = mac(status, reason);
        assert.equal(info.problem, 'denied', `${status} ${reason}`);
        assert.equal(info.action, SCREEN_RECORDING_ACTION);
        assert.match(info.message, /does not let Cuewell record the screen/);
        assert.match(info.message, /already turned on.*earlier version/);
        assert.match(info.message, /remove it with/);
      }
    }
    assert.equal(mac(undefined, 'EMPTY_IMAGE').problem, 'denied', 'status unknown');
  });

  it('asks to allow when macOS has not asked yet, without the reset command', () => {
    const info = mac('not-determined', 'NO_SOURCES');
    assert.equal(info.problem, 'not-determined');
    assert.equal(info.action, SCREEN_RECORDING_ACTION);
    assert.equal(info.copyText, null);
    assert.match(info.message, /choose Allow/);
    assert.match(info.message, /Add Cuewell with \*\*\+\*\*/);
    assert.doesNotMatch(info.message, /tccutil/);
  });

  it('keeps the general message for other failures while permission is granted', () => {
    const info = mac('granted');
    assert.equal(info.problem, null);
    assert.equal(info.action, null);
    assert.equal(info.copyText, null);
    assert.match(info.message, /^Screen capture failed\. Try again\./);
  });

  it('points at the terminal or editor when running from source', () => {
    const info = mac('denied', 'NO_SOURCES', { packaged: false });
    assert.equal(info.action, SCREEN_RECORDING_ACTION);
    assert.equal(info.copyText, null);
    assert.match(info.message, /terminal or editor/);
    assert.doesNotMatch(info.message, /tccutil|earlier version/);
  });

  it('has no button or macOS steps on Windows and Linux', () => {
    for (const platform of ['win32', 'linux']) {
      for (const reason of Object.keys(CAPTURE_FAILURES)) {
        const info = describeCaptureError(CAPTURE_FAILURES[reason], { platform, screenAccess: 'granted', reason });
        assert.equal(info.problem, null);
        assert.equal(info.action, null);
        assert.doesNotMatch(info.message, /Screen Recording|tccutil/);
      }
    }
    assert.match(friendlyCaptureError('x', { platform: 'linux' }), /Wayland/);
  });

  it('reports a capture already running plainly', () => {
    const busy = describeCaptureError('Capture already in progress', { platform: 'darwin', screenAccess: 'denied' });
    assert.deepEqual(busy, { message: 'A screenshot is already being taken.', problem: null, action: null, copyText: null });
  });

  it('friendlyCaptureError returns the same message', () => {
    const options = { platform: 'darwin', screenAccess: 'granted', reason: 'BLANK_IMAGE' };
    assert.equal(friendlyCaptureError(CAPTURE_FAILURES.BLANK_IMAGE, options), describeCaptureError(CAPTURE_FAILURES.BLANK_IMAGE, options).message);
  });

  it('names the real bundle id and the Screen Recording settings page', () => {
    assert.equal(MAC_BUNDLE_ID, require('../package.json').build.appId);
    assert.equal(SCREEN_RECORDING_RESET_COMMAND, `tccutil reset ScreenCapture ${MAC_BUNDLE_ID}`);
    assert.equal(SCREEN_RECORDING_SETTINGS_URL, 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });
});

describe('answer window buttons (answer-page.js)', () => {
  const PAGE = 'src/ui/answer-page.js';
  const constants = {
    SCREEN_RECORDING_ACTION: loadConstant(PAGE, 'SCREEN_RECORDING_ACTION'),
    MAX_COPY_TEXT_LENGTH: loadConstant(PAGE, 'MAX_COPY_TEXT_LENGTH'),
  };
  const errorActions = (api) => loadFunction(PAGE, 'errorActions', { window: { electronAPI: api }, ...constants });
  const api = { openScreenRecordingSettings: () => {} };

  it('uses the same action name as main', () => {
    assert.equal(constants.SCREEN_RECORDING_ACTION, SCREEN_RECORDING_ACTION);
  });

  it('offers the buttons only for the known action and when the API has the method', () => {
    assert.deepEqual(errorActions(api)(SCREEN_RECORDING_ACTION, 'tccutil reset X'),
      { action: SCREEN_RECORDING_ACTION, copyText: 'tccutil reset X' });
    assert.equal(errorActions(api)('open-anything', 'x'), null);
    assert.equal(errorActions(api)(undefined, undefined), null);
    assert.equal(errorActions({})(SCREEN_RECORDING_ACTION, 'x'), null);
    assert.equal(errorActions(undefined)(SCREEN_RECORDING_ACTION, 'x'), null);
  });

  it('drops a copy text that is not a short string', () => {
    for (const bad of [null, 42, '', 'x'.repeat(constants.MAX_COPY_TEXT_LENGTH + 1)]) {
      assert.equal(errorActions(api)(SCREEN_RECORDING_ACTION, bad).copyText, null);
    }
  });

  it('shows the buttons with the error and redraws when they change', () => {
    const calls = { render: [], actions: [] };
    const showFinal = loadFunction(PAGE, 'showFinal', {
      stream: null, endStream: () => {}, stopSlowHint: () => {},
      renderAnswer: (body, options) => calls.render.push({ body, isError: options.isError }),
      appendErrorActions: (actions) => calls.actions.push(actions),
      errorActions: errorActions(api),
      setView: () => {}, setStatusLabel: () => {},
      shownFinalKey: null,
      view: 'answer', EMPTY_ANSWER_MESSAGE: 'empty', STOPPED_EMPTY_MESSAGE: 'stopped',
    });
    assert.equal(showFinal('Steps', true, { action: SCREEN_RECORDING_ACTION, copyText: 'cmd' }), true);
    assert.deepEqual(calls.actions, [{ action: SCREEN_RECORDING_ACTION, copyText: 'cmd' }]);
    // An answer never gets buttons, even if asked.
    assert.equal(showFinal('An answer', false, { action: SCREEN_RECORDING_ACTION }), true);
    assert.equal(calls.actions.length, 1);
    assert.equal(calls.render.length, 2);
  });

  it('removes old buttons before drawing, and the CSS keeps them on the ruling', () => {
    const source = readSource(PAGE);
    assert.match(source, /querySelectorAll\('\.answer-actions'\)\.forEach\(el => el\.remove\(\)\)/);
    assert.match(readSource('src/styles/answer.css'), /\.answer-actions \{[^}]*min-height: calc\(2 \* var\(--lh-rule\)\);/);
  });
});
