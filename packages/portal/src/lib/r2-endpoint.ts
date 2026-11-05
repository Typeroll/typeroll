// S3 endpoint of an R2 bucket. Buckets created in the EU jurisdiction are only
// reachable through the `<account>.eu.` endpoint. Typeroll's own platform
// buckets that live in the EU are listed in R2_EU_BUCKETS (comma separated),
// so a pre-existing default-jurisdiction bucket keeps working until it is
// moved.

export function r2Endpoint(accountId: string, bucket?: string, env: Record<string, string | undefined> = process.env): string {
  const eu = !!bucket && (env.R2_EU_BUCKETS ?? '').split(',').map(name => name.trim()).filter(Boolean).includes(bucket);
  return `https://${accountId}.${eu ? 'eu.' : ''}r2.cloudflarestorage.com`;
}
