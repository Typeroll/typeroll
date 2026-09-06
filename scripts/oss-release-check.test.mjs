import assert from "node:assert/strict";
import test from "node:test";

import { releaseCheckCommands } from "./oss-release-check.mjs";

function descriptions(options) {
  return releaseCheckCommands(options).map(
    ([command, args]) => `${command} ${args.join(" ")}`,
  );
}

test("the release check validates every publishable surface in fail-fast order", () => {
  assert.deepEqual(descriptions(), [
    "npm run release:plan",
    "npm run security:audit",
    "npm run check --workspace=@typeroll/docs-site",
    "npm run format:check --workspace=@typeroll/docs-site",
    "npm run typecheck",
    "npm test",
    "npm run build",
  ]);
});

test("the docs preflight uses the same format and build commands", () => {
  assert.deepEqual(descriptions({ docsOnly: true }), [
    "npm run check --workspace=@typeroll/docs-site",
    "npm run format:check --workspace=@typeroll/docs-site",
    "npm run build:docs",
  ]);
});
