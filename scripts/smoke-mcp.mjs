#!/usr/bin/env node
// Post-deploy smoke test for the HOSTED MCP route (`/api/mcp`).
//
// Why this exists: the mcp-server runs in two runtimes — the standalone npm
// package AND bundled into the portal's /api/mcp Astro route. A change that
// only breaks the BUNDLE (e.g. a runtime `require('../package.json')` that
// doesn't resolve there) throws at module load and 500s the whole hosted MCP,
// while the stdio package keeps working — so it ships unnoticed. This catches
// that class: a crashed route returns 5xx; a healthy route returns a structured
// response (401 when unauthed, or a JSON-RPC initialize result when authed).
//
// Usage:
//   node scripts/smoke-mcp.mjs <base-url> [--key <api-key>]
//   node scripts/smoke-mcp.mjs https://app.typeroll.com
//   SMOKE_BASE_URL=… MCP_SMOKE_API_KEY=… node scripts/smoke-mcp.mjs
// Exit 0 = healthy, non-zero = failure (so CI fails the deploy).

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith('--')) || process.env.SMOKE_BASE_URL || '').trim();
if (!base) {
  console.error('usage: node scripts/smoke-mcp.mjs <base-url> [--key <api-key>]');
  process.exit(2);
}
const keyIdx = args.indexOf('--key');
const apiKey = (keyIdx > -1 ? args[keyIdx + 1] : process.env.MCP_SMOKE_API_KEY) || '';
const url = base.replace(/\/+$/, '') + '/api/mcp';

const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'tr-smoke', version: '0' },
  },
});

const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
};

function fail(msg, detail) {
  console.error(`SMOKE FAIL (${url}): ${msg}`);
  if (detail) console.error('  ' + String(detail).slice(0, 300).replace(/\n/g, ' '));
  process.exit(1);
}

const ATTEMPTS = 8;
const DELAY_MS = 5000;
let last = null;

for (let i = 1; i <= ATTEMPTS; i++) {
  try {
    const res = await fetch(url, { method: 'POST', headers, body: initBody });
    const text = await res.text();
    last = { status: res.status, text };
    console.log(`attempt ${i}/${ATTEMPTS}: HTTP ${res.status}`);
    // 5xx = the route crashed (module-load failure, etc.) — retry for cold
    // start / new-revision propagation, then fail if it persists.
    if (res.status < 500) break;
  } catch (e) {
    last = { status: 0, text: String(e) };
    console.log(`attempt ${i}/${ATTEMPTS}: network error ${last.text.slice(0, 80)}`);
  }
  if (i < ATTEMPTS) await new Promise((r) => setTimeout(r, DELAY_MS));
}

if (!last || last.status >= 500 || last.status === 0) {
  fail(`route returned ${last?.status} — it likely crashed at module load`, last?.text);
}

// A healthy route returns STRUCTURED output (JSON or SSE), never an HTML error page.
const t = last.text.trimStart();
const structured = t.startsWith('{') || t.startsWith('[') || t.includes('"jsonrpc"') || /^event:/m.test(t);
if (!structured) fail(`body is not structured JSON/SSE (status ${last.status})`, last.text);

if (apiKey) {
  if (last.status !== 200) fail(`authed initialize returned ${last.status}`, last.text);
  if (!last.text.includes('serverInfo') && !last.text.includes('protocolVersion')) {
    fail('authed initialize is missing serverInfo/protocolVersion', last.text);
  }
  console.log(`SMOKE OK (authed): /api/mcp initialize returned a valid MCP result.`);
} else {
  // Unauthed: 401 (or any non-5xx structured response) proves the route LOADS
  // — which is exactly the regression class we care about.
  console.log(`SMOKE OK: /api/mcp loads and responds (HTTP ${last.status}); module did not crash at load.`);
}
