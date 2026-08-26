import type { ExtensionRuntimeSnapshot } from './extensions.js';

/**
 * Browser host for externally developed Extensions. The generated script
 * contains public installation metadata only; customer URL values are read
 * in the browser, held in per-mount closures, and never serialized into HTML.
 */
export function buildExtensionRuntimeScript(snapshot: ExtensionRuntimeSnapshot): string {
  const serialized = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  return `(function(){
"use strict";
var snapshot=${serialized};
var mounts=[];
var styleUrls=new Set();
function findDescriptor(el){
  var installationId=el.getAttribute("data-tr-extension-installation");
  var componentId=el.getAttribute("data-tr-extension-component");
  var installation=snapshot.installations.find(function(item){return item.installation_id===installationId;});
  var component=installation&&installation.components.find(function(item){return item.id===componentId;});
  return installation&&component?{installation:installation,component:component}:null;
}
function validValue(input,value){
  if(value===null||value===undefined)return null;
  var max=Number(input.max_length||4096);
  if(value.length>max)return null;
  if(input.pattern){try{if(!(new RegExp(input.pattern)).test(value))return null;}catch(_){return null;}}
  return value;
}
function capture(component){
  var declaration=component.url_context||{};
  var query=new URLSearchParams(location.search);
  var fragment=new URLSearchParams(location.hash.replace(/^#/,""));
  var values={};var consumeQuery=[];var consumeFragment=[];var consumeRaw=false;
  function take(source,input,value){
    value=validValue(input,value);if(value===null)return;
    values[input.expose_as||input.name]=value;
    if(input.consume&&source==="query")consumeQuery.push(input.name);
    if(input.consume&&source==="fragment")consumeFragment.push(input.name);
  }
  (declaration.query||[]).forEach(function(input){take("query",input,query.get(input.name));});
  (declaration.fragment||[]).forEach(function(input){take("fragment",input,fragment.get(input.name));});
  var pathContext=window.__TYPEROLL_EXTENSION_PATH_CONTEXT__;
  var pathValues=pathContext&&typeof pathContext==="object"?(pathContext[component.id]||pathContext):{};
  var segments=location.pathname.split("/").filter(Boolean).map(function(value){try{return decodeURIComponent(value);}catch(_){return "";}});
  (declaration.path||[]).forEach(function(input){var index=Number(input.segment);if(index<0)index=segments.length+index;var value=pathValues&&typeof pathValues[input.name]==="string"?pathValues[input.name]:(Number.isInteger(index)?segments[index]:null);take("path",input,value);});
  if(declaration.raw_query){
    var raw=location.search.replace(/^\\?/,"");
    if(raw&&!raw.includes("=")){
      var decoded=null;try{decoded=decodeURIComponent(raw);}catch(_){}
      var value=validValue(declaration.raw_query,decoded);
      if(value!==null){values[declaration.raw_query.expose_as||declaration.raw_query.name||"raw_query"]=value;consumeRaw=declaration.raw_query.consume===true;}
    }
  }
  var preview=window.__TYPEROLL_EXTENSION_PREVIEW_CONTEXT__;
  if(preview&&typeof preview==="object"){
    var synthetic=preview[component.id];
    if(synthetic&&typeof synthetic==="object")Object.assign(values,synthetic);
  }
  return {values:values,consumeQuery:consumeQuery,consumeFragment:consumeFragment,consumeRaw:consumeRaw};
}
function cleanUrl(captures){
  var url=new URL(location.href);var fragment=new URLSearchParams(url.hash.replace(/^#/,""));var raw=false;
  captures.forEach(function(capture){capture.consumeQuery.forEach(function(name){url.searchParams.delete(name);});capture.consumeFragment.forEach(function(name){fragment.delete(name);});raw=raw||capture.consumeRaw;});
  if(raw)url.search="";
  var hash=fragment.toString();url.hash=hash?"#"+hash:"";
  var next=url.pathname+url.search+url.hash;
  if(next!==location.pathname+location.search+location.hash)history.replaceState(history.state,"",next);
}
function urlRuntime(values){
  var available=new Map(Object.entries(values));
  return {get:function(name){return available.get(name);},has:function(name){return available.has(name);},consume:function(name){var value=available.get(name);available.delete(name);return value;}};
}
function navigation(){
  var current="root";var listeners=new Set();
  return {get current(){return current;},navigate:function(view){if(typeof view!=="string"||!view.trim()||view===current)return;current=view;listeners.forEach(function(fn){fn(current);});},subscribe:function(fn){listeners.add(fn);return function(){listeners.delete(fn);};}};
}
function apiClient(installation){
  var declaration=installation.api;var tokenPromise=null;var tokenExpiresAt=0;
  function route(path,method){return declaration.routes.some(function(rule){var match=rule.path.endsWith("/*")?path.startsWith(rule.path.slice(0,-1)):path===rule.path;return match&&rule.methods.includes(method);});}
  function token(){
    if(!declaration||declaration.authentication==="none")return Promise.resolve("");
    if(!declaration.token_url)return Promise.reject(new Error("Extension API token endpoint is unavailable"));
    if(tokenPromise&&Date.now()>=tokenExpiresAt-30000)tokenPromise=null;
    if(!tokenPromise)tokenPromise=fetch(declaration.token_url,{method:"POST",headers:{accept:"application/json"},credentials:"omit"}).then(function(response){return response.json().catch(function(){return null;}).then(function(body){if(!response.ok||!body||typeof body.token!=="string")throw new Error("Extension API token request failed");tokenExpiresAt=Date.now()+Math.max(30,Number(body.expires_in)||300)*1000;return body.token;});}).catch(function(error){tokenPromise=null;tokenExpiresAt=0;throw error;});
    return tokenPromise;
  }
  return {fetch:function(resource,options){
    if(!declaration)return Promise.reject(new Error("This Extension has no direct API"));
    var relative=String(resource||"");if(!relative.startsWith("/"))relative="/"+relative;
    if(relative.includes("..")||/^\\/\\//.test(relative))return Promise.reject(new Error("Invalid Extension API path"));
    var method=String(options&&options.method||"GET").toUpperCase();
    var pathname=relative.split("?",1)[0];if(!route(pathname,method))return Promise.reject(new Error("Extension API route or method is not declared"));
    var base=new URL(declaration.base_url);var prefix=base.pathname.endsWith("/")?base.pathname:base.pathname+"/";var target=new URL(relative.replace(/^\\//,""),base.origin+prefix);
    if(target.origin!==base.origin||!target.pathname.startsWith(prefix))return Promise.reject(new Error("Invalid Extension API target"));
    return token().then(function(value){var headers=new Headers(options&&options.headers||{});if(value)headers.set("X-Typeroll-Extension-Token",value);return fetch(target.href,Object.assign({},options||{},{method:method,headers:headers,credentials:"omit",redirect:"error"}));});
  }};
}
function leadingZeroBits(bytes){var count=0;for(var i=0;i<bytes.length;i++){var value=bytes[i];if(value===0){count+=8;continue;}while((value&128)===0){count++;value<<=1;}break;}return count;}
async function formProof(token,bits){
  if(!bits)return "";
  if(!window.crypto||!window.crypto.subtle)throw new Error("This browser cannot submit protected forms");
  var bucket=Math.floor(Date.now()/600000);var prefix=token+"."+bucket+".";var encoder=new TextEncoder();
  for(var nonce=0;;nonce++){
    var digest=await window.crypto.subtle.digest("SHA-256",encoder.encode(prefix+nonce));
    if(leadingZeroBits(new Uint8Array(digest))>=bits)return bucket+"."+nonce;
    if(nonce%2000===1999)await new Promise(function(resolve){setTimeout(resolve,0);});
  }
}
function forms(component){
  var bindings=component.resolved_form_bindings||{};
  return {
    has:function(id){return Object.prototype.hasOwnProperty.call(bindings,id);},
    list:function(){return Object.keys(bindings);},
    submit:async function(id,data){
      var binding=bindings[id];
      if(!binding)throw new Error("Unknown Extension form binding");
      if(!binding.submit_token)throw new Error("Extension form submissions are not configured");
      if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("Form data must be an object");
      var payload=Object.assign({},data,{_protocol:"1",_hp:""});
      if(binding.pow_bits>0)payload._pow=await formProof(binding.submit_token,binding.pow_bits);
      var response=await fetch(binding.submit_url,{method:"POST",headers:{accept:"application/json","content-type":"application/json"},credentials:"omit",body:JSON.stringify({token:binding.submit_token,data:payload})});
      var result=await response.json().catch(function(){return null;});
      if(!result||typeof result!=="object")throw new Error("Invalid Forms response");
      if(!response.ok&&result.ok!==false)throw new Error("Form submission failed");
      return result;
    }
  };
}
function loadStyle(url){
  if(!url||styleUrls.has(url))return;styleUrls.add(url);
  var link=document.createElement("link");link.rel="stylesheet";link.href=url;link.dataset.trExtensionAsset="1";document.head.appendChild(link);
}
function unavailable(el,component){
  el.replaceChildren();var message=document.createElement("p");message.className="tr-extension-unavailable";message.textContent=component.unavailable_message||"This feature is temporarily unavailable.";el.appendChild(message);
}
function contextFor(entry){
  return {protocol_version:snapshot.protocol_version,runtime_version:snapshot.runtime_version,installation_id:entry.descriptor.installation.installation_id,extension_id:entry.descriptor.installation.extension_id,component_id:entry.descriptor.component.id,config:entry.descriptor.installation.public_config,url:urlRuntime(entry.capture.values),navigation:navigation(),api:apiClient(entry.descriptor.installation),forms:forms(entry.descriptor.component)};
}
async function mountBundle(entry,context){
  var component=entry.descriptor.component;loadStyle(component.local_style_url);
  var module=await import(component.local_script_url);
  if(typeof module.mount!=="function")throw new Error("Extension bundle must export mount(element, props, context)");
  await module.mount(entry.el,entry.props,context);
}
function mountFrame(entry,context){
  var component=entry.descriptor.component;var frame=document.createElement("iframe");var target=new URL(component.entry.frame_url);
  frame.src=target.href;frame.title=component.label;frame.loading="lazy";frame.referrerPolicy="no-referrer";
  var capabilities=["allow-scripts","allow-same-origin"].concat(component.entry.sandbox||[]);frame.setAttribute("sandbox",Array.from(new Set(capabilities)).join(" "));
  entry.el.replaceChildren(frame);
  function receive(event){
    if(event.source!==frame.contentWindow||event.origin!==target.origin||!event.data||event.data.version!==snapshot.protocol_version)return;
    if(event.data.installation_id!==context.installation_id||event.data.component_id!==context.component_id)return;
    if(event.data.type==="typeroll.extension.resize"){
      var height=Math.max(120,Math.min(5000,Number(event.data.height)||0));if(height)frame.style.height=height+"px";
    }
    if(event.data.type==="typeroll.extension.navigate"&&typeof event.data.view==="string")context.navigation.navigate(event.data.view);
    if(event.data.type==="typeroll.extension.form.submit"&&typeof event.data.request_id==="string"&&event.data.request_id.length<=128&&typeof event.data.binding_id==="string"){
      var requestId=event.data.request_id;
      context.forms.submit(event.data.binding_id,event.data.data).then(function(result){
        frame.contentWindow&&frame.contentWindow.postMessage({type:"typeroll.extension.form.result",version:snapshot.protocol_version,installation_id:context.installation_id,component_id:context.component_id,request_id:requestId,ok:true,result:result},target.origin);
      }).catch(function(){
        frame.contentWindow&&frame.contentWindow.postMessage({type:"typeroll.extension.form.result",version:snapshot.protocol_version,installation_id:context.installation_id,component_id:context.component_id,request_id:requestId,ok:false,error:"Form submission failed"},target.origin);
      });
    }
    if(event.data.type==="typeroll.extension.api.request"&&typeof event.data.request_id==="string"&&event.data.request_id.length<=128&&typeof event.data.path==="string"&&event.data.path.length<=2048){
      var apiRequestId=event.data.request_id;var supplied=event.data.options&&typeof event.data.options==="object"?event.data.options:{};
      var requestOptions={};["method","headers","body"].forEach(function(key){if(Object.prototype.hasOwnProperty.call(supplied,key))requestOptions[key]=supplied[key];});
      context.api.fetch(event.data.path,requestOptions).then(async function(response){
        var body=await response.text();if(body.length>1048576)throw new Error("Extension API response is too large");
        frame.contentWindow&&frame.contentWindow.postMessage({type:"typeroll.extension.api.result",version:snapshot.protocol_version,installation_id:context.installation_id,component_id:context.component_id,request_id:apiRequestId,ok:true,response:{status:response.status,ok:response.ok,content_type:response.headers.get("content-type")||"",body:body}},target.origin);
      }).catch(function(){
        frame.contentWindow&&frame.contentWindow.postMessage({type:"typeroll.extension.api.result",version:snapshot.protocol_version,installation_id:context.installation_id,component_id:context.component_id,request_id:apiRequestId,ok:false,error:"Extension API request failed"},target.origin);
      });
    }
  }
  window.addEventListener("message",receive);
  context.navigation.subscribe(function(view){frame.contentWindow&&frame.contentWindow.postMessage({type:"typeroll.extension.navigation",version:snapshot.protocol_version,installation_id:context.installation_id,component_id:context.component_id,view:view},target.origin);});
  frame.addEventListener("load",function(){frame.contentWindow.postMessage({type:"typeroll.extension.init",version:snapshot.protocol_version,installation_id:context.installation_id,component_id:context.component_id,props:entry.props,config:context.config,url_context:entry.capture.values,navigation:{current:context.navigation.current},form_bindings:context.forms.list()},target.origin);},{once:true});
}
async function start(){
  document.querySelectorAll("[data-tr-extension-installation][data-tr-extension-component]").forEach(function(el){
    var descriptor=findDescriptor(el);if(!descriptor)return;
    var props={};try{props=JSON.parse(el.getAttribute("data-block-data")||"{}");}catch(_){}
    mounts.push({el:el,descriptor:descriptor,props:props,capture:capture(descriptor.component)});
  });
  cleanUrl(mounts.map(function(entry){return entry.capture;}));
  mounts.forEach(function(entry){
    var context=contextFor(entry);
    if(entry.descriptor.component.render_mode==="embedded_app")mountFrame(entry,context);
    else mountBundle(entry,context).catch(function(){unavailable(entry.el,entry.descriptor.component);});
  });
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
})();`;
}
