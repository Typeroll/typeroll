import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

let loaded;
/** Execute the same pure migration used in portal tests, without starting a
 * portal or importing its credentials/datastore. Nothing is written to disk. */
export function loadUnifiedPagesMigration() {
  loaded ??= (async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = await build({
      absWorkingDir: root,
      stdin: {
        contents: [
          "export * from './packages/portal/src/lib/migrations/unified-site-plan';",
          "export * from './packages/portal/src/lib/migrations/unified-site-apply';",
          "export * from './packages/portal/src/lib/firestore-codec';",
        ].join('\n'),
        resolveDir: root,
        loader: 'ts',
      },
      alias: { '@typeroll/shared': `${root}packages/shared/src/index.ts` },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  })();
  return loaded;
}
