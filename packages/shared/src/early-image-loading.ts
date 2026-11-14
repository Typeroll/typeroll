/**
 * Start loading lazy images well before they scroll into view.
 *
 * Browsers start a `loading="lazy"` image only shortly before it enters the
 * viewport (Safari and Firefox close to the edge), so on a fast scroll it is
 * still blank when it appears. This runtime switches each lazy image to eager
 * when it comes within two screen heights, so it has loaded by the time it is
 * scrolled in, while images further down still wait. The root is the
 * document itself, so the margin also applies inside a framed preview, where
 * an implicit root ignores it.
 *
 * Inline in every page, after the body: must stay self-contained and must
 * never contain a literal "</script".
 */
export const EARLY_IMAGE_LOADING_RUNTIME_JS = `(function(){"use strict";
if(typeof IntersectionObserver!=="function")return;
var MARGIN="200% 0px 200% 0px",seen=typeof WeakSet==="function"?new WeakSet():null,observer;
function load(entries){for(var i=0;i<entries.length;i++){var entry=entries[i];if(!entry.isIntersecting)continue;observer.unobserve(entry.target);if(entry.target.getAttribute("loading")==="lazy")entry.target.setAttribute("loading","eager");}}
try{observer=new IntersectionObserver(load,{root:document,rootMargin:MARGIN});}catch(_){observer=new IntersectionObserver(load,{rootMargin:MARGIN});}
function scan(){var images=document.querySelectorAll('img[loading="lazy"]');for(var i=0;i<images.length;i++){var image=images[i];if(seen){if(seen.has(image))continue;seen.add(image);}observer.observe(image);}}
scan();
if(typeof MutationObserver==="function"){var pending=false;new MutationObserver(function(){if(pending)return;pending=true;setTimeout(function(){pending=false;scan();},100);}).observe(document.documentElement,{childList:true,subtree:true});}
})();`;
