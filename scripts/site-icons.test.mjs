import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { writeSiteIcons, readFrozenIcon, packIcon } from './fixtures/static-publication/site-icons.mjs';

async function fixture(run) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'site-icons-'));
 try{await fs.writeFile(path.join(dir,'index.html'),'<html><head><link data-site-icon="favicon" rel="icon" href="/old.png"><link rel="apple-touch-icon" href="/apple.png"></head><body></body></html>');await run(dir);}
 finally{await fs.rm(dir,{recursive:true,force:true});}
}
const png=color=>sharp({create:{width:64,height:32,channels:4,background:color}}).png().toBuffer();
test('publication writes a real multi-size ICO, hashed icon links and a 192 manifest icon',async()=>fixture(async dir=>{
 const source=await png('#ff00ff');const reads=[];
 const result=await writeSiteIcons(dir,{site_name:'Example',favicon:'/media/icon.png',icon_192:'/media/icon.png'},async url=>{reads.push(url);return source;});
 assert.deepEqual(reads,['/media/icon.png']);
 const ico=await fs.readFile(path.join(dir,'favicon.ico'));
 assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),3);
 for(let i=0;i<3;i++){const start=6+i*16,size=[16,32,48][i];assert.equal(ico[start],size);const offset=ico.readUInt32LE(start+12),length=ico.readUInt32LE(start+8);const image=sharp(ico.subarray(offset,offset+length));const meta=await image.metadata();assert.equal(meta.width,size);assert.equal(meta.height,size);const {data,info}=await image.raw().toBuffer({resolveWithObject:true});const center=(Math.floor(size/2)*size+Math.floor(size/2))*info.channels;assert.deepEqual([...data.subarray(center,center+3)],[255,0,255]);}
 assert.deepEqual(await fs.readFile(path.join(dir,result.favicon_url)),ico);
 const html=await fs.readFile(path.join(dir,'index.html'),'utf8');assert.ok(html.includes(result.favicon_url));assert.ok(!html.includes('/old.png'));assert.ok(html.includes('/apple.png'));assert.ok(html.includes('rel="manifest"'));
 const manifest=JSON.parse(await fs.readFile(path.join(dir,'site.webmanifest'),'utf8'));assert.equal(manifest.icons[0].src,result.icon_192_url);assert.equal((await sharp(path.join(dir,result.icon_192_url)).metadata()).width,192);
}));
test('an icon change updates bytes and the HTML URL; unchanged icons remain stable',async()=>fixture(async dir=>{
 let source=await png('#00ffff');const settings={favicon:'/same-url.png'};
 const first=await writeSiteIcons(dir,settings,async()=>source);const again=await writeSiteIcons(dir,settings,async()=>source);assert.deepEqual(again,first);
 source=await png('#ffff00');const changed=await writeSiteIcons(dir,settings,async()=>source);assert.notEqual(changed.favicon_url,first.favicon_url);
 assert.ok((await fs.readFile(path.join(dir,'index.html'),'utf8')).includes(changed.favicon_url));
}));
test('no icon setting still produces a tiny image instead of the HTML 404 document',async()=>fixture(async dir=>{
 await writeSiteIcons(dir,{},async()=>{throw Error('No network needed');});const ico=await fs.readFile(path.join(dir,'favicon.ico'));assert.equal(ico.readUInt16LE(2),1);assert.ok(ico.length<2000);
}));
test('invalid configured bytes fail clearly and cannot silently become a successful wrong icon',async()=>fixture(async dir=>{
 await assert.rejects(()=>writeSiteIcons(dir,{favicon:'/bad.png'},async()=>Buffer.from('<html>not an image</html>')),/site_icon_build_failed/);
}));
test('frozen icons only use verified manifest media',async()=>fixture(async dir=>{
 const file=path.join(dir,'image.png');await fs.writeFile(file,await png('#0000ff'));
 const publication={site_url:'https://site.example',media_manifest:{entries:[{cdn_url:'https://media.example/icon.png',public_path:'/media/icon.png',aliases:[]}]}};
 const files=[{path:'/media/icon.png',source:file}];
 assert.ok((await readFrozenIcon(publication,files,'https://media.example/icon.png')).length);
 await assert.rejects(()=>readFrozenIcon(publication,files,'https://evil.example/media/icon.png'),/verified publication media/);
 await assert.rejects(()=>readFrozenIcon(publication,[{...files[0],reused:true}],'/media/icon.png'),/verified publication media/);
}));

test('existing PNG-backed ICO uploads retain their motif',async()=>fixture(async dir=>{
 const ico=packIcon([{size:32,bytes:await sharp(await png('#ff00ff')).resize(32,32).png().toBuffer()}]);
 await writeSiteIcons(dir,{favicon:'/uploaded.ico'},async()=>ico);
 const result=await fs.readFile(path.join(dir,'favicon.ico'));const start=result.readUInt32LE(18),length=result.readUInt32LE(14);
 const pixel=await sharp(result.subarray(start,start+length)).resize(1,1).removeAlpha().raw().toBuffer();assert.deepEqual([...pixel],[255,0,255]);
}));
test('legacy bitmap ICO uploads decode alpha and the transparency mask',async()=>fixture(async dir=>{
 const size=16,bmp=Buffer.alloc(40+size*size*4+size*4);bmp.writeUInt32LE(40);bmp.writeInt32LE(size,4);bmp.writeInt32LE(size*2,8);bmp.writeUInt16LE(1,12);bmp.writeUInt16LE(32,14);
 for(let i=40;i<40+size*size*4;i+=4){bmp[i]=0;bmp[i+1]=255;bmp[i+2]=0;bmp[i+3]=0;}
 bmp[40+size*size*4+(size-1)*4]=128;
 const ico=packIcon([{size,bytes:bmp}]);await writeSiteIcons(dir,{favicon:'/old.ico'},async()=>ico);
 const result=await fs.readFile(path.join(dir,'favicon.ico'));const start=result.readUInt32LE(18),length=result.readUInt32LE(14);
 const raw=await sharp(result.subarray(start,start+length)).raw().toBuffer();assert.equal(raw[3],0);assert.deepEqual([...raw.subarray(4,8)],[0,255,0,255]);
}));
test('truncated ICO offsets are rejected without reading outside their payload',async()=>fixture(async dir=>{
 const ico=packIcon([{size:32,bytes:await png('#ff00ff')}]);ico.writeUInt32LE(0xffffffff,18);
 await assert.rejects(()=>writeSiteIcons(dir,{favicon:'/invalid.ico'},async()=>ico),/site_icon_build_failed/);
}));
