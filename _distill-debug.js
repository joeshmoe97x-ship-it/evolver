'use strict';
const fs = require('fs');
fs.mkdirSync('/tmp/distill-debug-' + process.pid, { recursive: true });
process.env.EVOLVER_SETTINGS_DIR = '/tmp/distill-debug-' + process.pid;

const convergent = (n) => '   '.repeat(n) + n;
try {
  const m = require('./src/gep/conversationDistiller');
  console.log('=== require resolved OK; exported names:', Object.keys(m));
  console.log();
} catch (e) {
  console.log('=== require FAILED');
  console.log('  name:', e.name);
  console.log('  message:', e.message);
  console.log('  code:', e.code);
  console.log('  stack:');
  console.log((e.stack || '').split('\n').slice(0, 12).join('\n'));
  console.log();
  process.exit(1);
}

const { distillConversation } = require('./src/gep/conversationDistiller');

const validConversation = {
  summary: 'Reusable Evolver distill endpoint compatibility workflow for MCP plugin bridges.',
  assistant_summary: 'Added a Proxy conversation distillation bridge so Codex, Claude Code, Cursor, WorkBuddy, and Antigravity plugins can publish Genes and Capsules without hitting a 404.',
  strategy: [
    'Verify each plugin bridge calls the same Proxy route before changing repository code.',
    'Keep the Proxy route on the current signed asset publish path instead of the old mailbox submit path.',
    'Add focused tests for draft distillation, publish forwarding, and low quality skipped inputs.',
  ],
  artifacts: ['src/proxy/server/routes.js', 'src/gep/conversationDistiller.js'],
  validation: ['node --test test/proxyServer.test.js'],
  signals: ['distill_endpoint', 'proxy_compatibility', 'test_verified'],
};

const cases = [
  { name: '1 draft (persist:false, publish:false)', input: Object.assign({}, validConversation, { persist: false, publish: false }), opts: { persist: false } },
  { name: '2 publish (persist:false, publish default)', input: Object.assign({}, validConversation, { persist: false }), opts: { persist: false } },
  { name: '3 skipped (short summary)', input: { summary: 'too short', publish: false }, opts: { persist: true  } },
];

for (const c of cases) {
  try {
    const r = distillConversation(c.input, c.opts);
    console.log('=== [' + c.name + '] OK');
    console.log('  ok:', r.ok, ' status:', r.status, ' reason:', r.reason || '(none)');
  } catch (e) {
    console.log('=== [' + c.name + '] THREW');
    console.log('  name:', e && e.name);
    console.log('  message:', ((e && e.message) || '').slice(0, 300));
    console.log('  code:', e && e.code);
    console.log('  stack top:');
    console.log(((e && e.stack) || '').split('\n').slice(0, 14).join('\n'));
  }
  console.log();
}
