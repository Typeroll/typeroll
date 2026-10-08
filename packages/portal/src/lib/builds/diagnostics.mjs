/**
 * The readable cause of a failed build step.
 *
 * Build steps fail by printing an error and exiting. The supervisor used to
 * keep that output only to match a handful of system codes, then reported
 * `media_build_process_exit_1` and nothing else, so the line naming the cause
 * ("Invalid media completion receipt") never reached the build log, the job or
 * the person publishing. This module runs on the build engine and in the
 * portal: the engine prints and reports a redacted tail, and the coordinator
 * redacts it again because an engine is not trusted to have done so.
 */

export const DIAGNOSTIC_LINES = 40;
export const DIAGNOSTIC_LINE_LENGTH = 400;
export const DIAGNOSTIC_CAUSE_LENGTH = 300;

// eslint-disable-next-line no-control-regex
const CONTROL = /\x1b\[[0-9;?]*[A-Za-z]|[\x00-\x08\x0b-\x1f\x7f]/g;

/** Remove anything credential-shaped. Hex digests and commit IDs stay: they are how a failure is traced. */
export function redactDiagnosticLine(line, secrets = []) {
  let text = String(line);
  for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join('[redacted]');
  return text
    .replace(CONTROL, '')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|access_token|sig|signature|key|x-amz-[a-z-]+)=)[^&\s'"]+/gi, '$1[redacted]')
    .replace(/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|authorization|cookie)[A-Za-z0-9_]*)(["']?\s*[:=]\s*["']?)(?:(?:bearer|basic)\s+)?[^\s'",;]+/gi, '$1$2[redacted]')
    .replace(/\b(bearer|basic)\s+(?!\[redacted\])[^\s'"]+/gi, '$1 [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*[A-Z])(?=[A-Za-z0-9_+/=-]*[a-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{32,}/g, '[redacted]')
    .slice(0, DIAGNOSTIC_LINE_LENGTH);
}

/** Every string inside a credential-bearing value, so its exact text can be removed from output. */
export function secretValues(value, found = new Set()) {
  if (typeof value === 'string') {
    if (value.length >= 8) found.add(value);
    if (/^[[{]/.test(value)) { try { secretValues(JSON.parse(value), found); } catch { /* Not JSON. */ } }
  } else if (value && typeof value === 'object') for (const item of Object.values(value)) secretValues(item, found);
  return found;
}

const STACK = /^\s+at\s|^\s*\^+\s*$|^Node\.js v\d/;
const THROWN = /^(?:Uncaught\s+)?(?:[A-Z][A-Za-z]*Error|Error)(?:\s*\[[A-Z0-9_]+\])?:\s*\S/;
const FAILURE = /\b(?:error|errors|failed|failure|fatal|exception|cannot|could not|not found|exit code [1-9])\b|\bERR!/i;
const GENERIC = /^(?:build failed|failed: build command exited with code|error: exit code|npm err! a complete log|npm error a complete log|exit status \d+|TYPEROLL_BUILD_FAILED\b)/i;

/**
 * The line that names the cause: what a step threw, then a specific failure
 * line, then any failure line. A `TYPEROLL_BUILD_CAUSE` line written by the
 * supervisor wins, so a provider log names the same cause as the job.
 */
export function diagnosticCause(lines) {
  const text = lines.map(line => String(line).trim()).filter(Boolean);
  const marked = text.filter(line => line.startsWith('TYPEROLL_BUILD_CAUSE ')).at(-1);
  if (marked) return marked.slice('TYPEROLL_BUILD_CAUSE '.length).slice(0, DIAGNOSTIC_CAUSE_LENGTH);
  const content = text.filter(line => !STACK.test(line));
  const thrown = content.filter(line => THROWN.test(line)).at(-1);
  const failures = content.filter(line => FAILURE.test(line));
  const pick = thrown ?? failures.filter(line => !GENERIC.test(line)).at(-1) ?? failures.at(-1);
  return pick ? pick.slice(0, DIAGNOSTIC_CAUSE_LENGTH) : null;
}

/** A bounded, redacted account of a failed step: its cause and the last lines it printed. */
export function buildDiagnostic(output, secrets = []) {
  const lines = String(output ?? '').split(/\r?\n/).map(line => redactDiagnosticLine(line.trimEnd(), secrets)).filter(line => line.trim());
  const tail = lines.slice(-DIAGNOSTIC_LINES);
  return { cause: diagnosticCause(lines), lines: tail };
}

/** Accept a diagnostic from a build engine only in its bounded shape, redacted again. */
export function normalizeDiagnostic(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.lines)) return undefined;
  const lines = value.lines.filter(line => typeof line === 'string').slice(-DIAGNOSTIC_LINES).map(line => redactDiagnosticLine(line)).filter(line => line.trim());
  const cause = typeof value.cause === 'string' && value.cause.trim() ? redactDiagnosticLine(value.cause.trim()).slice(0, DIAGNOSTIC_CAUSE_LENGTH) : diagnosticCause(lines);
  return cause || lines.length ? { cause: cause || null, lines } : undefined;
}
