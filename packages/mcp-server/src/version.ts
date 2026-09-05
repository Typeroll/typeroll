// Server version reported in the MCP `initialize` handshake.
//
// MUST be a plain literal — NOT a runtime `require('../package.json')`. This
// module is bundled into the portal's /api/mcp route (hosted MCP), where
// `import.meta.url` points at the bundled file and `../package.json` does not
// resolve — a require there throws at module load and 500s the whole route.
// The literal works in every context (standalone npm package + bundled portal).
//
// Keep it in lockstep with package.json: tests/version.test.ts asserts
// VERSION === package.json.version, so a bump that forgets this line fails CI.
export const VERSION = '0.42.2';
