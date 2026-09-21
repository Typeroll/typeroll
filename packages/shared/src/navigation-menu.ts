import type { BlockType } from './types.js';
import { pixels } from './presentation-fields.js';

/** Shared navigation or an independent mobile tree, enhanced into a small-screen modal. */
export const navigationMenu: BlockType = {
  id: 'core/navigation_menu', name: 'navigation_menu', label: 'Block menu', icon: 'menu', category: 'content', container: 'slots', slot_count: 2, slot_labels: ['Desktop / shared', 'Mobile override (optional)'],
  schema: [
    { name: 'aria_label', type: 'text', label: 'Accessible label', default: 'Main navigation' },
    { name: 'menu_label', type: 'text', label: 'Open label', default: 'Open menu' },
    { name: 'close_label', type: 'text', label: 'Close label', default: 'Close menu' },
    { name: 'collapse_below', type: 'select', label: 'Collapse below (px)', options: ['never', '576', '768', '769', '1024'], default: '1024' },
    pixels('toggle_size_px', 'Menu icon size (px)', 16, 64),
    pixels('close_size_px', 'Close icon size (px)', 16, 64),
    { name: 'panel_padding', type: 'select', label: 'Mobile panel inset', options: ['auto', 'none'], default: 'auto' },
    { name: 'background', type: 'color', label: 'Panel background', default: '#ffffff' },
  ],
  template: `<nav data-block="navigation_menu" data-collapse="{{collapse_below}}" data-mobile-override="{{menu_mobile_override}}" data-panel-padding="{{panel_padding}}" aria-label="{{aria_label}}" style="--menu-background:{{background}}"><button type="button" class="block-menu-open" aria-label="{{menu_label}}" aria-expanded="false"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button><div class="block-menu-content">{{slot:0}}{{children}}</div><div class="block-menu-mobile">{{slot:1}}</div><dialog class="block-menu-dialog" aria-label="{{aria_label}}"><button type="button" class="block-menu-close" aria-label="{{close_label}}"><svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m5 5 14 14M19 5 5 19"/></svg></button><div class="block-menu-scroll"></div></dialog></nav>`,
  styles: `
[data-block="navigation_menu"] { min-width:0; }
[data-block="navigation_menu"] > :is(.block-menu-open,.block-menu-mobile) { display:none; }
[data-block="navigation_menu"] :is(.block-menu-open,.block-menu-close) { min-width:44px; min-height:44px; padding:0; color:inherit; background:transparent; border:0; font:inherit; font-size:var(--toggle_size_px,28px); cursor:pointer; }
[data-block="navigation_menu"] :is(.block-menu-open,.block-menu-close) svg { display:block;width:var(--toggle_size_px,28px);height:var(--toggle_size_px,28px);margin:auto; }
[data-block="navigation_menu"] .block-menu-close svg { width:var(--close_size_px,var(--toggle_size_px,28px));height:var(--close_size_px,var(--toggle_size_px,28px)); }
[data-block="navigation_menu"] :is(a,button):focus-visible { outline:2px solid currentColor; outline-offset:3px; }
[data-block="navigation_menu"] .block-menu-dialog { position:fixed; inset:0; width:100%; height:100dvh; max-width:none; max-height:none; margin:0; padding:0; border:0; background:transparent; color:inherit; overflow:hidden; }
[data-block="navigation_menu"] .block-menu-dialog:not([open]) { display:none; }
[data-block="navigation_menu"] .block-menu-dialog::backdrop { background:transparent; }
[data-block="navigation_menu"] .block-menu-close { position:absolute; top:var(--menu-toggle-top,0px); left:var(--menu-toggle-left,0px); width:var(--menu-toggle-width,44px); height:var(--menu-toggle-height,44px); background:var(--menu-background,#fff); }
[data-block="navigation_menu"] .block-menu-scroll { position:absolute; inset:var(--menu-header-bottom,0px) 0 0; overflow:auto; overscroll-behavior:contain; background:var(--menu-background,#fff);padding:var(--space-4,1rem) var(--content-gutter,1.25rem); }
[data-block="navigation_menu"][data-panel-padding="none"] .block-menu-scroll { padding:0; }
${['576','768','769','1024'].map(width => `@media(max-width:${Number(width)-1}px) {
[data-block="navigation_menu"][data-collapse="${width}"][data-enhanced="true"] > .block-menu-open { display:inline-flex; align-items:center; justify-content:center; }
[data-block="navigation_menu"][data-collapse="${width}"][data-mobile-override="true"] > .block-menu-content { display:none; }
[data-block="navigation_menu"][data-collapse="${width}"][data-mobile-override="true"] > .block-menu-mobile { display:block; }
[data-block="navigation_menu"][data-collapse="${width}"][data-enhanced="true"] > :is(.block-menu-content,.block-menu-mobile) { display:none; }
}`).join('\n')}
`,
  script: `
window.TyperollBlocks = window.TyperollBlocks || { register(){}, init(){} };
window.TyperollBlocks.register('core/navigation_menu', el => {
  if (el.dataset.enhanced === 'true' || !['576','768','769','1024'].includes(el.dataset.collapse)) return;
  const button = el.querySelector(':scope > .block-menu-open');
  const content = el.querySelector(el.dataset.mobileOverride === 'true' ? ':scope > .block-menu-mobile' : ':scope > .block-menu-content');
  const dialog = el.querySelector(':scope > .block-menu-dialog');
  const closeButton = dialog?.querySelector('.block-menu-close');
  const scroll = dialog?.querySelector('.block-menu-scroll');
  if (!button || !content || !dialog || !closeButton || !scroll || typeof dialog.showModal !== 'function') return;
  const media = matchMedia('(max-width:' + (Number(el.dataset.collapse)-1) + 'px)');
  let previousOverflow = null;
  let removalObserver = null;
  const finish = restoreFocus => {
    removalObserver?.disconnect(); removalObserver = null;
    el.insertBefore(content, dialog);
    button.setAttribute('aria-expanded','false');
    if (previousOverflow !== null) { document.documentElement.style.overflow = previousOverflow; previousOverflow = null; }
    if (restoreFocus && media.matches && button.isConnected) button.focus();
  };
  const close = restoreFocus => { if (dialog.open) dialog.close(); finish(restoreFocus); };
  const position = () => {
    const rect = button.getBoundingClientRect();
    const header = el.closest('header,[data-header]');
    const bottom = Math.max(rect.bottom, header?.getBoundingClientRect().bottom || 0);
    dialog.style.setProperty('--menu-header-bottom', Math.min(bottom, innerHeight-44) + 'px');
    for (const [key,value] of Object.entries({ top:rect.top,left:rect.left,width:rect.width,height:rect.height })) dialog.style.setProperty('--menu-toggle-' + key, value + 'px');
  };
  button.addEventListener('click', () => {
    if (!media.matches || dialog.open) return;
    position(); scroll.append(content);
    try { dialog.showModal(); } catch { finish(false); return; }
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    button.setAttribute('aria-expanded','true'); closeButton.focus();
    removalObserver = new MutationObserver(() => { if (!el.isConnected) close(false); });
    removalObserver.observe(document.documentElement, { childList:true, subtree:true });
  });
  closeButton.addEventListener('click', () => close(true));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(true); });
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    const targets = [...dialog.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
    const first = targets[0], last = targets[targets.length-1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  dialog.addEventListener('close', () => { if (!dialog.open) finish(false); });
  dialog.addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('a[href]')) close(false); });
  media.addEventListener('change', () => close(false));
  window.addEventListener('resize', () => { if (dialog.open) position(); });
  el.dataset.enhanced = 'true';
});
`,
  origin:'core', created_at:'1970-01-01T00:00:00Z',
};

