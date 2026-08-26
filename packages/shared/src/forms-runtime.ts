// Forms 2.0 client runtime, shipped as an inline <script> with any page
// that renders a core/form block (same one-per-bundle model as
// BLOCKS_RUNTIME_CSS). Plain ES2019, no dependencies, ~3 KB.
//
// Progressive enhancement: without JS the <form> is a normal POST to the
// submit endpoint (HTML confirmation page — the 0.11.0 flow). With JS:
//   - intercepts submit, talks the v1 JSON protocol (`_protocol=1`)
//   - renders per-field errors into the blocks' error slots
//   - swaps prerendered static steps locally; injects server-rendered
//     html for dynamic steps
//   - promotes data-required → el.required (the template engine can't
//     conditionally emit bare attributes)
//   - slider value readout; proof-of-work computation (see below)
//
// Anti-abuse (forms.typeroll.com is very public):
//   - Proof-of-work: the form carries data-pow-bits + the token; the
//     runtime brute-forces a nonce so sha256(token + "." + bucket + "." +
//     nonce) has N leading zero bits, computed in the background on first
//     interaction so the user never waits. Submissions without _pow are
//     still accepted server-side but under a much stricter rate limit —
//     no-JS visitors keep working, bulk bots pay either CPU or throttle.
//   - The runtime only ever posts to the form's baked action URL.

export const FORMS_RUNTIME_VERSION = 1;

