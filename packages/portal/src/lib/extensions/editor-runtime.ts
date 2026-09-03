import { buildExtensionRuntimeScript, type ExtensionRuntimeSnapshot } from '@typeroll/shared';
import { assertExtensionAssetDigest, MAX_EXTENSION_SCRIPT_BYTES, MAX_EXTENSION_STYLE_BYTES } from './assets';
import { fetchPublicAsset } from './public-http';
import { buildExtensionPreviewSnapshot } from './preview-runtime';

interface EditorAsset {
  script_base64?: string;
  style_base64?: string;
  error?: string;
}

/**
 * Editor-only Extension host. Third-party bundled code is always moved into
 * a nested opaque-origin iframe, even when its public render mode is bundled.
 * That prevents it from impersonating the privileged editor-canvas bridge.
 */
export async function buildExtensionEditorRuntimeScript(
  orgId: string,
  siteId: string,
  _versionId: string,
  canvasId: string,
): Promise<string> {
  const snapshot = await buildExtensionPreviewSnapshot(orgId, siteId);
  if (!snapshot.installations.length) return '';
  const assets: Record<string, EditorAsset> = {};
  for (const installation of snapshot.installations) {
    for (const component of installation.components) {
      if (component.render_mode !== 'bundled_component') continue;
      const key = `${installation.installation_id}:${component.id}`;
      const entry = component.entry as { script_url: string; script_sha256: string; style_url?: string; style_sha256?: string };
      try {
        const script = await fetchPublicAsset(entry.script_url, MAX_EXTENSION_SCRIPT_BYTES);
        assertExtensionAssetDigest(script, entry.script_sha256, `${component.id} script`);
        let style: Uint8Array | undefined;
        if (entry.style_url) {
          style = await fetchPublicAsset(entry.style_url, MAX_EXTENSION_STYLE_BYTES);
          assertExtensionAssetDigest(style, String(entry.style_sha256 ?? ''), `${component.id} style`);
        }
        assets[key] = {
          script_base64: Buffer.from(script).toString('base64'),
          style_base64: style ? Buffer.from(style).toString('base64') : undefined,
        };
      } catch (error) {
        assets[key] = { error: error instanceof Error ? error.message : 'Extension asset unavailable' };
      }
    }
  }
  return buildExtensionEditorHostScript(snapshot, assets, siteId, canvasId);
}

