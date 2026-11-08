import type { BlockType } from './types.js';
import { pixels } from './presentation-fields.js';

/** Shared navigation or an independent mobile tree, enhanced into a small-screen modal. */
export const navigationMenu: BlockType = {
  id: 'core/navigation_menu', name: 'navigation_menu', label: 'Block menu', icon: 'menu', category: 'content', container: 'slots', slot_count: 2, slot_labels: ['Desktop / shared', 'Mobile override (optional)'],
  schema: [
    { name: 'aria_label', type: 'text', label: 'Accessible label', default: 'Main navigation' },
    { name: 'menu_label', type: 'text', label: 'Open label', default: 'Open menu', ui_text: 'open_menu' },
    { name: 'close_label', type: 'text', label: 'Close label', default: 'Close menu', ui_text: 'close_menu' },
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
    if ((!media.matches && !el.closest('[data-header-compact]')) || dialog.open) return;
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

const NAVIGATION_LIST_TEMPLATE = `<ul data-block="navigation_links" data-font="{{font}}" data-density="{{density}}" style="--direction:{{direction}};--link_color:{{color}};--font_weight:{{font_weight}}">{{{navigation_links_html}}}</ul>`;

/**
 * From render version 13 a group label titles the list. The block then wraps
 * a visible label and the list that names itself after it (aria-labelledby).
 * The label is not a heading, so a menu repeated on every page adds nothing
 * to the page outline. It takes the site's Eyebrow style unless another is
 * chosen. Without a label the block renders the bare list.
 */
const LABELLED_NAVIGATION_TEMPLATE = `{{#group_label}}<div data-block="navigation_links" data-labelled="true" data-font="{{font}}" data-density="{{density}}" style="--direction:{{direction}};--link_color:{{color}};--font_weight:{{font_weight}}"><div class="block-nav-label {{group_label_class}}" id="{{navigation_label_id}}">{{group_label}}</div><ul class="block-nav-list" aria-labelledby="{{navigation_label_id}}">{{{navigation_links_html}}}</ul></div>{{/group_label}}{{^group_label}}${NAVIGATION_LIST_TEMPLATE}{{/group_label}}`;

/**
 * The list's item rules select `li` as a descendant instead of a child, so
 * they reach the list inside a labelled block too. The block holds no other
 * list items, and the specificity is unchanged, so a bare list renders as
 * before and a site's overrides keep applying.
 */
const itemsAnyDepth = (css: string) => css.replace(/\] > li\b/g, '] li');

const LABELLED_NAVIGATION_CSS = `[data-block="navigation_links"][data-labelled="true"] { display:block; }
[data-block="navigation_links"] > .block-nav-list { display:flex;flex-direction:var(--direction,column);flex-wrap:wrap;gap:inherit;list-style:none;margin:0;padding:0;min-width:0; }
[data-block="navigation_links"] > .block-nav-label { margin:0 0 var(--space-xs,.25rem);font-family:var(--font-body,inherit);font-size:.75rem;font-weight:600;line-height:1.5;letter-spacing:.08em;text-transform:uppercase;color:var(--color-text-light,currentColor);overflow-wrap:anywhere; }
[data-block="navigation_links"][data-labelled="true"]:not(:first-child) > .block-nav-label { margin-top:var(--space-md,1.25rem); }`;

/** A semantic, styleable link group usable in a menu, footer or repeated item. */
export const navigationLinks: BlockType = {
  id:'core/navigation_links', name:'navigation_links', label:'Navigation links', icon:'list', category:'content', container:false,
  // The current page's link is declared after the links, so its style wins
  // where both set a property; hover comes from the link style.
  parts:[
    // `li` at any depth: a block with a group label wraps its list.
    { name:'link', label:'Links', selector:'li > a', target:'link' },
    { name:'current_link', label:'Link to the current page', selector:'li > a[aria-current="page"]', target:'link' },
    { name:'icon', label:'Link icons', selector:'li > a > .block-nav-icon', target:'text', decorative:true },
    { name:'group_label', label:'Group label', selector:'> .block-nav-label', target:'text', style_field:'group_label_style_id', min_render_version:13 },
    // Submenus of a site menu (render version 15).
    { name:'submenu', label:'Dropdown panels', selector:'li[data-submenu="dropdown"] > .block-nav-sub', target:'container', background:'surface', decorative:true, min_render_version:15 },
    { name:'submenu_button', label:'Submenu buttons', selector:'li > .block-nav-toggle', target:'link', min_render_version:15 },
    { name:'submenu_heading', label:'Submenu headings', selector:'.block-nav-heading', target:'text', min_render_version:15 },
    { name:'link_description', label:'Link descriptions', selector:'.block-nav-description', target:'text', color:'text_light', background:'surface', min_render_version:15 },
  ],
  schema:[
    { name:'group_label', type:'text', label:'Group label', placeholder:'Optional title shown above the links', min_render_version:13 },
    { name:'group_label_style_id', type:'style', label:'Group label style', style_target:'text', style_default_role:'eyebrow', min_render_version:13 },
    { name:'source', type:'select', label:'Links from', options:['links','menu'], option_labels:['The links below','A site menu'], default:'links', min_render_version:15 },
    { name:'menu', type:'text', label:'Menu', placeholder:'A menu id, or location:primary, location:footer or location:mobile', help:'Shown when "Links from" is a site menu. A location follows whichever menu fills it.', min_render_version:15 },
    { name:'submenus', type:'select', label:'Submenus', options:['auto','dropdown','accordion','expanded','none'], option_labels:['Automatic (dropdown in a row, accordion in a column)','Dropdown','Accordion','Always shown','Hidden'], default:'auto', min_render_version:15 },
    { name:'links', type:'array', label:'Links', fields:[{ name:'label', type:'text', label:'Label', required:true },{ name:'href', type:'url', label:'Link', required:true },{ name:'icon', type:'icon', label:'Icon (optional)' },{ name:'link_rel', type:'text', label:'Link relationship (e.g. nofollow sponsored)' }] },
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
  template:NAVIGATION_LIST_TEMPLATE,
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

// Keep full touch targets without adding a second layer of vertical spacing.
// Horizontal gaps, explicit gaps and the opt-in compact densities are retained.
const NAVIGATION_LINKS_V11_CSS = `${navigationLinks.styles}
[data-block="navigation_links"]:not([data-density="compact"]) { row-gap:var(--gap_px,0px); }
@media (min-width:1024px) and (hover:hover) and (pointer:fine) {
  [data-block="navigation_links"][data-density="compact-desktop"] { row-gap:var(--gap_px,4px); }
}`;
const NAVIGATION_LINKS_V13_CSS = `${itemsAnyDepth(NAVIGATION_LINKS_V11_CSS)}\n${LABELLED_NAVIGATION_CSS}`;
// Version 14: the minimum link height is the whole touch target, padding
// included (44px, not 44px plus padding). Stacked links no longer sit so far
// apart that a heading above them reads closer to the links than they do to
// each other. A label wrapping to two lines still grows the link.
const NAVIGATION_LINKS_V14_CSS = `${NAVIGATION_LINKS_V13_CSS}
[data-block="navigation_links"] li > a { box-sizing:border-box; }`;

/**
 * Version 15: submenus for links from a site menu (menus.ts renders the
 * markup). A parent item holds its link, a disclosure button and the nested
 * list. `data-submenu` on the item says how the list opens:
 *
 * - dropdown: a panel under the item. Without script it opens on hover (fine
 *   pointers) and on keyboard focus; with script ([data-enhanced] on the
 *   block) it follows [data-open], which the script sets on click, on hover
 *   with a short delay and closes on Escape and outside clicks. Inside the
 *   mobile menu dialog a dropdown behaves as an accordion.
 * - accordion: the nested list sits under the item. Without script it is
 *   shown; with script it opens with the button.
 * - expanded (no data-submenu): the nested list is always shown, indented.
 *
 * A dropdown whose items have children of their own (block-nav-sub--columns)
 * lays them out as columns with their headings and descriptions.
 */
const NAVIGATION_SUBMENU_CSS = `[data-block="navigation_links"] .block-nav-parent { position:relative;display:flex;flex-wrap:wrap;align-items:center; }
[data-block="navigation_links"] .block-nav-sub { --nav-sub-display:flex;display:var(--nav-sub-display);flex:1 0 100%;flex-direction:column;gap:0;min-width:0;margin:0;padding:0;list-style:none; }
[data-block="navigation_links"] .block-nav-sub--columns { --nav-sub-display:grid; }
[data-block="navigation_links"] .block-nav-parent:not([data-submenu]) > .block-nav-sub,
[data-block="navigation_links"] li[data-submenu="accordion"] > .block-nav-sub { padding-inline-start:var(--space-md,1rem); }
[data-block="navigation_links"] li[data-submenu="accordion"] > a { flex:1 1 auto; }
[data-block="navigation_links"] .block-nav-heading { display:flex;align-items:center;min-height:var(--link_min_height_px,44px);box-sizing:border-box;padding-block:var(--padding_y_px,8px);font-weight:600;overflow-wrap:anywhere; }
[data-block="navigation_links"] .block-nav-text { display:flex;flex-direction:column; }
[data-block="navigation_links"] .block-nav-description { display:block;margin-top:.125rem;font-size:.875em;font-weight:400;line-height:1.4;color:var(--color-text-light,currentColor); }
[data-block="navigation_links"] .block-nav-toggle { display:inline-flex;align-items:center;justify-content:center;gap:.5em;flex:none;min-width:44px;min-height:44px;box-sizing:border-box;margin:0;padding:0;border:0;border-radius:4px;background:transparent;color:var(--link_color,inherit);font:inherit;font-weight:var(--font_weight,400);line-height:var(--line_height,1.4);cursor:pointer; }
[data-block="navigation_links"] .block-nav-toggle--label { justify-content:flex-start;min-width:0;min-height:var(--link_min_height_px,44px);padding-block:var(--padding_y_px,8px);font-size:var(--font_size_px,inherit);text-align:start; }
[data-block="navigation_links"] .block-nav-toggle::after { content:'';flex:none;width:.4em;height:.4em;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:translateY(-25%) rotate(45deg);transition:transform .15s ease; }
[data-block="navigation_links"] [data-open] > .block-nav-toggle::after { transform:translateY(25%) rotate(-135deg); }
[data-block="navigation_links"] .block-nav-toggle:focus-visible { outline:2px solid currentColor;outline-offset:-2px; }
[data-block="navigation_links"] .block-nav-sr { position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0; }
@media (hover:hover) and (pointer:fine) {
  [data-block="navigation_links"] li[data-submenu="dropdown"] > .block-nav-toggle:not(.block-nav-toggle--label) { min-width:28px; }
  [data-block="navigation_links"] .block-nav-toggle:hover { color:var(--color-primary,currentColor); }
}
[data-block="navigation_links"] li[data-submenu="dropdown"] > .block-nav-sub { position:absolute;top:calc(100% + .25rem);inset-inline-start:0;translate:var(--nav-sub-shift,0px) 0;z-index:60;display:none;flex-direction:column;width:max-content;min-width:max(100%,12rem);max-width:min(36rem,calc(100vw - 2rem));box-sizing:border-box;padding:var(--space-xs,.5rem) var(--space-sm,.75rem);background:var(--color-surface,#fff);color:var(--color-text,#111);border:1px solid var(--color-border,rgb(0 0 0 / .12));border-radius:8px;box-shadow:0 12px 32px rgb(0 0 0 / .14); }
[data-block="navigation_links"] li[data-submenu="dropdown"] > .block-nav-sub::before { content:'';position:absolute;inset:calc(-.25rem - 1px) 0 100%; }
[data-block="navigation_links"] li[data-submenu="dropdown"] > .block-nav-sub :is(a,.block-nav-toggle) { color:inherit; }
[data-block="navigation_links"] li[data-submenu="dropdown"] > .block-nav-sub--columns { grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));gap:var(--space-sm,.75rem) var(--space-lg,1.5rem);width:min(48rem,calc(100vw - 2rem));padding:var(--space-sm,.75rem) var(--space-md,1rem); }
/* Wide panels of the last two items open towards the start, so they stay on screen without script too. */
[data-block="navigation_links"] li[data-submenu="dropdown"]:nth-last-child(-n+2) > .block-nav-sub--columns { inset-inline-start:auto;inset-inline-end:0; }
[data-block="navigation_links"] .block-nav-sub--columns > .block-nav-parent { display:block; }
[data-block="navigation_links"] .block-nav-sub--columns > .block-nav-parent > a { font-weight:600; }
[data-block="navigation_links"] .block-nav-sub--columns .block-nav-parent > .block-nav-sub { padding-inline-start:0; }
[data-block="navigation_links"]:not([data-enhanced]) li[data-submenu="dropdown"]:focus-within > .block-nav-sub,
[data-block="navigation_links"][data-enhanced] li[data-submenu="dropdown"][data-open] > .block-nav-sub { display:var(--nav-sub-display); }
@media (hover:hover) and (pointer:fine) {
  [data-block="navigation_links"]:not([data-enhanced]) li[data-submenu="dropdown"]:hover > .block-nav-sub { display:var(--nav-sub-display); }
}
[data-block="navigation_links"]:not([data-enhanced]) li[data-submenu="accordion"] > .block-nav-toggle:not(.block-nav-toggle--label),
[data-block="navigation_links"]:not([data-enhanced]) li[data-submenu="accordion"] > .block-nav-toggle--label::after { display:none; }
[data-block="navigation_links"][data-enhanced] li[data-submenu="accordion"]:not([data-open]) > .block-nav-sub { display:none; }
dialog [data-block="navigation_links"] li[data-submenu="dropdown"] > .block-nav-sub { position:static;display:var(--nav-sub-display);grid-template-columns:minmax(0,1fr);width:auto;min-width:0;max-width:none;padding:0 0 0 var(--space-md,1rem);background:none;color:inherit;border:0;border-radius:0;box-shadow:none; }
dialog [data-block="navigation_links"] li[data-submenu="dropdown"] > .block-nav-sub::before { content:none; }
dialog [data-block="navigation_links"] li[data-submenu="dropdown"] > a { flex:1 1 auto; }
dialog [data-block="navigation_links"] .block-nav-sub--columns .block-nav-parent > .block-nav-sub { padding-inline-start:var(--space-md,1rem); }
dialog [data-block="navigation_links"][data-enhanced] li[data-submenu="dropdown"]:not([data-open]) > .block-nav-sub { display:none; }
@media (prefers-reduced-motion:reduce) {
  [data-block="navigation_links"] .block-nav-toggle::after { transition:none; }
}`;
const NAVIGATION_LINKS_V15_CSS = `${NAVIGATION_LINKS_V14_CSS}\n${NAVIGATION_SUBMENU_CSS}`;

/**
 * The submenu runtime (render version 15). It ships only with a block that
 * shows a site menu with submenus (collectBlockAssets), and such a block
 * carries the runtime hook itself (data-block-type), so blocks with their own
 * links stay without script.
 */
export const NAVIGATION_SUBMENU_SCRIPT = `
window.TyperollBlocks = window.TyperollBlocks || { register(){}, init(){} };
window.TyperollBlocks.register('core/navigation_links', el => {
  if (el.dataset.enhanced === 'true') return;
  const parents = [...el.querySelectorAll('li[data-submenu]')].filter(li => li.querySelector(':scope > .block-nav-toggle'));
  if (!parents.length) return;
  const fine = matchMedia('(hover:hover) and (pointer:fine)');
  // In the mobile menu dialog a dropdown opens in place, like an accordion.
  const dropdown = li => li.dataset.submenu === 'dropdown' && !li.closest('dialog');
  const timers = new Map();
  const clear = li => { clearTimeout(timers.get(li)); timers.delete(li); };
  // Keep an open panel on screen: a wide one under an item near the edge moves inwards.
  const place = li => {
    const panel = li.querySelector(':scope > .block-nav-sub');
    if (!panel) return;
    panel.style.removeProperty('--nav-sub-shift');
    if (!dropdown(li)) return;
    const rect = panel.getBoundingClientRect(), edge = 16, width = document.documentElement.clientWidth;
    const shift = rect.right > width - edge ? Math.max(width - edge - rect.right, edge - rect.left) : rect.left < edge ? edge - rect.left : 0;
    if (shift) panel.style.setProperty('--nav-sub-shift', Math.round(shift) + 'px');
  };
  const set = (li, open) => {
    clear(li);
    li.querySelector(':scope > .block-nav-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { li.setAttribute('data-open', ''); place(li); } else { li.removeAttribute('data-open'); delete li.dataset.pinned; delete li.dataset.hover; }
  };
  const open = li => {
    for (const other of li.parentElement.children) if (other !== li && other.hasAttribute('data-open')) set(other, false);
    set(li, true);
  };
  for (const li of parents) {
    const button = li.querySelector(':scope > .block-nav-toggle');
    // An accordion around the current page starts open.
    if (li.dataset.submenu === 'accordion' && li.classList.contains('block-nav-parent--current')) set(li, true);
    button.addEventListener('click', () => {
      // A click on a panel the pointer just opened keeps it open.
      if (li.hasAttribute('data-open') && li.dataset.hover === 'true') { delete li.dataset.hover; li.dataset.pinned = 'true'; return; }
      if (li.hasAttribute('data-open')) set(li, false); else { open(li); li.dataset.pinned = 'true'; }
    });
    li.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !li.hasAttribute('data-open') || !dropdown(li)) return;
      event.preventDefault(); event.stopPropagation();
      set(li, false); button.focus();
    });
    li.addEventListener('pointerenter', event => {
      if (event.pointerType !== 'mouse' || !fine.matches || !dropdown(li)) return;
      clear(li);
      if (!li.hasAttribute('data-open')) timers.set(li, setTimeout(() => { open(li); li.dataset.hover = 'true'; }, 80));
    });
    li.addEventListener('pointerleave', event => {
      if (event.pointerType !== 'mouse' || !dropdown(li)) return;
      clear(li);
      if (li.hasAttribute('data-open') && li.dataset.pinned !== 'true') timers.set(li, setTimeout(() => set(li, false), 300));
    });
    li.addEventListener('focusout', event => {
      if (dropdown(li) && event.relatedTarget instanceof Node && !li.contains(event.relatedTarget)) set(li, false);
    });
  }
  document.addEventListener('click', event => {
    for (const li of parents) if (li.hasAttribute('data-open') && dropdown(li) && !li.contains(event.target)) set(li, false);
  });
  el.dataset.enhanced = 'true';
});
`;

navigationLinks.render_versions = [
  { from: 11, styles: NAVIGATION_LINKS_V11_CSS },
  { from: 13, template: LABELLED_NAVIGATION_TEMPLATE, styles: NAVIGATION_LINKS_V13_CSS },
  { from: 14, template: LABELLED_NAVIGATION_TEMPLATE, styles: NAVIGATION_LINKS_V14_CSS },
  { from: 15, template: LABELLED_NAVIGATION_TEMPLATE, styles: NAVIGATION_LINKS_V15_CSS },
];
