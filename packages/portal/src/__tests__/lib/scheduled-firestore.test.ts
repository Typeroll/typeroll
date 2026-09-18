import { beforeEach, expect, it, vi } from 'vitest';
import { getStore, _resetForTests } from '../../lib/datastore';
import { workPath } from '../../lib/scheduling/index';

const backend = vi.hoisted(() => ({ docs: new Map<string, any>(), abort: false, commits: [] as string[][] }));
vi.mock('../../lib/firebase-admin', () => ({ isFirebaseAdminConfigured: () => true, getFirebaseAdminApp: async () => ({}) }));
vi.mock('firebase-admin/firestore', () => ({ getFirestore: () => {
  const snapshot = (p: string) => ({ exists: backend.docs.has(p), id: p.split('/').pop(), data: () => structuredClone(backend.docs.get(p)) });
  return {
    settings() {}, doc: (path: string) => ({path, get: async () => snapshot(path)}),
    runTransaction: async (run: (tx: any) => Promise<any>) => {
      const writes: Array<{path:string;value?:any;merge?:boolean;remove?:boolean}> = [];
      const tx = {
        get: async (ref: {path:string}) => { if(writes.length) throw Error('Read after write'); return snapshot(ref.path); },
        set: (ref:{path:string},value:any, options?:{merge?:boolean}) => writes.push({path:ref.path,value,merge:options?.merge}),
        create: (ref:{path:string},value:any) => writes.push({path:ref.path,value}),
        delete: (ref:{path:string}) => writes.push({path:ref.path,remove:true}),
      };
      const result = await run(tx);
      if(backend.abort) throw Error('transaction aborted');
      for(const write of writes) {
        if(write.remove) backend.docs.delete(write.path);
        else backend.docs.set(write.path, structuredClone(write.merge ? {...backend.docs.get(write.path),...write.value} : write.value));
      }
      backend.commits.push(writes.map(write=>write.path));
      return result;
    },
  };
}}));
const site='organizations/org/sites/site', page=`${site}/versions/main/pages/page`;
beforeEach(() => { _resetForTests(); backend.docs.clear(); backend.commits=[]; backend.abort=false; });
it('commits a scheduled page, its event removal and the site publication intent together', async () => {
  const store=getStore();
  await store.setDoc(site,{name:'Site'});
  await store.setDoc(page,{status:'draft',publish_at:'2026-09-01T00:00:00Z'});
  const before=await store.getDoc<any>(page);
  await store.compareAndReplaceDoc(page,before,{...before,status:'published',publish_at:null},[{path:site,data:{scheduled_publish_pending_at:'2026-09-18T00:00:00Z'}}]);
  expect(new Set(backend.commits.at(-1))).toEqual(new Set([page,workPath(page,'page_schedule'),site,workPath(site,'site_publish')]));
  expect(backend.docs.has(workPath(page,'page_schedule'))).toBe(false);
  expect(backend.docs.get(workPath(site,'site_publish'))).toMatchObject({kind:'site_publish'});
});
it('cannot save a completed step without its next event when the transaction aborts', async () => {
  const path=`${site}/deploys/job`, store=getStore();
  await store.setDoc(path,{status:'running'});
  backend.abort=true;
  await expect(store.updateDoc(path,{continuation:{token:'event',reason:'checkpoint',due_at:1}})).rejects.toThrow('transaction aborted');
  expect(backend.docs.get(path)).toEqual({status:'running'});
  expect(backend.docs.has(workPath(path,'publication'))).toBe(false);
});