export function buildExtensionEditorHostScript(
  snapshot: ExtensionRuntimeSnapshot,
  assets: Record<string, EditorAsset>,
  siteId: string,
  canvasId: string,
): string {
  const data = JSON.stringify({ snapshot, assets, siteId, canvasId }).replace(/</g, '\\u003c');
  // Keep this independent from the public host: bundled code must never run
  // in the bridge's Window. The public host is referenced above so contract
  // drift is caught by TypeScript and shared tests, while this host applies
  // the stricter editor execution policy.
  void buildExtensionRuntimeScript;
  return `(function(){"use strict";var state=${data};var previewContext={};
function nestedHost(payload){
  var own=document.currentScript;own&&own.remove();
  function decode(value){var raw=atob(value||"");var bytes=new Uint8Array(raw.length);for(var i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;}
  function nav(){var current="root",listeners=new Set();return{get current(){return current;},navigate:function(view){if(typeof view!=="string"||!view.trim()||view===current)return;current=view;listeners.forEach(function(fn){fn(view);});},subscribe:function(fn){listeners.add(fn);return function(){listeners.delete(fn);};}};}
  function apiClient(declaration){
    function route(path,method){return declaration&&declaration.routes.some(function(rule){var match=rule.path.endsWith("/*")?path.startsWith(rule.path.slice(0,-1)):path===rule.path;return match&&rule.methods.includes(method);});}
    return{fetch:function(resource,options){
      if(!declaration)return Promise.reject(new Error("This Extension has no direct API"));
      var relative=String(resource||"");if(!relative.startsWith("/"))relative="/"+relative;
      if(relative.includes("..")||/^\\/\\//.test(relative))return Promise.reject(new Error("Invalid Extension API path"));
      var method=String(options&&options.method||"GET").toUpperCase();var pathname=relative.split("?",1)[0];
      if(!route(pathname,method))return Promise.reject(new Error("Extension API route or method is not declared"));
      var base=new URL(declaration.base_url);var prefix=base.pathname.endsWith("/")?base.pathname:base.pathname+"/";var target=new URL(relative.replace(/^\\//,""),base.origin+prefix);
      if(target.origin!==base.origin||!target.pathname.startsWith(prefix))return Promise.reject(new Error("Invalid Extension API target"));
      var headers=new Headers(options&&options.headers||{});if(declaration.preview_token)headers.set("X-Typeroll-Extension-Token",declaration.preview_token);
      return fetch(target.href,Object.assign({},options||{},{method:method,headers:headers,credentials:"omit",redirect:"error"}));
    }};
  }
  var navigation=nav();var api=apiClient(payload.api);var forms={has:function(id){return payload.form_binding_ids.includes(id);},list:function(){return payload.form_binding_ids.slice();},submit:function(){return Promise.reject(new Error("Form submissions are disabled in preview"));}};
  if(payload.style_base64){var style=document.createElement("style");style.textContent=new TextDecoder().decode(decode(payload.style_base64));document.head.appendChild(style);}
  var bytes=decode(payload.script_base64),url=URL.createObjectURL(new Blob([bytes],{type:"text/javascript"}));
  import(url).then(function(mod){URL.revokeObjectURL(url);if(typeof mod.mount!=="function")throw new Error("Extension bundle must export mount(element, props, context)");return mod.mount(document.getElementById("root"),payload.props,{protocol_version:payload.protocol_version,runtime_version:payload.runtime_version,preview:true,installation_id:payload.installation_id,extension_id:payload.extension_id,component_id:payload.component_id,config:payload.config,url:{get:function(name){return payload.url_context[name];},has:function(name){return Object.prototype.hasOwnProperty.call(payload.url_context,name);},consume:function(name){var value=payload.url_context[name];delete payload.url_context[name];return value;}},navigation:navigation,api:api,forms:forms});}).catch(function(){document.getElementById("root").textContent=payload.unavailable_message||"This feature is temporarily unavailable.";});
}
function descriptor(el){var iid=el.getAttribute("data-tr-extension-installation"),cid=el.getAttribute("data-tr-extension-component"),installation=state.snapshot.installations.find(function(x){return x.installation_id===iid;}),component=installation&&installation.components.find(function(x){return x.id===cid;});return installation&&component?{installation:installation,component:component}:null;}
function context(component){var value=previewContext[component.id];return value&&typeof value==="object"?Object.assign({},value):{};}
function start(){document.querySelectorAll("[data-tr-extension-installation][data-tr-extension-component]").forEach(function(el){var found=descriptor(el);if(!found)return;var props={};try{props=JSON.parse(el.getAttribute("data-block-data")||"{}");}catch(_){}var frame=document.createElement("iframe");frame.title=found.component.label;frame.referrerPolicy="no-referrer";frame.style.cssText="width:100%;min-height:320px;border:0";
  if(found.component.render_mode==="embedded_app"){var target=new URL(found.component.entry.frame_url);frame.src=target.href;frame.setAttribute("sandbox",["allow-scripts"].concat(found.component.entry.sandbox||[]).join(" "));frame.addEventListener("load",function(){frame.contentWindow&&frame.contentWindow.postMessage({type:"typeroll.extension.init",version:state.snapshot.protocol_version,installation_id:found.installation.installation_id,component_id:found.component.id,props:props,config:found.installation.public_config,url_context:context(found.component),preview:true},target.origin);},{once:true});}
  else{var asset=state.assets[found.installation.installation_id+":"+found.component.id];if(!asset||!asset.script_base64){el.textContent=found.component.unavailable_message||"Extension preview unavailable.";return;}var payload={script_base64:asset.script_base64,style_base64:asset.style_base64,protocol_version:state.snapshot.protocol_version,runtime_version:state.snapshot.runtime_version,installation_id:found.installation.installation_id,extension_id:found.installation.extension_id,component_id:found.component.id,api:found.installation.api,config:found.installation.public_config,props:props,url_context:context(found.component),form_binding_ids:Object.keys(found.component.resolved_form_bindings||{}),unavailable_message:found.component.unavailable_message};frame.setAttribute("sandbox","allow-scripts allow-forms allow-modals allow-popups");frame.srcdoc="<!doctype html><meta charset=utf-8><meta name=referrer content=no-referrer><style>html,body,#root{margin:0;min-height:100%}</style><div id=root></div><script>("+nestedHost.toString()+")("+JSON.stringify(payload).replace(/</g,"\\\\u003c")+")<\\/script>";}
  el.replaceChildren(frame);});}
addEventListener("message",function(event){var data=event.data;if(event.source!==parent||!data||data.channel!=="typeroll.editor-canvas"||data.version!==1||data.canvas_id!==state.canvasId||data.action!=="extension_context"||!data.context||typeof data.context!=="object")return;previewContext=data.context;start();});
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();})();`;
}
