export function qualificationFiles(id: string) {
  return {
    'index.html': '<!doctype html><meta name="robots" content="noindex"><title>Typeroll build check</title>',
    '404.html': '<!doctype html><title>Not found</title>',
    'robots.txt': 'User-agent: *\nDisallow: /\n',
    '_headers': '/*\n  X-Robots-Tag: noindex\n',
    '.well-known/typeroll/publication.json': JSON.stringify({ id }),
  };
}
export function qualificationSource(id: string) {
  return { 'qualification.mjs': `import fs from 'node:fs/promises'; import path from 'node:path';
const status=await fs.readFile('/proc/self/status','utf8');
if(process.getuid()!==1000||!/NoNewPrivs:\\s+1/.test(status)||!/CapEff:\\s+0+\\s/.test(status)||process.env.TYPEROLL_RUNNER_TOKEN||process.env.CLOUDFLARE_API_TOKEN)throw Error('isolation_failed');
let blocked=false;try{await fetch('https://1.1.1.1',{signal:AbortSignal.timeout(2000)})}catch{blocked=true}if(!blocked)throw Error('network_not_isolated');
let readOnly=false;try{await fs.writeFile('/root-write-probe','test')}catch(e){readOnly=e.code==='EROFS'||e.code==='EACCES'}if(!readOnly)throw Error('root_not_isolated');
for(const[name,content]of Object.entries(${JSON.stringify(qualificationFiles(id))})){const dest=path.join('dist',name);await fs.mkdir(path.dirname(dest),{recursive:true});await fs.writeFile(dest,content);}
` };
}
