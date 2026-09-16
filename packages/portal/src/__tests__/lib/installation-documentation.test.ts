import { beforeEach,describe,it,expect,vi } from 'vitest';
const store=vi.hoisted(()=>({getDoc:vi.fn()}));
const fetchAsset=vi.hoisted(()=>vi.fn());
const sign=vi.hoisted(()=>vi.fn(()=> 'purpose-bound-test-proof'));
vi.mock('../../lib/datastore',()=>({getStore:()=>store}));
vi.mock('../../lib/extensions/auth',()=>({signInstallationAssertion:sign}));
vi.mock('../../lib/extensions/public-http',()=>({parsePublicHttpsUrl:(url:string)=>new URL(url),fetchPublicAsset:fetchAsset}));
import {readInstallationGuide} from '../../lib/extensions/documentation';
const installation={id:'install',extension_id:'test.vendor.app',developer_org_id:'developer',status:'enabled'} as any;
const version={extension_id:'test.vendor.app',version:'1.0.0',manifest:{documentation:{url:'https://provider.example/guide',access:'installation'}}} as any;
describe('protected provider guide retrieval',()=>{
 beforeEach(()=>{vi.clearAllMocks();store.getDoc.mockResolvedValue({status:'active',trusted_origins:['https://provider.example']});fetchAsset.mockResolvedValue(new TextEncoder().encode('# Protected guide'));});
 it('signs a guide-only assertion for the resolved version and limits the read',async()=>{
  expect(await readInstallationGuide(installation,version)).toEqual({status:'available',markdown:'# Protected guide'});
  expect(sign).toHaveBeenCalledWith(expect.objectContaining({scopes:[],purpose:'documentation',version:'1.0.0'}));
  expect(fetchAsset).toHaveBeenCalledWith('https://provider.example/guide',256*1024,fetch,{Authorization:'Bearer purpose-bound-test-proof',Accept:'text/markdown'});
 });
 it('does not fetch disabled, suspended or unapproved providers',async()=>{
  expect((await readInstallationGuide({...installation,status:'disabled'},version)).status).toBe('unavailable');
  store.getDoc.mockResolvedValue({status:'active',trusted_origins:['https://other.example']});
  expect((await readInstallationGuide(installation,version)).status).toBe('unavailable');expect(fetchAsset).not.toHaveBeenCalled();
 });
 it('does not misreport a failed provider read as available',async()=>{fetchAsset.mockRejectedValue(new Error('provider unavailable'));expect(await readInstallationGuide(installation,version)).toEqual({status:'unavailable'});});
});
