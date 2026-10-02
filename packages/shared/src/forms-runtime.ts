// Forms 2.0 client runtime, shipped as an inline <script> with any page
// that renders a core/form block (same one-per-bundle model as
// BLOCKS_RUNTIME_CSS). Plain ES2019, no dependencies, ~3 KB.
//
// Progressive enhancement: without JS the <form> is a normal POST to the
// submit endpoint (HTML confirmation page — the 0.11.0 flow). With JS:
//   - intercepts submit, talks the v1 JSON protocol (`_protocol=1`)
//   - renders per-field errors into the blocks' error slots
//   - swaps prerendered static steps locally; injects server-rendered
//     html for dynamic steps; Back, per-step button labels, progress and
//     step announcements (see "Step navigation" below)
//   - promotes data-required → el.required (the template engine can't
//     conditionally emit bare attributes)
//   - disables the controls of hidden steps, so native validation and the
//     posted FormData cover the visible step only
//   - slider value readout; proof-of-work computation (see below)
//   - preview mode (data-tr-preview): simulates the submit endpoint in the
//     browser and sends nothing (see "Preview mode" below)
//
// Anti-abuse (forms.typeroll.com is very public):
//   - Proof-of-work: the form carries data-pow-bits + the token; the
//     runtime brute-forces a nonce so sha256(token + "." + bucket + "." +
//     nonce) has N leading zero bits, computed in the background on first
//     interaction so the user never waits. Submissions without _pow are
//     still accepted server-side but under a much stricter rate limit —
//     no-JS visitors keep working, bulk bots pay either CPU or throttle.
//   - The runtime only ever posts to the form's baked action URL.

