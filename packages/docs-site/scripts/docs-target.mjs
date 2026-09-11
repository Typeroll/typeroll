export function docsTarget(env = process.env) {
  if (env.TYPEROLL_DOCS_TARGET && env.TYPEROLL_DOCS_TARGET !== 'subdirectory') {
    throw new Error('Documentation is only published at https://typeroll.com/docs/');
  }
  return {
    mode: 'subdirectory',
    site: 'https://typeroll.com',
    base: '/docs/',
    publicUrl: 'https://typeroll.com/docs/',
    output: '../../temp/docs-subdirectory',
  };
}
