import { ConnectionError } from './connections';

export type R2VerificationStep = 'write' | 'read' | 'delete';
const advice = {
  AccessDenied: 'Cloudflare denied this operation. Check that the R2 token has Object Read & Write access to this bucket. The response does not identify which permission or token restriction caused the denial.',
  InvalidAccessKeyId: 'Cloudflare did not recognize the Access Key ID for the connected account. Check the Account ID and the Access Key ID from the R2 token.',
  SignatureDoesNotMatch: 'Cloudflare rejected the request signature. Check that the Access Key ID and Secret Access Key are the matching pair from the same R2 token. If they are, contact support to investigate request signing.',
  NoSuchBucket: 'Cloudflare could not find this bucket in the connected account. Check the account and bucket in Publishing settings.',
  ExpiredToken: 'Cloudflare reports that the credentials have expired. Replace them with an active R2 token’s Access Key ID and Secret Access Key.',
  InvalidToken: 'Cloudflare reports an invalid token. Check that these are the two S3 keys from an active R2 token.',
  RequestTimeTooSkewed: 'Cloudflare rejected the server clock. Contact Typeroll support; creating another key will not correct the server clock.',
  ContentMismatch: 'The test file was read back with unexpected content. Retry; if this continues, contact support.',
  TimeoutError: 'The R2 request timed out. Retry with the same keys; this does not establish that the keys are invalid.',
  AbortError: 'The R2 request timed out or was interrupted. Retry with the same keys.',
  ENOTFOUND: 'The server could not resolve the R2 address. Retry; if this continues, contact support.',
  EAI_AGAIN: 'The server could not resolve the R2 address. Retry with the same keys.',
  ECONNRESET: 'The connection to R2 was interrupted. Retry with the same keys.',
  ETIMEDOUT: 'The connection to R2 timed out. Retry with the same keys.',
  ECONNREFUSED: 'The server could not connect to R2. Retry; if this continues, contact support.',
  InternalError: 'Cloudflare reported an internal error. Retry with the same keys.',
  ServiceUnavailable: 'Cloudflare R2 is temporarily unavailable. Retry with the same keys.',
  SlowDown: 'Cloudflare is limiting requests. Wait briefly and retry with the same keys.',
} as const;

export interface R2VerificationDiagnostic {
  step: R2VerificationStep;
  provider_code: keyof typeof advice | 'Unknown';
  http_status: number | null;
}

/** Never forward provider messages, URLs, headers or arbitrary error properties. */
export function r2Diagnostic(step: R2VerificationStep, error: unknown): R2VerificationDiagnostic {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } } : {};
  const code = [value.name, value.code].find(candidate => typeof candidate === 'string' && Object.hasOwn(advice, candidate));
  const status = value.$metadata?.httpStatusCode;
  return { step, provider_code: code as keyof typeof advice | undefined ?? 'Unknown',
    http_status: typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : null };
}

export class R2VerificationError extends ConnectionError {
  constructor(public diagnostic: R2VerificationDiagnostic & { bucket: string; account_id: string; cleanup_failure?: R2VerificationDiagnostic }) {
    const { step, bucket, account_id, provider_code, http_status, cleanup_failure } = diagnostic;
    const action = { write: 'write a test file to', read: 'read the test file from', delete: 'delete the test file from' }[step];
    const reason = provider_code === 'Unknown'
      ? http_status === 403 ? advice.AccessDenied
        : http_status === 429 ? advice.SlowDown
          : http_status && http_status >= 500 ? advice.ServiceUnavailable
            : 'The provider did not return a recognized error code. Retry with the same keys; if this continues, contact support.'
      : advice[provider_code];
    super(`R2 verification failed: could not ${action} bucket ${bucket} (account ${account_id}). ${provider_code === 'Unknown' ? 'No recognized R2 error code' : provider_code}${http_status ? `, HTTP ${http_status}` : ''}. ${reason}${cleanup_failure ? ` Cleanup also failed (${cleanup_failure.provider_code}${cleanup_failure.http_status ? `, HTTP ${cleanup_failure.http_status}` : ''}); a temporary connection-check file may remain.` : ''} These submitted keys have not been saved.`, 502, 'r2_verification_failed');
  }
}