export const FORMS_RUNTIME_VERSION = 2;

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
// Native constraint validation must only see the visible step. Hidden steps
// stay in the one <form>, so their required controls would block every
// submit ("An invalid form control is not focusable"). Disabled controls are
// barred from validation in every engine and are not posted; the server only
// accepts the current step's declared fields, so nothing it expects is lost.
// data-tr-step-off marks the controls the runtime disabled, so controls an
// author disabled stay disabled when their step is shown.
function setStepActive(el,on){$all("input,select,textarea,button",el).forEach(function(c){if(on){if(c.hasAttribute("data-tr-step-off")){c.removeAttribute("data-tr-step-off");c.disabled=false}}else if(!c.disabled){c.disabled=true;c.setAttribute("data-tr-step-off","")}})}
function syncSteps(form){$all("[data-form-step], [data-form-dynamic-step]",form).forEach(function(el){setStepActive(el,!el.hidden)})}
// ── Step navigation ─────────────────────────────────────────────────────
// form.__trSteps is the visitor's way through the form: one entry per step
// shown, the current one last. Back pops it and shows the previous step
// with its values (they stay in the DOM, only disabled while hidden); it
// sends nothing. A dynamic step's markup is kept on its entry when another
// dynamic step replaces it. After every change the submit button takes the
// step's label (data-submit-label), Back shows from the second step, the
// progress indicator moves and a polite live region announces the step.
function dynOf(form){return $("[data-form-dynamic-step]",form)}
function focusStep(el){var h=el&&$("h1, h2, h3, h4, h5, h6, legend, label",el);if(h){if(!h.hasAttribute("tabindex"))h.setAttribute("tabindex","-1");h.focus({preventScroll:false})}}
function showStep(form,id){var found=false;$all("[data-form-step]",form).forEach(function(el){var on=el.getAttribute("data-form-step")===id;el.hidden=!on;if(on)found=true});var dyn=dynOf(form);if(found&&dyn)dyn.hidden=true;syncSteps(form);if(found)focusStep($('[data-form-step="'+id+'"]',form));return found}
function currentStep(form){var dyn=dynOf(form);if(dyn&&!dyn.hidden)return dyn;return $all("[data-form-step]",form).filter(function(el){return !el.hidden})[0]||null}
function stepTrail(form){if(!form.__trSteps){var el=currentStep(form);form.__trSteps=[{id:el?el.getAttribute("data-form-step")||"":"",dyn:false}]}return form.__trSteps}
function announcer(form){var el=form.__trLive;if(!el){el=document.createElement("div");el.className="form-step-status";el.setAttribute("aria-live","polite");el.style.cssText="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";form.appendChild(el);form.__trLive=el}return el}
function stepChanged(form,announce){
  var trail=stepTrail(form),el=currentStep(form),btn=$('[type="submit"]',form);
  if(btn){if(form.__trLabel==null)form.__trLabel=btn.textContent;var label=(el&&el.getAttribute("data-submit-label"))||form.__trLabel;if(btn.textContent!==label)btn.textContent=label}
  var back=$("[data-form-back]",form);if(back)back.hidden=trail.length<2;
  var text="",progress=$("[data-form-progress]",form);
  if(progress){var total=parseInt(progress.getAttribute("data-progress-total")||"1",10)||1,n=Math.min(trail.length,total);text=(progress.getAttribute("data-progress-template")||"{n} / {total}").replace("{n}",n).replace("{total}",total);var t=$(".form-progress-text",progress),fill=$(".form-progress-fill",progress);if(t)t.textContent=text;if(fill)fill.style.width=Math.round(10000*n/total)/100+"%"}
  if(announce){var h=el&&$("h1, h2, h3, h4, h5, h6, legend",el),l=el&&$("label",el);announcer(form).textContent=[text,h?h.textContent.trim():l?l.textContent.trim():""].filter(Boolean).join(": ")}
}
function goToStep(form,id){if(!showStep(form,id))return false;stepTrail(form).push({id:id,dyn:false});stepChanged(form,true);return true}
function dynLabel(form,out){return out.submit_label||(out.final?form.getAttribute("data-label-final"):form.getAttribute("data-label-continue"))||""}
function enterDynamic(form,dyn,entry){$all("[data-form-step]",form).forEach(function(el){el.hidden=true});dyn.hidden=false;dyn.setAttribute("data-step-id",entry.id);if(entry.label)dyn.setAttribute("data-submit-label",entry.label);else dyn.removeAttribute("data-submit-label")}
function goToDynamic(form,html,out){var dyn=dynOf(form);if(!dyn)return;var trail=stepTrail(form),top=trail[trail.length-1];if(top&&top.dyn)top.nodes=Array.prototype.slice.call(dyn.childNodes);dyn.innerHTML=html;var entry={id:out.step||"",dyn:true,label:dynLabel(form,out)};enterDynamic(form,dyn,entry);trail.push(entry);init(form);stepChanged(form,true);focusStep(dyn)}
function goBack(form){var trail=stepTrail(form);if(trail.length<2)return;trail.pop();var to=trail[trail.length-1],dyn=dynOf(form);clearErrors(form);
  if(to.dyn&&dyn){if(to.nodes){dyn.replaceChildren.apply(dyn,to.nodes);to.nodes=null}enterDynamic(form,dyn,to);syncSteps(form);focusStep(dyn)}else showStep(form,to.id);
  stepChanged(form,true)}
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
function fillFields(form,fields){form.__remoteFields=fields||[];(fields||[]).forEach(function(f){
  var el=form.elements[f.name];
  if(!el&&f.type==="hidden"){el=document.createElement("input");el.type="hidden";el.name=f.name;form.appendChild(el)}
  if(!el)return;
  if(f.type==="hidden"&&el.tagName==="INPUT")el.type="hidden";
  var controls=el.length!==undefined&&!el.tagName?Array.from(el):[el];
  controls.forEach(function(input){
    if(input.type==="radio")input.checked=f.value!=null&&input.value===String(f.value);
    else if(input.type==="checkbox")input.checked=Array.isArray(f.value)?f.value.indexOf(input.value)!==-1:f.value===true;
    else if(input.tagName==="SELECT"&&input.multiple)Array.from(input.options).forEach(function(o){o.selected=Array.isArray(f.value)&&f.value.indexOf(o.value)!==-1});
    else input.value=f.value==null?"":typeof f.value==="object"?JSON.stringify(f.value):String(f.value);
    if(f.allowed_domains&&input.type==="email"){
      var help=document.createElement("p");help.className="form-field-help";help.textContent="Use a work email on "+f.allowed_domains.join(" or ")+". Two links per profile in 24 hours.";
      help.id="domain-"+f.name;input.insertAdjacentElement("afterend",help);input.setAttribute("aria-describedby",help.id);
      input.addEventListener("input",function(){var host="";try{host=new URL("https://"+input.value.trim().split("@").pop()).hostname.toLowerCase().replace(/\.$/,"").replace(/^www\./,"")}catch(e){}
        var invalid=input.value&&f.allowed_domains.indexOf(host)===-1;input.setCustomValidity(invalid?"Use a work email on "+f.allowed_domains.join(" or "):"");input.setAttribute("aria-invalid",String(!!invalid));help.textContent=invalid?input.validationMessage:"Use a work email on "+f.allowed_domains.join(" or ")+". Two links per profile in 24 hours.";});
    }
  });
});form.__remoteBaseline={};(fields||[]).forEach(function(f){form.__remoteBaseline[f.name]=JSON.stringify(readRemoteField(form,f))})}
function readRemoteField(form,f){var el=form.elements[f.name];if(!el)return undefined;
  var controls=el.length!==undefined&&!el.tagName?Array.from(el):[el];
  if(f.type==="boolean"){var radio=controls.find(function(i){return i.type==="radio"&&i.checked});return radio?radio.value==="true":controls[0].type==="checkbox"?controls[0].checked:null}
  if(f.type==="multiselect"||f.type==="page_ref_list")return controls[0].tagName==="SELECT"?Array.from(controls[0].selectedOptions).map(function(o){return o.value}):controls.filter(function(i){return i.checked}).map(function(i){return i.value});
  var value=controls[0].value;if(f.type==="number")return value===""?null:Number(value);
  if(["object","array","list"].indexOf(f.type)!==-1){if(!value.trim())return null;try{return JSON.parse(value)}catch(e){throw Error("Invalid structured answer")}}
  return value;
}
function hydrated(form,data){fillFields(form,data.fields);form.__hydrated=true;form.__baseRevision=data.revision||"";form.__requestId=crypto.randomUUID();
  if(data.title){var title=document.createElement("p");title.textContent=data.title;form.prepend(title)}
  form.addEventListener("input",function(){form.__requestId=crypto.randomUUID()});
}
function expiredMsg(form){return form.getAttribute("data-msg-expired")||"This link is no longer valid. Please request a new one."}
async function remoteInit(form,param){
  var url=new URL(location.href);
  var one=param?url.searchParams.get(param):null;
  try{
    if(one){
      var exchange=new URL(form.action,location.href);exchange.searchParams.set(param,one);
      var res=await fetch(exchange.href,
        {headers:{Accept:"application/json"}});
      var data=await res.json().catch(function(){return null});
      if(!res.ok||!data){topError(form,expiredMsg(form));return}
      sessSet(form,data.session_token||"");
      // Drop the one-time token from the URL so it isn't left in history,
      // bookmarks, or the Referer of anything this page loads afterwards.
      url.searchParams.delete(param);
      history.replaceState(null,"",url.pathname+(url.search||"")+url.hash);
      hydrated(form,data);
      return;
    }
    if(param&&!sessGet(form)){topError(form,expiredMsg(form));return}
    var r2=await fetch(form.action,{headers:Object.assign({Accept:"application/json"},authHeaders(form))});
    if(r2.ok){var d2=await r2.json().catch(function(){return null});if(d2)hydrated(form,d2);return}
    if(param){sessSet(form,"");topError(form,expiredMsg(form))}
  }catch(e){topError(form,form.getAttribute("data-msg-fail")||"Something went wrong.")}
}
// ── Preview mode ────────────────────────────────────────────────────────
// Portal previews render the form with data-tr-preview: the step graph and
// the submit endpoint's field rules and messages (formPreviewSteps). The
// runtime then plays the endpoint's part in the browser: it validates the
// visible step like the server, advances steps and completes with the
// success message, or names the redirect target instead of leaving the
// preview. It never sends a request. Only the portal's preview renderer
// emits the attribute; the published site's markup never carries it.
var EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function previewSteps(form){try{var steps=JSON.parse(form.getAttribute("data-tr-preview")||"[]");return Array.isArray(steps)?steps:[]}catch(e){return []}}
function previewValue(fd,f){var all=fd.getAll(f.name).map(String);if(f.list)return all.filter(function(v){return v!==""});if(!all.length)return undefined;var v=all[all.length-1];if(f.type==="boolean")return v==="true"?true:v==="false"?false:v===""||v==="null"?null:v;return v}
function previewErrors(step,fd){var errs=[];((step&&step.fields)||[]).forEach(function(f){
  var raw=previewValue(fd,f),str=raw==null?"":String(raw).trim(),code=null;
  if(f.required&&str==="")code="required";
  else if(str!==""){
    if(f.type==="boolean"&&raw!==true&&raw!==false&&raw!=="null")code="invalid_boolean";
    else if(f.type==="email"&&!EMAIL_RE.test(str))code="invalid_email";
    else{
      if(f.pattern){try{if(!new RegExp("^(?:"+f.pattern+")$").test(str))code="pattern"}catch(e){}}
      if(!code&&f.type==="number"){var n=Number(str);if(f.min!=null&&n<f.min)code="min";else if(f.max!=null&&n>f.max)code="max"}
      else if(!code){if(f.min!=null&&str.length<f.min)code="min";else if(f.max!=null&&str.length>f.max)code="max"}
    }
  }
  if(code)errs.push({field:f.name,code:code,message:(f.messages&&f.messages[code])||code});
});return errs}
function previewDone(form){
  var region=wrapOf(form)||form,notice=$(".form-preview-notice",form),redirect=form.getAttribute("data-redirect")||"";
  var done=document.createElement("div");done.className="form-done";done.setAttribute("role","status");
  if(redirect)done.textContent=(form.getAttribute("data-msg-redirect")||"Preview – would redirect to")+" "+redirect;
  else done.innerHTML=form.getAttribute("data-msg-done")||"Thanks!";
  region.replaceChildren();if(notice)region.append(notice);region.append(done);
}
function previewSubmit(form){
  var visible=$all("[data-form-step]",form).filter(function(el){return !el.hidden})[0];
  var id=visible?visible.getAttribute("data-form-step"):"";
  var step=previewSteps(form).find(function(s){return s.id===id});
  var errs=previewErrors(step,new FormData(form));
  if(errs.length){errs.forEach(function(e){fieldError(form,e.field,e.message)});var first=$("[data-invalid] .form-input, [data-invalid] input",form);if(first)first.focus();return}
  if(step&&step.next&&goToStep(form,step.next))return;
  previewDone(form);
}
function init(form){
  $all("[data-required]",form).forEach(function(el){el.required=el.getAttribute("data-required")==="true"});
  $all('[data-block="form_slider"]',form).forEach(function(w){var inp=$("input[type=range]",w),out=$(".form-slider-value",w),unit=w.getAttribute("data-unit")||"";if(!inp||!out||w.__trReady)return;w.__trReady=true;var upd=function(){out.textContent=inp.value+(unit?" "+unit:"")};inp.addEventListener("input",upd);upd()});
  $all('[data-clear-answer]',form).forEach(function(button){if(button.__trReady)return;button.__trReady=true;button.addEventListener("click",function(){var name=button.getAttribute("data-clear-answer");$all('input[type=radio]',button.parentElement).forEach(function(input){input.checked=false});form.__cleared=form.__cleared||{};form.__cleared[name]=true;form.dispatchEvent(new Event("input",{bubbles:true}))})});
  syncSteps(form);
  // init runs again after a dynamic step is injected so its new fields get
  // the enhancements above; listeners on the form itself bind only once, or
  // every later submit would post twice.
  if(form.__trBound)return;form.__trBound=true;
  announcer(form);stepChanged(form,false);
  var back=$("[data-form-back]",form);if(back)back.addEventListener("click",function(){goBack(form)});
  var wrap=wrapOf(form);
  if(wrap){try{var context=JSON.parse(wrap.getAttribute("data-tr-context-params")||"[]"),action=new URL(form.action),source=new URL(location.href);context.forEach(function(key){if(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)&&["issuer","org_id","site_id","installation_id","session","token","grant"].indexOf(key)===-1&&key!==wrap.getAttribute("data-tr-session-param")&&source.searchParams.has(key))action.searchParams.set(key,source.searchParams.get(key))});form.action=action.href}catch(e){}}
  var preview=form.hasAttribute("data-tr-preview");
  var sessParam=wrap?wrap.getAttribute("data-tr-session-param"):null;
  var remote=!preview&&(!!sessParam||!!(wrap&&wrap.hasAttribute("data-tr-hydrate")));
  if(remote&&!form.__remoteReady){form.__remoteReady=true;remoteInit(form,sessParam)}
  var bits=preview?0:parseInt(form.getAttribute("data-pow-bits")||"0",10);
  var token=(form.elements._token||{}).value||"";
  var powP=null,powStart=function(){if(!powP&&bits>0&&window.crypto&&crypto.subtle){var bucket=Math.floor(Date.now()/6e5);powP=computePow(token+"."+bucket,bits).then(function(n){return bucket+"."+n})}};
  form.addEventListener("focusin",powStart,{once:true});
  form.addEventListener("submit",async function(ev){
    ev.preventDefault();clearErrors(form);if(preview){previewSubmit(form);return}if(remote&&!form.__hydrated){topError(form,"Wait for the form to load before submitting. If loading failed, reload this page.");return}powStart();
    var btn=$('[type="submit"]',form);if(btn)btn.disabled=true;
    try{
      var fd=new FormData(form);fd.set("_protocol","1");
      // With Back, a visitor may send an earlier step again: name the step,
      // so the server updates the same partial submission.
      if(back){var trail=stepTrail(form);fd.set("_step",trail[trail.length-1].id)}
      var renderVersion=form.getAttribute("data-render-version");if(renderVersion)fd.set("_rv",renderVersion);
      if(remote)$all('[data-block="form_checkbox_group"]',form).forEach(function(group){var input=$('input[type="checkbox"]',group);if(input&&!input.disabled&&!fd.has(input.name))fd.set(input.name,"")});
      $all('[data-block="form_boolean"]',form).forEach(function(group){var first=$("input[type=radio]",group);if(first&&!fd.has(first.name)&&form.__cleared&&form.__cleared[first.name])fd.set(first.name,"null")});
      if(remote&&form.__remoteFields){
        fd.set("_request_id",form.__requestId||crypto.randomUUID());
        fd.set("request_id",form.__requestId||crypto.randomUUID());
        if(form.__baseRevision)fd.set("_base_revision",form.__baseRevision);
        form.__remoteFields.forEach(function(f){
          var value=readRemoteField(form,f);
          if(form.__baseRevision&&JSON.stringify(value)===form.__remoteBaseline[f.name]){fd.delete(f.name);return}
          if(value===undefined)return;
          fd.delete(f.name);
          if(Array.isArray(value)&&["multiselect","page_ref_list"].indexOf(f.type)!==-1){if(!value.length)fd.set(f.name,"");else value.forEach(function(v){fd.append(f.name,v)})}
          else fd.set(f.name,value===null?"null":typeof value==="object"?JSON.stringify(value):String(value));
        });
      }
      if(powP){try{fd.set("_pow",await powP)}catch(e){}}
      var hdrs=Object.assign({Accept:"application/json"},sessParam?authHeaders(form):{});
      var res=await fetch(form.action,{method:"POST",body:fd,headers:hdrs});
      var out=await res.json().catch(function(){return null});
      if(!out){topError(form,form.getAttribute("data-msg-fail")||"Something went wrong.");return}
      if(!res.ok||out.ok===false){
        if(out.message||out.error)topError(form,(out.message||out.error)+(out.retry_after?" Try again in "+Math.ceil(out.retry_after/3600)+" hour(s).":""));
        (out.errors||[]).forEach(function(e){if(e.field)fieldError(form,e.field,e.message);else topError(form,e.message)});
        var first=$("[data-invalid] .form-input, [data-invalid] input",form);if(first)first.focus();
        return;
      }
      if(out.state&&form.elements._state)form.elements._state.value=out.state;
      powP=null;if(bits>0)powStart();
      if(out.done){
        var redirect=form.getAttribute("data-redirect")||"";
        if(/^(https?:\/\/|\/(?![\/\\]))/i.test(redirect)){location.assign(redirect);return}
        var region=form.closest("[data-tr-form]")||form;
        if(out.message){region.replaceChildren();var message=document.createElement("div");message.className="form-done";message.setAttribute("role","status");message.textContent=out.message;region.append(message)}else if(out.html){region.innerHTML=out.html}else{region.innerHTML='<div class="form-done" role="status">'+(form.getAttribute("data-msg-done")||"Thanks!")+"</div>"}
        return;
      }
      if(out.html)goToDynamic(form,out.html,out);
      else if(out.next_step)goToStep(form,out.next_step);
    }catch(e){topError(form,form.getAttribute("data-msg-fail")||"Something went wrong.")}
    finally{if(btn)btn.disabled=false}
  });
}
function boot(){$all("form[data-tr-form-el]").forEach(init)}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();`;