export const FORMS_RUNTIME_JS = String.raw`(function(){
"use strict";
function $(s,r){return (r||document).querySelector(s)}
function $all(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))}
function sha256(buf){return crypto.subtle.digest("SHA-256",buf)}
function leadZeroBits(bytes){var n=0;for(var i=0;i<bytes.length;i++){var b=bytes[i];if(b===0){n+=8;continue}while((b&128)===0){n++;b<<=1}break}return n}
async function computePow(seed,bits){var enc=new TextEncoder();for(var nonce=0;;nonce++){var d=await sha256(enc.encode(seed+"."+nonce));if(leadZeroBits(new Uint8Array(d))>=bits)return String(nonce);if(nonce%2000===1999)await new Promise(function(r){setTimeout(r,0)})}}
function fieldError(form,name,msg){var slot=$('[data-error-for="'+(window.CSS&&CSS.escape?CSS.escape(name):name)+'"]',form);var wrap=slot&&slot.closest(".form-field");if(slot){slot.textContent=msg;slot.hidden=!msg}if(wrap){if(msg)wrap.setAttribute("data-invalid","");else wrap.removeAttribute("data-invalid")}}
function clearErrors(form){$all(".form-field-error",form).forEach(function(e){e.hidden=true;e.textContent=""});$all("[data-invalid]",form).forEach(function(e){e.removeAttribute("data-invalid")});var top=$(".form-toplevel-error",form);if(top){top.hidden=true;top.textContent=""}}
function topError(form,msg){var el=$(".form-toplevel-error",form);if(el){el.textContent=msg;el.hidden=false;el.focus&&el.focus()}}
function showStep(form,id){var found=false;$all("[data-form-step]",form).forEach(function(el){var on=el.getAttribute("data-form-step")===id;el.hidden=!on;if(on)found=true});if(found){var h=$('[data-form-step="'+id+'"] h3, [data-form-step="'+id+'"] label',form);if(h){h.setAttribute("tabindex","-1");h.focus({preventScroll:false})}}return found}
// ── Remote-backed forms (prefill + session) ─────────────────────────────
// Two generic capabilities, declared per form, that the runtime implements
// without knowing which app asked for them:
//
//   data-tr-hydrate            GET the action and prefill fields from the
//                              response's fields: [{name, value}].
//   data-tr-session-param="t"  Exchange ?t= for a session token on first
//                              load, keep it for the tab, and send it as a
//                              bearer afterwards.
//
// A directory listing-edit form uses both. So would a booking amendment, an
// RSVP change, or a customer-portal detail form — none of which the forms
// module needs to hear about.
function wrapOf(form){return form.closest("[data-tr-form]")}
function sessKey(form){return "tr-form-"+(form.action||"")}
function sessGet(form){try{return sessionStorage.getItem(sessKey(form))||""}catch(e){return ""}}
function sessSet(form,v){try{v?sessionStorage.setItem(sessKey(form),v):sessionStorage.removeItem(sessKey(form))}catch(e){}}
function authHeaders(form){var t=sessGet(form);return t?{Authorization:"Bearer "+t}:{}}
function fillFields(form,fields){(fields||[]).forEach(function(f){
  var el=form.elements[f.name];if(!el||f.value==null)return;
  if(el.type==="checkbox"){el.checked=!!f.value}else{el.value=f.value}
})}
function expiredMsg(form){return form.getAttribute("data-msg-expired")||"This link is no longer valid. Please request a new one."}
async function remoteInit(form,param){
  var url=new URL(location.href);
  var one=param?url.searchParams.get(param):null;
  try{
    if(one){
      var res=await fetch(form.action+"?"+encodeURIComponent(param)+"="+encodeURIComponent(one),
        {headers:{Accept:"application/json"}});
      var data=await res.json().catch(function(){return null});
      if(!res.ok||!data){topError(form,expiredMsg(form));return}
      sessSet(form,data.session_token||"");
      // Drop the one-time token from the URL so it isn't left in history,
      // bookmarks, or the Referer of anything this page loads afterwards.
      url.searchParams.delete(param);
      history.replaceState(null,"",url.pathname+(url.search||"")+url.hash);
      fillFields(form,data.fields);
      return;
    }
    if(param&&!sessGet(form)){topError(form,expiredMsg(form));return}
    var r2=await fetch(form.action,{headers:Object.assign({Accept:"application/json"},authHeaders(form))});
    if(r2.ok){var d2=await r2.json().catch(function(){return null});if(d2)fillFields(form,d2.fields);return}
    if(param){sessSet(form,"");topError(form,expiredMsg(form))}
  }catch(e){topError(form,form.getAttribute("data-msg-fail")||"Something went wrong.")}
}
function init(form){
  $all("[data-required]",form).forEach(function(el){el.required=el.getAttribute("data-required")==="true"});
  $all('[data-block="form_slider"]',form).forEach(function(w){var inp=$("input[type=range]",w),out=$(".form-slider-value",w),unit=w.getAttribute("data-unit")||"";if(!inp||!out)return;var upd=function(){out.textContent=inp.value+(unit?" "+unit:"")};inp.addEventListener("input",upd);upd()});
  var wrap=wrapOf(form);
  var sessParam=wrap?wrap.getAttribute("data-tr-session-param"):null;
  var remote=!!sessParam||!!(wrap&&wrap.hasAttribute("data-tr-hydrate"));
  if(remote&&!form.__remoteReady){form.__remoteReady=true;remoteInit(form,sessParam)}
  var bits=parseInt(form.getAttribute("data-pow-bits")||"0",10);
  var token=(form.elements._token||{}).value||"";
  var powP=null,powStart=function(){if(!powP&&bits>0&&window.crypto&&crypto.subtle){var bucket=Math.floor(Date.now()/6e5);powP=computePow(token+"."+bucket,bits).then(function(n){return bucket+"."+n})}};
  form.addEventListener("focusin",powStart,{once:true});
  form.addEventListener("submit",async function(ev){
    ev.preventDefault();clearErrors(form);powStart();
    var btn=$('[type="submit"]',form);if(btn)btn.disabled=true;
    try{
      var fd=new FormData(form);fd.set("_protocol","1");
      if(powP){try{fd.set("_pow",await powP)}catch(e){}}
      var hdrs=Object.assign({Accept:"application/json"},sessParam?authHeaders(form):{});
      var res=await fetch(form.action,{method:"POST",body:fd,headers:hdrs});
      var out=await res.json().catch(function(){return null});
      if(!out){topError(form,form.getAttribute("data-msg-fail")||"Something went wrong.");return}
      if(out.ok===false){
        (out.errors||[]).forEach(function(e){if(e.field)fieldError(form,e.field,e.message);else topError(form,e.message)});
        var first=$("[data-invalid] .form-input, [data-invalid] input",form);if(first)first.focus();
        return;
      }
      if(out.state&&form.elements._state)form.elements._state.value=out.state;
      powP=null;if(bits>0)powStart();
      if(out.done){
        var region=form.closest("[data-tr-form]")||form;
        if(out.html){region.innerHTML=out.html}else{region.innerHTML='<div class="form-done" role="status">'+(form.getAttribute("data-msg-done")||"Thanks!")+"</div>"}
        return;
      }
      if(out.html){
        var dyn=$("[data-form-dynamic-step]",form);
        if(dyn){dyn.innerHTML=out.html;$all("[data-form-step]",form).forEach(function(el){el.hidden=true});dyn.hidden=false;init(form)}
      }else if(out.next_step){showStep(form,out.next_step)}
    }catch(e){topError(form,form.getAttribute("data-msg-fail")||"Something went wrong.")}
    finally{if(btn)btn.disabled=false}
  });
}
function boot(){$all("form[data-tr-form-el]").forEach(init)}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();`;
