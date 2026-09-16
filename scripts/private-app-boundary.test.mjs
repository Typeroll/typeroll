import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
export function privateAppLeaks(files) {
  const forbidden=['tr-directory','read_funnel_attribution','update_funnel_attribution','buildFunnelAttributionRuntime','Resumable census imports','apps/funnel-attribution/','apps/directory/','recipes/directory-building/','recipes/booking-link-attribution/'];
  return files.flatMap(([name,text])=>forbidden.filter(marker=>text.includes(marker)).map(marker=>`${name}: ${marker}`));
}
test('distribution guard detects a private recipe even in a generated bundle',()=>{assert.equal(privateAppLeaks([['dist/index.js','bundled = "Resumable census imports"']]).length,1);assert.deepEqual(privateAppLeaks([['docs','Use a directory of Markdown files.']]),[]);});
test('Core owns generic contracts, not private app source or guides',()=>{
 for(const file of ['packages/shared/src/funnel-attribution.ts','packages/portal/src/lib/apps/directory.ts','packages/portal/src/lib/apps/funnel-attribution.ts','packages/portal/src/lib/edit-grants.ts','packages/mcp-server/src/tools/funnel-attribution.ts','packages/mcp-server/skills/tr-directory.md','packages/docs-site/src/content/docs/apps/directory.mdx','packages/docs-site/src/content/docs/apps/funnel-attribution.mdx','docs/directory-edit-form.md','docs/funnel-attribution.md'])assert.equal(existsSync(path.join(root,file)),false,`${file} belongs to its private app`);
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
 const files=['packages/mcp-server/src/bundled-content.ts',...walk(path.join(root,'packages/docs-site/src/content/docs'))].filter(file=>/\.(mdx?|ts)$/.test(file)).map(file=>[file,readFileSync(path.resolve(root,file),'utf8')]);
 assert.deepEqual(privateAppLeaks(files),[]);
 const registry=readFileSync(path.join(root,'packages/portal/src/lib/apps/registry.ts'),'utf8');assert.doesNotMatch(registry,/directoryApp|funnelAttribution/);
});
