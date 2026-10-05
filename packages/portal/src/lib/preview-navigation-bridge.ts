/** The navigable-preview parts of PreviewOptions. */
export interface PreviewNavigationOptions {
  /** Preview root that internal links are rewritten under. */
  browseRoot?: string;
  /** Authentication/mode query carried by rewritten links. */
  embedSuffix?: string;
  /** Parent shell bridge of an opaque, navigable preview. */
  extensionPreviewBridge?: { id: string; parentOrigin: string };
}

/**
 * Keep internal links inside a navigable preview: prefix the preview root and
 * carry its authentication/mode query.
 */
export function rewriteInternalHrefs(html: string, root: string, suffix: string): string {
  const cleanRoot = root.replace(/\/$/, '');
  return html.replace(
    /href=(?:"(\/[^"]*?)"|'(\/[^']*?)')/g,
    (m, dq, sq) => {
      const href: string = dq ?? sq;
      if (href.startsWith('//')) return m; // protocol-relative
      const hashIdx = href.indexOf('#');
      const path = hashIdx === -1 ? href : href.slice(0, hashIdx);
      const frag = hashIdx === -1 ? '' : href.slice(hashIdx);
      // The suffix is `?t=…`; if the href already carries a query string,
      // join with `&` instead of producing a second `?`.
      const joinedSuffix = path.includes('?') ? `&${suffix.replace(/^\?/, '')}` : suffix;
      return `href="${cleanRoot}${path}${joinedSuffix}${frag}"`;
    },
  );
}

/**
 * The frame half of the preview shell bridge for platform code (as opposed to
 * Extension code, whose host runs its own handshake). It keeps internal links
 * inside the shell and gives native blocks the two things an opaque frame
 * lacks: tab-scoped storage for the page handoff (`core/navigation_form`) and
 * navigation of the shell instead of the isolated frame. Emitted before block
 * scripts so their initializers can find it.
 */
export function buildPreviewNavigationBridgeScript(opts: PreviewNavigationOptions): string {
  if (!opts.extensionPreviewBridge || !opts.browseRoot) return '';
  const authQuery = Array.from(
    new URLSearchParams((opts.embedSuffix ?? '').replace(/^\?/, '')).entries(),
  );
  const config = JSON.stringify({
    root: opts.browseRoot.replace(/\/$/, ''),
    authQuery,
    bridge: opts.extensionPreviewBridge,
  }).replace(/</g, '\\u003c');
  return `(function(){"use strict";var config=${config};var channel="typeroll.extension-preview";
function post(message){message.channel=channel;message.version=1;message.bridge_id=config.bridge.id;parent.postMessage(message,config.bridge.parentOrigin);}
function previewPath(href){var url;try{url=new URL(href,location.href);}catch(_){return null;}if(url.origin!==location.origin||!(url.pathname===config.root||url.pathname.startsWith(config.root+"/")))return null;var query=new URLSearchParams(url.search);config.authQuery.forEach(function(pair){var values=query.getAll(pair[0]),removed=false;query.delete(pair[0]);values.forEach(function(value){if(!removed&&value===pair[1])removed=true;else query.append(pair[0],value);});});var path=url.pathname.slice(config.root.length)||"/";var suffix=query.toString();return path+(suffix?"?"+suffix:"")+url.hash;}
var handoff=null;
function handoffState(){if(!handoff)handoff=new Promise(function(resolve){var timer;function finish(state){clearTimeout(timer);removeEventListener("message",receive);resolve(state);}function receive(event){var data=event.data;if(event.source!==parent||event.origin!==config.bridge.parentOrigin||!data||data.channel!==channel||data.version!==1||data.bridge_id!==config.bridge.id||data.action!=="storage.init")return;var state=data.storage&&data.storage.handoff;finish(state&&typeof state==="object"?state:{});}addEventListener("message",receive);timer=setTimeout(function(){finish({});},2000);post({action:"storage.ready"});});return handoff;}
Object.defineProperty(window,"__TYPEROLL_PREVIEW_BRIDGE__",{value:Object.freeze({
takeHandoff:function(key){return handoffState().then(function(state){if(!Object.prototype.hasOwnProperty.call(state,key))return null;var raw=state[key];delete state[key];post({action:"handoff.remove",key:key});return typeof raw==="string"?raw:null;});},
storeHandoff:function(key,packet){post({action:"handoff.set",key:String(key),value:String(packet)});},
navigate:function(href){var path=previewPath(href);if(path===null)return false;post({action:"site.navigate",path:path});return true;}
})});
document.addEventListener("click",function(event){if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;var target=event.target;if(!(target instanceof Element))return;var anchor=target.closest("a[href]");if(!anchor||anchor.target&&anchor.target!=="_self"||anchor.hasAttribute("download"))return;var path=previewPath(anchor.href);if(path===null)return;event.preventDefault();post({action:"site.navigate",path:path});},true);})();`;
}
