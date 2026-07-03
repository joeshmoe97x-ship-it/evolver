#!/usr/bin/env node
// Tiny local Slack receiver for `make watch`.
//
// Listens on 127.0.0.1 with a random port (so it can't conflict with
// anything), writes the chosen port to --port-file, and appends each
// POST body to --log-file (pretty-printed if it's JSON). The parent
// watch script (scripts/dev-watch.sh) tails the log file so the
// operator sees the Slack payload in real time as they edit the
// fixture.
//
// Usage:
//   node scripts/dev-slack-receiver.js \
//     --port-file=dev-fixtures/.receiver.port \
//     --log-file=dev-fixtures/receiver.log \
//     --log-prefix=[slack-receiver]

'use strict';

const http = require('node:http');
const fs = require('node:fs');

function arg(name) {
  const prefix = `--${name}=`;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
}

const portFile = arg('port-file');
const logFile = arg('log-file');
const logPrefix = arg('log-prefix') || '[slack-receiver]';

if (!portFile || !logFile) {
  console.error('Usage: dev-slack-receiver.js --port-file=... --log-file=... [--log-prefix=...]');
  process.exit(2);
}

const logStream = fs.createWriteStream(logFile, { flags: 'a' });
const writeLog = (msg) => {
  const line = `${logPrefix} ${msg}\n`;
  logStream.write(line);
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    // Pretty-print JSON payloads for readability; fall back to raw.
    let display = raw;
    if (raw.length > 0) {
      try { display = JSON.stringify(JSON.parse(raw), null, 2); } catch (_) { /* not JSON */ }
    }
    writeLog(`POST ${req.url}  (${raw.length} bytes)`);
    for (const line of display.split('\n')) writeLog(`  ${line}`);
    writeLog('---');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  req.on('error', () => { /* client-side error: ignore */ });
});

server.on('error', (err) => {
  writeLog(`server error: ${err.message}`);
  process.exit(1);
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(portFile, String(port));
  writeLog(`listening on http://127.0.0.1:${port}`);
});

// Clean shutdown — the parent script sends SIGTERM on Ctrl-C.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    writeLog(`shutting down (${sig})`);
    server.close(() => process.exit(0));
    // Hard exit if the server doesn't close cleanly.
    setTimeout(() => process.exit(0), 200).unref();
  });
}
