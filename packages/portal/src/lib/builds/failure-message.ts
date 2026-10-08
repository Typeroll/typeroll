import type { BuildDiagnostic } from './diagnostics.mjs';

/**
 * The sentence a person reads when a build fails, from the reported code and
 * whatever the failed step printed.
 *
 * Reported codes are `<stage>_<reason>`, e.g. `media_build_process_exit_1`.
 * Every one of them used to read "Check the build log, then retry publishing",
 * which names neither the step nor the cause, and the build log is in an
 * account the reader usually cannot open. The step, the reason and the cause
 * line now travel together; the code stays at the end so a report can be
 * matched to its source.
 */

const STAGES: Record<string, string> = {
  extension_assets: 'preparing Extension assets',
  dependencies: 'installing the site’s build dependencies',
  verification: 'verifying the built files',
  rendering: 'rendering the static pages',
  artifact: 'uploading the built site',
  uploader: 'checking the static uploader',
  sandbox: 'preparing the build sandbox',
  source: 'downloading the frozen site source',
  media: 'preparing images and files',
};

type Reason = { text: string; action?: string };
const REASONS: Array<[RegExp, (match: RegExpMatchArray) => Reason]> = [
  [/^build_process_timeout$/, () => ({ text: 'the step did not finish within its time limit.' })],
  [/^build_process_exit_(\d+)$/, match => ({ text: `the step exited with code ${match[1]}.` })],
  [/^build_process_exit_terminated$/, () => ({ text: 'the step was terminated before it finished.' })],
  [/^build_process_start_failed$/, () => ({ text: 'the step could not be started on the build machine.' })],
  [/^build_enospc$/, () => ({ text: 'the build machine ran out of disk space.', action: 'Reduce the published files or media, then retry publishing.' })],
  [/^build_enomem$/, () => ({ text: 'the build machine ran out of memory.', action: 'Reduce the size of the largest pages or images, then retry publishing.' })],
  [/^build_(?:err_)?module_not_found$/, () => ({ text: 'a module the build imports could not be found.' })],
  [/^build_err_dlopen_failed$/, () => ({ text: 'a native module, such as the image encoder, could not be loaded on the build machine.' })],
  [/^build_eacces$/, () => ({ text: 'the build was denied access to a file.' })],
  [/^build_enoent$/, () => ({ text: 'a file the build needs does not exist.' })],
  [/^build_err_system_error$/, () => ({ text: 'the build machine reported a system error.' })],
  [/^media_transfer_interrupted$/, () => ({ text: 'transfers to and from media storage kept failing.', action: 'Retry publishing. Prepared images are kept.' })],
  [/^build_lease_lost$/, () => ({ text: 'the build lost its connection to Typeroll.' })],
  [/^coordinator_(\d{3})$/, match => ({ text: `Typeroll’s build coordinator answered HTTP ${match[1]}.` })],
  [/^build_transfer_(?:failed|limit)$/, () => ({ text: 'a build input could not be downloaded.' })],
  [/^artifact_upload_failed$/, () => ({ text: 'the built site could not be uploaded to build storage.' })],
  [/^static_output_size_limit$/, () => ({ text: 'the finished site exceeds the static output limit or contains a file larger than 25 MiB.', action: 'Reduce the published files, then retry publishing.' })],
  [/^(?:invalid_static_path|invalid_static_file|unsafe_build_output)$/, () => ({ text: 'the build produced a file that cannot be published.' })],
  [/^publication_validation_failed$/, () => ({ text: 'the built pages failed publication validation.', action: 'Fix the reported pages, then publish again.' })],
  [/^publication_report_too_large$/, () => ({ text: 'the publication validation report was too large to return.', action: 'Fix the pages with the most validation errors, then publish again.' })],
  [/^(?:unsupported_build_runtime|invalid_pages_upload_grant|artifact_format_unsupported)$/, () => ({ text: 'the build engine is older than this version of Typeroll.', action: 'Update the build engine in Publishing → Builds, then retry publishing.' })],
  [/^(?:\w+_scope_mismatch|media_materialization_incomplete)$/, () => ({ text: 'the prepared media did not match the frozen publication.' })],
  [/^reserved_build_source$/, () => ({ text: 'the site source uses a path reserved for the build engine.' })],
  [/^build_result_missing$/, () => ({ text: 'the build engine stopped without reporting a result.' })],
  [/^build_timeout$/, () => ({ text: 'the build did not finish before its deadline.' })],
  [/^build_failed$/, () => ({ text: 'the step failed.' })],
];

export function splitFailureCode(code: string): { stage: string | null; reason: string } {
  for (const stage of Object.keys(STAGES)) if (code.startsWith(`${stage}_`)) return { stage, reason: code.slice(stage.length + 1) };
  return { stage: null, reason: code };
}

function withCause(message: string, diagnostic?: BuildDiagnostic | null) {
  if (!diagnostic?.cause) return message;
  return `${message} Cause: ${diagnostic.cause}${/[.!?]$/.test(diagnostic.cause) ? '' : '.'}`;
}

export function buildFailureMessage(code: string, diagnostic?: BuildDiagnostic | null): string {
  if (code === 'sandbox_integrity_failed')
    return withCause('The build sandbox downloaded from a pinned URL did not match its pinned checksum. This is not a transient failure and must not be retried: the bytes at that URL changed. Check the build log for the source and the checksum it served, and establish why before publishing anything.', diagnostic);
  if (code === 'sandbox_unavailable')
    return withCause('No source served the pinned build sandbox. The pinned artifact is not in question; its hosts are unreachable. Check the build log for which sources failed, then retry publishing when a host recovers.', diagnostic);
  if (code === 'build_connection_lost')
    return withCause('The build engine stopped reporting progress and this attempt can no longer finish. Check the build log, then retry publishing. No replacement build was started.', diagnostic);
  const { stage, reason } = splitFailureCode(code);
  const known = REASONS.map(([pattern, describe]) => { const match = reason.match(pattern); return match && describe(match); }).find(Boolean);
  const action = known?.action ?? (diagnostic?.cause ? 'Resolve the cause, then retry publishing.' : 'Check the build log, then retry publishing.');
  if (!known && !stage) return `${withCause('The build engine reported a failed or cancelled attempt.', diagnostic)} ${action} (${code})`;
  const what = known?.text ?? 'the step failed.';
  const sentence = stage ? `The build failed while ${STAGES[stage]}: ${what}` : `The build failed: ${what}`;
  return `${withCause(sentence, diagnostic)} ${action} (${code})`;
}
