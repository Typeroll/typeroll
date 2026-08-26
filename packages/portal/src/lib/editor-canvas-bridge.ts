export const EDITOR_CANVAS_PROTOCOL_VERSION = 1;

/**
 * Runs inside an opaque-origin editor canvas. It is intentionally small and
 * owns no portal authority: it reports annotated block interactions and
 * accepts visual commands only. The parent remains the source of truth and
 * validates the iframe Window, canvas id and protocol on every message.
 */
export function editorCanvasBridgeScript(canvasId: string, interactive = true): string {
  const id = JSON.stringify(canvasId).replace(/</g, '\\u003c');
  return `(function(){
"use strict";
var version=${EDITOR_CANVAS_PROTOCOL_VERSION};var canvasId=${id};var interactive=${interactive};var editing=null;var original="";var raf=0;
function send(type,payload){parent.postMessage(Object.assign({channel:"typeroll.editor-canvas",version:version,canvas_id:canvasId,type:type},payload||{}),"*");}
function idsFrom(target){var ids=[];var node=target instanceof Element?target:null;while(node){var id=node.getAttribute&&node.getAttribute("data-block-id");if(id&&!ids.includes(id))ids.push(id);node=node.parentElement;}return ids;}
function geometry(){raf=0;var blocks=[];document.querySelectorAll("[data-block-id]").forEach(function(node){var r=node.getBoundingClientRect();blocks.push({id:node.getAttribute("data-block-id"),left:r.left,top:r.top,width:r.width,height:r.height});});var b=document.body.getBoundingClientRect();send("geometry",{blocks:blocks,body:{left:b.left,top:b.top,width:b.width,height:b.height},scroll_y:scrollY});}
function scheduleGeometry(){if(!raf)raf=requestAnimationFrame(geometry);}
function finish(cancel){if(!editing)return;var el=editing;editing=null;el.removeAttribute("contenteditable");var parts=(el.getAttribute("data-edit")||"").split(":");var value=el.textContent||"";if(cancel||value===original||!parts[0]||!parts[1]){el.textContent=original;}else{send("edit",{block_id:parts[0],field:parts.slice(1).join(":"),value:value});}}
if(interactive){
document.addEventListener("click",function(event){if(editing&&event.target instanceof Node&&editing.contains(event.target))return;if(editing)finish(false);event.preventDefault();event.stopPropagation();send("select",{ancestor_ids:idsFrom(event.target)});},true);
document.addEventListener("dblclick",function(event){var el=event.target instanceof Element?event.target.closest("[data-edit]"):null;if(!el)return;event.preventDefault();event.stopPropagation();finish(false);editing=el;original=el.textContent||"";el.setAttribute("contenteditable","plaintext-only");if(!el.isContentEditable)el.setAttribute("contenteditable","true");el.focus();var selection=getSelection(),range=document.createRange();range.selectNodeContents(el);selection&&selection.removeAllRanges();selection&&selection.addRange(range);send("select",{ancestor_ids:idsFrom(el)});},true);
document.addEventListener("focusout",function(event){if(editing&&event.target===editing)finish(false);},true);
document.addEventListener("keydown",function(event){if(!editing)return;if(event.key==="Escape"){event.preventDefault();finish(true);}else if(event.key==="Enter"){event.preventDefault();editing.blur();}},true);
document.addEventListener("mousemove",function(event){send("hover",{ancestor_ids:idsFrom(event.target)});},{passive:true});
document.addEventListener("mouseleave",function(){send("hover",{ancestor_ids:[]});});
}
addEventListener("scroll",function(){send("scroll",{scroll_y:scrollY});scheduleGeometry();},{passive:true});
addEventListener("resize",scheduleGeometry,{passive:true});
addEventListener("message",function(event){var data=event.data;if(event.source!==parent||!data||data.channel!=="typeroll.editor-canvas"||data.version!==version||data.canvas_id!==canvasId)return;
  if(data.action==="highlight"){document.querySelectorAll("[data-tr-editor-highlight]").forEach(function(el){el.removeAttribute("data-tr-editor-highlight");el.style.outline="";el.style.outlineOffset="";});var selected=data.selected_id&&document.querySelector('[data-block-id="'+CSS.escape(data.selected_id)+'"]');var hovered=data.hover_id&&document.querySelector('[data-block-id="'+CSS.escape(data.hover_id)+'"]');if(hovered){hovered.setAttribute("data-tr-editor-highlight","hover");hovered.style.outline="2px dashed #818cf8";hovered.style.outlineOffset="-2px";}if(selected){selected.setAttribute("data-tr-editor-highlight","selected");selected.style.outline="2px solid #4f46e5";selected.style.outlineOffset="-2px";}}
  if(data.action==="indicator"){var indicator=document.querySelector("[data-tr-drop-indicator]");if(!data.rect){if(indicator)indicator.style.display="none";return;}if(!indicator){indicator=document.createElement("div");indicator.setAttribute("data-tr-drop-indicator","");indicator.style.cssText="position:fixed;height:3px;background:#6366f1;border-radius:2px;box-shadow:0 0 8px rgba(99,102,241,.9);z-index:2147483647;pointer-events:none";document.body.appendChild(indicator);}indicator.style.left=data.rect.left+"px";indicator.style.top=(data.rect.top-1.5)+"px";indicator.style.width=data.rect.width+"px";indicator.style.display="block";}
  if(data.action==="scroll"&&Number.isFinite(data.scroll_y))scrollTo(0,data.scroll_y);
  if(data.action==="placeholders"&&data.labels&&typeof data.labels==="object"){var style=document.getElementById("__tr_ph_style");if(!style){style=document.createElement("style");style.id="__tr_ph_style";style.textContent="[data-empty-label]{position:relative;min-height:2.5em;outline:1px dashed rgba(99,102,241,.45);outline-offset:-1px}[data-empty-label]::after{content:attr(data-empty-label);position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(120,120,140,.8);font:italic 500 14px/1.4 -apple-system,system-ui,sans-serif;pointer-events:none}";document.head.appendChild(style);}Object.keys(data.labels).slice(0,1000).forEach(function(id){var el=document.querySelector('[data-block-id="'+CSS.escape(id)+'"]');if(el)el.setAttribute("data-empty-label",String(data.labels[id]).slice(0,100));});scheduleGeometry();}
  if(data.action==="geometry")geometry();
});
if(typeof ResizeObserver!=="undefined")new ResizeObserver(scheduleGeometry).observe(document.body);
send("ready");scheduleGeometry();send("scroll",{scroll_y:scrollY});
})();`;
}
