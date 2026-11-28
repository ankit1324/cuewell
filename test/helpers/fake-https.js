'use strict';
// An https.get stand-in for downloadModel's `httpGet` seam. No sockets: each
// call asks `handler(url, headers)` for a response and streams its body in
// chunks on later ticks, so a download can be cancelled part way through.
//
// handler returns { status, headers, body, chunkSize, pauseAfter, error }:
//   body        Buffer (or omitted for an empty body)
//   pauseAfter  stop sending after this many bytes and wait (for cancel tests)
//   endEarly    end the body after this many bytes (connection closed)
//   error       emit this error on the request instead of answering
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function createFakeHttpGet(handler) {
  const calls = [];
  function httpGet(url, options, callback) {
    const headers = { ...((options && options.headers) || {}) };
    const call = { url: String(url), headers, destroyed: false, sent: 0 };
    calls.push(call);
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (error) => {
      call.destroyed = true;
      if (error) req.emit('error', error);
    };

    setImmediate(() => {
      let reply;
      try {
        reply = handler(call.url, headers, calls.length) || {};
      } catch (error) {
        req.emit('error', error);
        return;
      }
      if (reply.error) {
        req.emit('error', reply.error);
        return;
      }
      const res = new PassThrough();
      res.statusCode = reply.status || 200;
      res.headers = reply.headers || {};
      const body = reply.body || Buffer.alloc(0);
      const chunkSize = reply.chunkSize || 4 * 1024 * 1024;
      const limit = reply.endEarly !== undefined ? Math.min(reply.endEarly, body.length) : body.length;
      callback(res);

      let offset = 0;
      const pump = () => {
        if (res.destroyed || call.destroyed) return;
        if (reply.pauseAfter !== undefined && offset >= reply.pauseAfter) return; // stall
        if (offset >= limit) {
          res.end();
          return;
        }
        let end = Math.min(offset + chunkSize, limit);
        if (reply.pauseAfter !== undefined) end = Math.min(end, reply.pauseAfter);
        res.write(body.subarray(offset, end));
        call.sent += end - offset;
        offset = end;
        setImmediate(pump);
      };
      setImmediate(pump);
    });
    return req;
  }
  httpGet.calls = calls;
  return httpGet;
}

module.exports = { createFakeHttpGet };
