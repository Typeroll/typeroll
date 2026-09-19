#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export function releaseCheckCommands({ docsOnly = false } = {}) {
  const docs = [
    [npm, ["run", "check", "--workspace=@typeroll/docs-site"]],
    [npm, ["run", "format:check", "--workspace=@typeroll/docs-site"]],
    [npm, ["run", "build:docs"]],
  ];

  if (docsOnly) return docs;

  return [
    [npm, ["run", "release:plan"]],
    [npm, ["run", "security:audit"]],
    docs[0],
    docs[1],
    [npm, ["run", "typecheck"]],
    [npm, ["test"]],
    [process.execPath, ["scripts/build-static-publication-template.mjs"]],
    [npm, ["run", "build"]],
  ];
}

export function runReleaseChecks(options = {}) {
  for (const [command, args] of releaseCheckCommands(options)) {
    console.log(`\n> ${command} ${args.join(" ")}`);
    const result = spawnSync(command, args, {
      cwd: root,
      stdio: "inherit",
      env: options.releaseArtifacts ? { ...process.env, TYPEROLL_DOCS_TARGET: "subdirectory" } : process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  if (options.releaseArtifacts) {
    for (const args of [["packages/docs-site/scripts/prepare-migration.mjs", "--reuse-build"], ["scripts/release-artifact.mjs", "seal", "temp/docs-migration"]]) {
      const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      "release-artifacts": { type: "boolean", default: false },
      "docs-only": { type: "boolean", default: false },
    },
  });
  runReleaseChecks({ docsOnly: values["docs-only"], releaseArtifacts: values["release-artifacts"] });
}
