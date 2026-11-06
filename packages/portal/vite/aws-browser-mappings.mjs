import fs from 'node:fs';
import path from 'node:path';

// The AWS SDK and its Smithy packages swap Node-only files for fetch-based
// ones through the package.json "browser" field (runtime configuration, HTTP
// handler, stream utilities). The Workers build does not apply that field,
// while @aws-sdk/core resolves its "browser" export condition, so a build mixes
// both and `new S3Client()` or reading a response throws on workerd. Apply the
// "browser" file mappings of those packages, the variant workerd runs.
export const AWS_PACKAGE = /^(@aws-sdk|@smithy|@aws-crypto)\//;
const packageOf = new Map();
function owningPackage(file) {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir)) {
    if (packageOf.has(dir)) return packageOf.get(dir);
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const json = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const value = json.name ? { dir, name: json.name, browser: typeof json.browser === 'object' && json.browser ? json.browser : null } : null;
      if (value) { packageOf.set(dir, value); return value; }
    }
    dir = path.dirname(dir);
  }
  return null;
}
export const awsBrowserMappings = {
  name: 'typeroll-aws-sdk-browser-mappings',
  enforce: 'pre',
  async resolveId(source, importer, options) {
    if (!importer || !/[\\/]node_modules[\\/]/.test(importer) && !AWS_PACKAGE.test(source)) return null;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
    if (!resolved || resolved.external || !path.isAbsolute(resolved.id.split('?')[0])) return resolved;
    const file = resolved.id.split('?')[0], owner = owningPackage(file);
    if (!owner || !AWS_PACKAGE.test(owner.name) || !owner.browser) return resolved;
    const relative = './' + path.relative(owner.dir, file).split(path.sep).join('/');
    for (const key of [relative, relative.replace(/\.js$/, '')]) {
      const target = owner.browser[key];
      if (typeof target === 'string') {
        const mapped = path.resolve(owner.dir, target);
        return { ...resolved, id: fs.existsSync(mapped) ? mapped : `${mapped}.js` };
      }
    }
    return resolved;
  },
};
