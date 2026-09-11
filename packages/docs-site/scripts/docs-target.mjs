export function docsTarget(env = process.env) {
  const mode = env.TYPEROLL_DOCS_TARGET ?? 'subdomain';
  if (!['subdomain', 'subdirectory'].includes(mode)) throw new Error('Unknown documentation target');
  const subdirectory = mode === 'subdirectory';
  return {
    mode,
    site: subdirectory ? 'https://typeroll.com' : 'https://docs.typeroll.com',
    base: subdirectory ? '/docs/' : '/',
    publicUrl: subdirectory ? 'https://typeroll.com/docs/' : 'https://docs.typeroll.com/',
    output: subdirectory ? '../../temp/docs-subdirectory' : './dist',
  };
}
