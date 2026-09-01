export function requireExactConfirmation(actual, supplied, label) {
  if (!supplied || supplied !== actual) {
    throw new Error(`${label} confirmation must exactly equal ${actual}`);
  }
}

export function reportError(error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
