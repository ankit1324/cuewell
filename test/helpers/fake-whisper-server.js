'use strict';
// A stand-in for whisper.cpp's `whisper-server`, run as a real child process
// by test/whispercpp-engine.test.js. It takes the same arguments the engine
// passes (-m <model> --host <h> --port <p> --request-path <secret> -t <n> -nt)
// and answers GET <secret>/health and POST <secret>/inference (multipart)
// like the real server. Everything else is a 404.
//
// Environment:
//   FAKE_WHISPER_LOG      JSON-lines file: one line per start and per request
//   FAKE_WHISPER_TEXT     transcript to return (default "hello world")
//   FAKE_WHISPER_MARKER   file used by the CRASH_ONCE audio below
//   FAKE_WHISPER_LOAD_MS  how long /health answers 503 ("loading model")
//   FAKE_WHISPER_BIND_DELAY_MS  wait this long before binding the port
//   FAKE_WHISPER_NO_BIND  "1": keep running but never bind or print anything,
//                         like a server still loading its model
//
// Binding works like whisper-server b5907: on success it prints
// "whisper server listening at http://<host>:<port>" on stdout (and logs a
// "listening" event); on failure it prints "couldn't bind to server socket:
// hostname=<host> port=<port>" on stderr and exits with code 1.
//
// The uploaded audio can carry a directive instead of WAV data:
//   "delay:<ms>"   answer after <ms>
//   "CRASH_ONCE"   exit in the middle of the request, unless the marker file
//                  exists (it is created first), so a restarted server answers
//   "ERROR"        answer 500
//
// Like the real server it prints the transcript (stdout and stderr), so
// tests can check the engine never keeps or logs it.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
}

const model = arg('-m');
const host = arg('--host');
const port = Number(arg('--port'));
const requestPath = arg('--request-path') || '';
const logFile = process.env.FAKE_WHISPER_LOG || '';
const text = process.env.FAKE_WHISPER_TEXT || 'hello world';
const loadMs = Number(process.env.FAKE_WHISPER_LOAD_MS || 50);

function log(entry) {
  if (logFile) fs.appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}

// The engine runs the server with cwd = the model folder and -m <file name>.
if (!model || !fs.existsSync(path.resolve(process.cwd(), model))) {
  process.stderr.write(`error: failed to open '${model}'\nerror: failed to load model\n`);
  process.exit(3);
}
const modelText = fs.readFileSync(path.resolve(process.cwd(), model), 'utf8');
if (modelText.startsWith('BAD')) {
  process.stderr.write('whisper_init_from_file: invalid model data\nerror: failed to load model\n');
  process.exit(3);
}

log({ event: 'start', args: process.argv.slice(2), cwd: process.cwd(), host, port });

const loadedAt = Date.now() + loadMs;
let inflight = 0;

const server = http.createServer((req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === `${requestPath}/health`) {
    if (Date.now() < loadedAt) reply(503, { status: 'loading model' });
    else reply(200, { status: 'ok' });
    return;
  }
  if (req.method !== 'POST' || req.url !== `${requestPath}/inference`) {
    reply(404, { error: 'not found' });
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const seenInflight = inflight;
    inflight += 1;
    try {
      const form = await new Response(Buffer.concat(chunks), {
        headers: { 'content-type': req.headers['content-type'] || '' },
      }).formData();
      const file = form.get('file');
      const audio = Buffer.from(await file.arrayBuffer());
      const audioText = audio.toString('latin1');
      log({
        event: 'inference',
        inflight: seenInflight,
        fileName: file.name,
        bytes: audio.length,
        audio: audioText.slice(0, 40),
        language: form.get('language'),
        prompt: form.get('prompt'),
        response_format: form.get('response_format'),
        temperature: form.get('temperature'),
        no_timestamps: form.get('no_timestamps'),
      });
      if (audioText === 'CRASH_ONCE') {
        const marker = process.env.FAKE_WHISPER_MARKER;
        if (marker && !fs.existsSync(marker)) {
          fs.writeFileSync(marker, 'crashed');
          process.exit(1);
        }
      }
      const delay = /^delay:(\d+)$/.exec(audioText);
      if (delay) await new Promise((r) => setTimeout(r, Number(delay[1])));
      if (audioText === 'ERROR') {
        reply(500, { error: 'failed to process audio' });
        return;
      }
      process.stdout.write(`[00:00.000 --> 00:01.000] ${text}\n`);
      process.stderr.write(`transcript: ${text}\n`);
      reply(200, { text: ` ${text}\n` });
    } catch (error) {
      reply(400, { error: error.message });
    } finally {
      inflight -= 1;
    }
  });
});

function bind() {
  server.once('error', (error) => {
    process.stderr.write(`\ncouldn't bind to server socket: hostname=${host} port=${port}\n\n`);
    log({ event: 'bind-failed', port, code: error.code });
    process.exit(1);
  });
  server.listen(port, host, () => {
    log({ event: 'listening', port });
    process.stdout.write(`\nwhisper server listening at http://${host}:${port}\n\n`);
  });
}

const bindDelayMs = Number(process.env.FAKE_WHISPER_BIND_DELAY_MS || 0);
if (process.env.FAKE_WHISPER_NO_BIND === '1') setInterval(() => {}, 1000); // stay alive
else if (bindDelayMs > 0) setTimeout(bind, bindDelayMs);
else bind();
process.on('SIGTERM', () => process.exit(0));
