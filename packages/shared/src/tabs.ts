import type { BlockType } from "./types.js";
import { pixels } from "./presentation-fields.js";
import { renderIconHtml } from "./icons.js";
import { surfaceColor } from "./surface-presentation.js";
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const safeHref = (value: unknown) =>
  typeof value === "string" &&
  /^(?:\/(?![\/\\])|https?:\/\/|#)/i.test(value) &&
  !/[\u0000-\u0020\\]/.test(value)
    ? value
    : "";
export function prepareTabs(
  data: Record<string, unknown>,
  id: string,
  slots: unknown[][] = [],
): void {
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const tabs: string[] = [],
    links: string[] = [];
  for (let i = 0; i < 6; i++) {
    const label = labels[i] || {};
    const title = esc(label.label || `Tab ${i + 1}`),
      icon = label.icon
        ? `<span class="block-tabs-icon" aria-hidden="true">${renderIconHtml(String(label.icon))}</span>`
        : "";
    if (label.href) {
      const href = safeHref(label.href);
      if (href)
        links.push(
          `<a class="block-tabs-choice" href="${esc(href)}">${icon}${title}</a>`,
        );
      continue;
    }
    if (!slots[i]?.length) continue;
    tabs.push(
      `<button class="block-tabs-choice" type="button" role="tab" id="tab-${esc(id)}-${i}" aria-controls="panel-${esc(id)}-${i}" aria-selected="false" tabindex="-1" data-idx="${i}">${icon}${title}</button>`,
    );
  }
  data.tab_headline_html = data.headline
    ? `<strong class="block-tabs-headline">${esc(data.headline)}</strong>`
    : "";
  data.tab_buttons_html = tabs.join("");
  data.tab_links_html = links.join("");
  data.tabs_id = id;
  data.tabs_colors = [
    ["choice_color", "--tab-color"],
    ["active_background", "--tab-active-bg"],
    ["active_color", "--tab-active-color"],
  ]
    .flatMap(([field, variable]) => {
      const color = surfaceColor(data[field]);
      return color ? [`${variable}:${color}`] : [];
    })
    .join(";");
}
export const tabs: BlockType = {
  id: "core/tabs",
  name: "tabs",
  label: "Tabs and links",
  icon: "panels-top-left",
  category: "content",
  container: "slots",
  slot_count: 6,
  slot_labels: ["Tab 1", "Tab 2", "Tab 3", "Tab 4", "Tab 5", "Tab 6"],
  schema: [
    {
      name: "active_font_weight",
      type: "number",
      label: "Selected choice font weight",
      min: 100,
      max: 900,
      responsive: true,
      css_unit: "number",
    },
    {
      name: "choice_flow",
      type: "select",
      label: "Choice wrapping",
      options: ["grouped", "continuous"],
      default: "grouped",
    },
    pixels("headline_font_size_px", "Headline text size", 12, 48),
    {
      name: "headline_line_height",
      type: "number",
      label: "Headline line height",
      min: 1,
      max: 2.5,
      responsive: true,
      css_unit: "number",
    },
    pixels("choice_row_gap_px", "Choice row spacing", 0, 80),
    { name: "headline", type: "text", label: "Inline headline" },
    {
      name: "headline_full_width",
      type: "boolean",
      label: "Headline on its own row",
      responsive: true,
      default: false,
      responsive_css: {
        true: "--headline-basis:100%;",
        false: "--headline-basis:auto;",
      },
    },
    {
      name: "font",
      type: "select",
      label: "Font family",
      options: ["inherit", "body", "heading"],
      default: "inherit",
    },
    {
      name: "line_height",
      type: "number",
      label: "Choice line height",
      min: 1,
      max: 2.5,
      responsive: true,
      css_unit: "number",
    },
    {
      name: "labels",
      type: "array",
      label: "Choices",
      fields: [
        { name: "label", type: "text", label: "Label" },
        { name: "icon", type: "icon", label: "Icon" },
        {
          name: "href",
          type: "text",
          label: "Direct link instead of a tab (optional)",
        },
      ],
    },
    {
      name: "style",
      type: "select",
      label: "Style",
      options: ["underline", "pills", "boxed", "plain"],
      default: "underline",
    },
    {
      name: "align",
      type: "select",
      label: "Alignment",
      options: ["left", "center"],
      default: "left",
      responsive: true,
    },
    {
      name: "default_open",
      type: "number",
      label: "Default tab index (0-based)",
      default: 0,
    },
    {
      name: "collapse_below",
      type: "select",
      label: "Collapse on smaller screens",
      options: ["never", "576", "768", "769", "1024", "1025"],
      default: "never",
    },
    {
      name: "collapse_mode",
      type: "select",
      label: "Collapsed content",
      options: ["all", "panels"],
      default: "all",
    },
    {
      name: "toggle_label",
      type: "text",
      label: "Open/close label",
      default: "Explore options",
    },
    {
      name: "menu_label",
      type: "text",
      label: "Accessible choices label",
      default: "Options",
    },
    pixels("choice_min_height_px", "Minimum choice height", 24, 100),
    pixels("choice_padding_x_px", "Choice horizontal padding", 0, 48),
    pixels("choice_padding_y_px", "Choice vertical padding", 0, 48),
    pixels("choice_radius_px", "Choice radius", 0, 40),
    pixels("choice_icon_size_px", "Choice icon size", 12, 64),
    pixels("choice_font_size_px", "Choice text size", 12, 48),
    pixels("choice_gap_px", "Choice spacing", 0, 80),
    pixels("choice_padding_px", "Choice padding", 0, 48),
    pixels("panel_gap_px", "Space before content", 0, 120),
    { name: "choice_color", type: "color", label: "Choice text" },
    { name: "active_background", type: "color", label: "Selected background" },
    { name: "active_color", type: "color", label: "Selected text" },
  ],
  template: `<div data-block="tabs" data-style="{{style}}" data-font="{{font}}" data-choice-flow="{{choice_flow}}" data-headline-full="{{headline_full_width}}" data-collapse="{{collapse_below}}" data-collapse-mode="{{collapse_mode}}" data-default="{{default_open}}" style="--align:{{align}};{{tabs_colors}}">
<button type="button" class="block-tabs-toggle" aria-expanded="false" aria-controls="tabs-content-{{tabs_id}}">{{toggle_label}}</button>
<div class="block-tabs-content" id="tabs-content-{{tabs_id}}"><div class="block-tabs-strip">{{{tab_headline_html}}}<div class="block-tabs-buttons" role="tablist" aria-label="{{menu_label}}">{{{tab_buttons_html}}}</div><nav class="block-tabs-links" aria-label="{{menu_label}}">{{{tab_links_html}}}</nav></div>
<div class="block-tabs-panels">${Array.from({ length: 6 }, (_, i) => `<div class="block-tabs-panel" id="panel-{{tabs_id}}-${i}">{{slot:${i}}}</div>`).join("")}</div></div></div>`,
  styles: `[data-block="tabs"]>.block-tabs-toggle{display:none}
[data-block="tabs"][data-font="body"]{font-family:var(--font-body,inherit)}
[data-block="tabs"][data-font="heading"]{font-family:var(--font-heading,inherit)}
[data-block="tabs"][data-headline-full="true"]{--headline-basis:100%}
[data-block="tabs"][data-headline-full="false"]{--headline-basis:auto}
[data-block="tabs"] .block-tabs-headline{flex-basis:var(--headline-basis,auto);font-size:var(--headline_font_size_px,var(--choice_font_size_px,1rem));line-height:var(--headline_line_height,1.5);color:var(--tab-color,inherit)}
[data-block="tabs"] .block-tabs-strip,[data-block="tabs"] .block-tabs-buttons,[data-block="tabs"] .block-tabs-links{display:flex;flex-wrap:wrap;gap:var(--choice_row_gap_px,var(--choice_gap_px,4px)) var(--choice_gap_px,4px);align-items:center}
[data-block="tabs"][data-choice-flow="continuous"] .block-tabs-buttons,[data-block="tabs"][data-choice-flow="continuous"] .block-tabs-links{display:contents}
[data-block="tabs"] .block-tabs-strip{justify-content:var(--align,flex-start);border-bottom:1px solid #8884;margin-bottom:var(--panel_gap_px,16px)}
[data-block="tabs"] .block-tabs-choice,[data-block="tabs"]>.block-tabs-toggle{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:var(--choice_min_height_px,44px);box-sizing:border-box;padding:var(--choice_padding_y_px,var(--choice_padding_px,12px)) var(--choice_padding_x_px,var(--choice_padding_px,12px));border-radius:var(--choice_radius_px,0px);border:0;background:transparent;font:inherit;font-size:var(--choice_font_size_px,1rem);line-height:var(--line_height,1.2);color:var(--tab-color,inherit);text-decoration:none;cursor:pointer}
[data-block="tabs"]>.block-tabs-toggle{display:none}
[data-block="tabs"] .block-tabs-icon{font-size:var(--choice_icon_size_px,1em);line-height:1}
[data-block="tabs"] .block-tabs-icon svg{width:1em;height:1em}
[data-block="tabs"] [role="tab"][aria-selected="true"]{font-weight:var(--active_font_weight,600);background:var(--tab-active-bg,transparent);color:var(--tab-active-color,var(--tab-color,inherit));}
[data-block="tabs"][data-style="underline"] [aria-selected="true"]{box-shadow:inset 0 -3px currentColor}
[data-block="tabs"]:not([data-style="underline"]) .block-tabs-strip{border-bottom:0}
[data-block="tabs"]:not([data-style="underline"]) [aria-selected="true"]{background:var(--tab-active-bg,#8882)}
[data-block="tabs"][data-style="pills"] .block-tabs-choice{border-radius:var(--choice_radius_px,999px)}
[data-block="tabs"][data-style="boxed"] .block-tabs-choice{border:1px solid #8884;border-radius:var(--choice_radius_px,6px)}
[data-block="tabs"][data-collapse-mode="panels"] [aria-selected="true"][aria-expanded="false"]{font-weight:inherit;background:transparent;box-shadow:none;color:var(--tab-color,inherit)}
[data-block="tabs"] :is(button,a):focus-visible{outline:2px solid currentColor;outline-offset:2px}
[data-block="tabs"] .block-tabs-panel[hidden],[data-block="tabs"] .block-tabs-panel:empty,[data-block="tabs"] .block-tabs-links:empty,[data-block="tabs"] .block-tabs-buttons:empty{display:none}
${[576, 768, 769, 1024, 1025].map((width) => `@media(max-width:${width - 1}px){[data-block="tabs"][data-ready][data-collapse="${width}"]:not([data-collapse-mode="panels"])>.block-tabs-toggle{display:flex;width:100%}[data-block="tabs"][data-ready][data-collapse="${width}"]:not([data-collapse-mode="panels"]):not([data-expanded])>.block-tabs-content{display:none}[data-block="tabs"][data-ready][data-collapse="${width}"][data-collapse-mode="panels"]:not([data-expanded])>.block-tabs-content>.block-tabs-panels{display:none}}`).join("\n")}`,
  script: `window.TyperollBlocks.register('core/tabs',el=>{
 const content=el.querySelector(':scope > .block-tabs-content');
 const buttons=Array.from(content.querySelector(':scope > .block-tabs-strip > .block-tabs-buttons').children);
 const panels=Array.from(content.querySelector(':scope > .block-tabs-panels').children);
 if(!buttons.length&&!content.querySelector('.block-tabs-links a'))return;
 const collapseWidth=Number(el.dataset.collapse);
 const query=Number.isFinite(collapseWidth)&&collapseWidth>0?matchMedia('(max-width:'+(collapseWidth-1)+'px)'):null;
 function syncExpanded(){if(el.dataset.collapseMode==='panels')buttons.forEach(button=>button.setAttribute('aria-expanded',String(button.getAttribute('aria-selected')==='true'&&(!query?.matches||el.hasAttribute('data-expanded')))));}
 query?.addEventListener('change',syncExpanded);
 function activate(button,focus=false){
  if(focus&&el.dataset.collapseMode==='panels')el.setAttribute('data-expanded','');
  buttons.forEach(item=>{const active=item===button;item.setAttribute('aria-selected',String(active));item.tabIndex=active?0:-1;});
  panels.forEach((panel,index)=>{const selected=Number(button.dataset.idx)===index;panel.hidden=!selected;panel.setAttribute('role','tabpanel');const owner=buttons.find(item=>Number(item.dataset.idx)===index);if(owner)panel.setAttribute('aria-labelledby',owner.id);});
  syncExpanded();
  if(focus)button.focus();
 }
 buttons.forEach((button,index)=>{
  button.addEventListener('click',()=>{if(el.dataset.collapseMode==='panels'){const expanded=button.getAttribute('aria-selected')!=='true'||!el.hasAttribute('data-expanded');el.toggleAttribute('data-expanded',expanded);buttons.forEach(item=>item.setAttribute('aria-expanded',String(item===button&&expanded)));}activate(button);});
  button.addEventListener('keydown',event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%buttons.length;else if(event.key==='ArrowLeft')next=(index+buttons.length-1)%buttons.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=buttons.length-1;else return;event.preventDefault();activate(buttons[next],true);});
 });
 if(buttons.length)activate(buttons.find(button=>button.dataset.idx===el.dataset.default)||buttons[0]);
 const toggle=el.querySelector(':scope > .block-tabs-toggle');
 toggle.addEventListener('click',()=>{const expanded=!el.hasAttribute('data-expanded');el.toggleAttribute('data-expanded',expanded);toggle.setAttribute('aria-expanded',String(expanded));});
 el.setAttribute('data-ready','');
});`,
  origin: "core",
  created_at: "1970-01-01T00:00:00Z",
};