/** A semantic, styleable link group usable in a menu, footer or repeated item. */
export const navigationLinks: BlockType = {
  id:'core/navigation_links', name:'navigation_links', label:'Navigation links', icon:'list', category:'content', container:false,
  schema:[
    { name:'links', type:'array', label:'Links', fields:[{ name:'label', type:'text', label:'Label', required:true },{ name:'href', type:'url', label:'Link', required:true },{ name:'icon', type:'icon', label:'Icon (optional)' }] },
    { name:'direction', type:'select', label:'Direction', options:['row','column'], default:'column', responsive:true },
    { name:'font', type:'select',label:'Font',options:['inherit','body','heading'],default:'inherit' },
    pixels('icon_size_px','Link icon size (px)',8,96),pixels('icon_gap_px','Icon gap (px)',0,80),
    { name:'color', type:'color', label:'Link color' },
    { name:'density', type:'select', label:'Link density', options:['comfortable','compact-desktop','compact'], option_labels:['Comfortable','Compact on desktop','Compact at every width'], default:'comfortable', editor_group:'appearance' },
    { name:'font_weight', type:'select', label:'Weight', options:['400','500','600','700'], default:'400', responsive:true },
    pixels('font_size_px','Text size (px)',10,96),
    { name:'line_height', type:'number', label:'Line height', min:1,max:3,css_unit:'number',responsive:true,default:1.4 },
    pixels('link_min_height_px','Minimum link height (px)',24,120),
    pixels('gap_px','Gap (px)',0,120), pixels('padding_y_px','Link vertical padding (px)',0,80),
  ],
  template:`<ul data-block="navigation_links" data-font="{{font}}" data-density="{{density}}" style="--direction:{{direction}};--link_color:{{color}};--font_weight:{{font_weight}}">{{{navigation_links_html}}}</ul>`,
  styles:`[data-block="navigation_links"] { display:flex;flex-direction:var(--direction,column);flex-wrap:wrap;gap:var(--gap_px,8px);list-style:none;margin:0;padding:0; }
[data-block="navigation_links"] > li { min-width:0;max-width:100%;list-style:none;margin:0;padding:0; }
[data-block="navigation_links"] > li::marker { content:''; }
[data-block="navigation_links"] > li > a { display:flex;align-items:center;min-height:var(--link_min_height_px,44px);gap:var(--icon_gap_px,12px);color:var(--link_color,inherit);font-size:var(--font_size_px,inherit);line-height:var(--line_height,1.4);font-weight:var(--font_weight,400);padding-block:var(--padding_y_px,8px);text-decoration:none;overflow-wrap:anywhere; }
[data-block="navigation_links"][data-font="body"] { font-family:var(--font-body,inherit); }
[data-block="navigation_links"][data-font="heading"] { font-family:var(--font-heading,inherit); }
[data-block="navigation_links"] .block-nav-icon { font-size:var(--icon_size_px,24px);width:1em;flex:none;line-height:1; }
[data-block="navigation_links"] .block-nav-icon svg { width:1em;height:1em; }
[data-block="navigation_links"] a:hover { text-decoration:underline; }
[data-block="navigation_links"][data-density="compact"] { gap:var(--gap_px,4px); }
[data-block="navigation_links"][data-density="compact"] > li > a { min-height:var(--link_min_height_px,24px);padding-block:var(--padding_y_px,0px); }
@media (min-width:1024px) and (hover:hover) and (pointer:fine) {
  [data-block="navigation_links"][data-density="compact-desktop"] { gap:var(--gap_px,4px); }
  [data-block="navigation_links"][data-density="compact-desktop"] > li > a { min-height:var(--link_min_height_px,24px);padding-block:var(--padding_y_px,0px); }
}
[data-block="navigation_links"] a:focus-visible { outline:2px solid currentColor;outline-offset:3px; }`,
  origin:'core',created_at:'1970-01-01T00:00:00Z',
};
