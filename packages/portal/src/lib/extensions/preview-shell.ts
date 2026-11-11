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
 * state (Extension storage and the native page handoff) and navigation. No
 * stored value is copied into a URL or request.
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
var storage={session:{},local:{},handoff:{}};
try{var saved=sessionStorage.getItem(storageKey);if(saved){var parsed=JSON.parse(saved);if(parsed&&typeof parsed==="object")storage=parsed;}}catch(_){}
if(!storage.handoff||typeof storage.handoff!=="object")storage.handoff={};
function persist(){try{var encoded=JSON.stringify(storage);if(encoded.length<=262144)sessionStorage.setItem(storageKey,encoded);}catch(_){}}
function safeName(value){return typeof value==="string"&&value.length>0&&value.length<=128&&value!=="__proto__"&&value!=="constructor"&&value!=="prototype";}
function carry(query){Object.keys(carriedQuery).forEach(function(key){query.set(key,carriedQuery[key]);});}
function frameUrl(){var path=location.pathname.startsWith(root)?location.pathname.slice(root.length):"/";if(!path.startsWith("/"))path="/"+path;var query=new URLSearchParams(location.search);carry(query);query.set("frame","1");query.set("bridge",bridgeId);return root+path+"?"+query.toString()+location.hash;}
// Moving the frame replaces its history entry: the shell's own URL is the
// one entry per page, so Back undoes a whole navigation. Setting src would
// add a second, frame-only entry that Back undoes first, leaving the
// address on the newer page.
// Notices about the preview (content changed since the link was made, app
// data that could not be derived) come from each frame document. They float
// over the frame instead of entering its layout, and every new page replaces
// those of the previous one.
var notices=null;
function showNotices(list){if(notices){notices.remove();notices=null;}if(!Array.isArray(list))return;var box=document.createElement("div");box.setAttribute("data-tr-preview-notices","");box.style.cssText="position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;pointer-events:none";
  list.slice(0,4).forEach(function(notice){if(!notice||typeof notice.message!=="string"||(notice.kind!=="content-changed"&&notice.kind!=="derivation-failed"))return;var failed=notice.kind==="derivation-failed";var item=document.createElement("div");item.setAttribute("role",failed?"alert":"status");item.setAttribute("data-kind",notice.kind);
    item.style.cssText="pointer-events:auto;box-sizing:border-box;width:100%;max-width:720px;margin:0 auto;display:flex;gap:12px;align-items:flex-start;padding:.75rem 1rem;font:14px/1.4 system-ui,sans-serif;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.18);"+(failed?"background:#fff5f5;color:#742a2a;border:2px solid #c53030":"background:#fffbeb;color:#713f12;border:2px solid #d97706");
    var text=document.createElement("span");text.style.flex="1";text.textContent=notice.message.slice(0,2000);var close=document.createElement("button");close.type="button";close.textContent="Dismiss";close.style.cssText="font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:4px;padding:0 .5rem;cursor:pointer";close.addEventListener("click",function(){item.remove();});
    item.appendChild(text);item.appendChild(close);box.appendChild(item);});
  if(box.childNodes.length){document.body.appendChild(box);notices=box;}}
function reload(){showNotices(null);var url=frameUrl(),child=frame.contentWindow;if(child&&frame.getAttribute("src")){try{child.location.replace(url);return;}catch(_){}}frame.src=url;}
function navigate(path){if(typeof path!=="string"||!path.startsWith("/")||path.startsWith("//")||path.includes("\\\\"))return;var requested=new URL(path,location.origin);var query=new URLSearchParams(requested.search);carry(query);var suffix=query.toString();var outer=root+requested.pathname+(suffix?"?"+suffix:"")+requested.hash;history.pushState(null,"",outer);reload();}
// An off-site link from the frame opens here, unsandboxed: a popup the frame
// opened itself would inherit its opaque-origin sandbox and break sign-in
// and storage on the destination. The click's user activation reaches this
// ancestor, so the browser's popup blocker still applies.
function openExternal(href){if(typeof href!=="string"||href.length>8192)return;var url;try{url=new URL(href);}catch(_){return;}if(url.protocol!=="https:"&&url.protocol!=="http:")return;window.open(url.href,"_blank","noopener,noreferrer");}
addEventListener("popstate",reload);
addEventListener("message",function(event){var data=event.data;if(event.source!==frame.contentWindow||event.origin!=="null"||!data||data.channel!=="typeroll.extension-preview"||data.version!==1||data.bridge_id!==bridgeId)return;
  if(data.action==="storage.ready"){frame.contentWindow&&frame.contentWindow.postMessage({channel:"typeroll.extension-preview",version:1,bridge_id:bridgeId,action:"storage.init",storage:storage},"*");return;}
  if(data.action==="preview.notices"){showNotices(data.notices);return;}
  if(data.action==="site.navigate"){navigate(data.path);return;}
  if(data.action==="site.open"){openExternal(data.url);return;}
  // The page handoff of a native navigation form: one slot per tab, as on a
  // published site, where a new handoff replaces any abandoned one.
  if(data.action==="handoff.set"&&typeof data.key==="string"&&/^[a-zA-Z0-9_-]{1,64}$/.test(data.key)&&typeof data.value==="string"&&data.value.length<=20000){try{JSON.parse(data.value);}catch(_){return;}storage.handoff={};storage.handoff[data.key]=data.value;persist();return;}
  if(data.action==="handoff.remove"&&typeof data.key==="string"){delete storage.handoff[data.key];persist();return;}
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
