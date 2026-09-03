interface ExtensionPreviewShellArgs {
  siteId: string;
  bridgeId: string;
  rootPath: string;
  storageScope: string;
  carriedQuery?: Record<string, string>;
}

function json(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Trusted, content-free parent for a navigable preview. Customer HTML and
 * Extension code stay in the opaque child; the shell owns only tab-scoped
 * state and navigation. No stored value is copied into a URL or request.
 */
export function buildExtensionPreviewShell(args: ExtensionPreviewShellArgs): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width"><title>Typeroll preview</title>
<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style></head>
<body><iframe id="preview" title="Site preview" sandbox="allow-scripts allow-forms allow-popups"></iframe>
<script>(function(){"use strict";
var siteId=${json(args.siteId)},bridgeId=${json(args.bridgeId)},root=${json(args.rootPath.replace(/\/$/, ''))},carriedQuery=${JSON.stringify(args.carriedQuery ?? {}).replace(/</g, '\\u003c')};
var frame=document.getElementById("preview");
var storageKey="typeroll:extension-preview:"+siteId+":"+${json(args.storageScope)};
var storage={session:{},local:{}};
try{var saved=sessionStorage.getItem(storageKey);if(saved){var parsed=JSON.parse(saved);if(parsed&&typeof parsed==="object")storage=parsed;}}catch(_){}
function persist(){try{var encoded=JSON.stringify(storage);if(encoded.length<=262144)sessionStorage.setItem(storageKey,encoded);}catch(_){}}
function safeName(value){return typeof value==="string"&&value.length>0&&value.length<=128&&value!=="__proto__"&&value!=="constructor"&&value!=="prototype";}
function carry(query){Object.keys(carriedQuery).forEach(function(key){query.set(key,carriedQuery[key]);});}
function frameUrl(){var path=location.pathname.startsWith(root)?location.pathname.slice(root.length):"/";if(!path.startsWith("/"))path="/"+path;var query=new URLSearchParams(location.search);carry(query);query.set("frame","1");query.set("bridge",bridgeId);return root+path+"?"+query.toString()+location.hash;}
function navigate(path){if(typeof path!=="string"||!path.startsWith("/")||path.startsWith("//")||path.includes("\\\\"))return;var requested=new URL(path,location.origin);var query=new URLSearchParams(requested.search);carry(query);var suffix=query.toString();var outer=root+requested.pathname+(suffix?"?"+suffix:"")+requested.hash;history.pushState(null,"",outer);frame.src=frameUrl();}
addEventListener("popstate",function(){frame.src=frameUrl();});
addEventListener("message",function(event){var data=event.data;if(event.source!==frame.contentWindow||event.origin!=="null"||!data||data.channel!=="typeroll.extension-preview"||data.version!==1||data.bridge_id!==bridgeId)return;
  if(data.action==="storage.ready"){frame.contentWindow&&frame.contentWindow.postMessage({channel:"typeroll.extension-preview",version:1,bridge_id:bridgeId,action:"storage.init",storage:storage},"*");return;}
  if(data.action==="site.navigate"){navigate(data.path);return;}
  if((data.action==="storage.set"||data.action==="storage.remove")&&(data.area==="session"||data.area==="local")&&safeName(data.installation_id)&&safeName(data.key)){
    var area=storage[data.area]||(storage[data.area]={});var installation=area[data.installation_id]||(area[data.installation_id]={});
    if(data.action==="storage.remove")delete installation[data.key];
    else if(typeof data.value==="string"&&data.value.length<=65536){try{JSON.parse(data.value);installation[data.key]=data.value;}catch(_){return;}}
    persist();
  }
});
frame.src=frameUrl();
})();</script></body></html>`;
}

export function extensionPreviewShellHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}
