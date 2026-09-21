import type { BlockType } from "./types.js";
import { BREAKPOINT_ORDER, resolveBreakpointWidths } from "./breakpoints.js";
import { pixels } from "./presentation-fields.js";
import { surfaceColor } from "./surface-presentation.js";

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const validName = (value: string) =>
  /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(value) &&
  !["constructor", "prototype"].includes(value.toLowerCase()) &&
  !/password|token|secret|authorization/i.test(value);
export function navigationDestination(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\/(?!\/)/.test(value) ||
    /[\\?#\s\u0000-\u001f]/.test(value)
  )
    return "";
  try {
    const decoded = decodeURIComponent(value);
    return /[\\?#\s\u0000-\u001f]/.test(decoded) || decoded.startsWith("//")
      ? ""
      : value;
  } catch {
    return "";
  }
}
export function prepareNavigationForm(
  data: Record<string, unknown>,
  id: string,
  raw: Record<string, unknown> = data,
  breakpoints?: unknown,
): void {
  const widths = resolveBreakpointWidths(breakpoints);
  const cssId = id.replace(
    /[^a-zA-Z0-9_-]/g,
    (char) => `_${char.codePointAt(0)!.toString(16)}_`,
  );
  data.navigation_id = cssId;
  const layout: string[] = [];
  function responsiveStyle(
    selector: string,
    property: string,
    value: unknown,
    validate: (v: unknown) => string,
  ) {
    const values =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : { mobile: value };
    for (const point of BREAKPOINT_ORDER) {
      const css = validate(values[point]);
      if (!css) continue;
      const rule = `#navigation-${cssId} ${selector}{${property}:${css}}`;
      layout.push(
        point === "mobile"
          ? rule
          : `@media(min-width:${widths[point]}px){${rule}}`,
      );
    }
  }
  const column = (value: unknown) =>
    value === "full"
      ? "1 / -1"
      : /^(auto|[1-6]|span [2-6])$/.test(String(value))
        ? String(value)
        : "";
  const row = (value: unknown) =>
    /^(auto|[1-6])$/.test(String(value)) ? String(value) : "";
  responsiveStyle("", "grid-template-columns", raw.column_widths, (value) =>
    typeof value === "string" &&
    /^(?:[1-9][0-9]{0,2}(?:fr|px))(?: (?:[1-9][0-9]{0,2}(?:fr|px))){0,5}$/.test(
      value,
    )
      ? value.replace(/([0-9]+fr)/g, "minmax(0,$1)")
      : "",
  );
  responsiveStyle(
    ".navigation-actions",
    "grid-column",
    raw.button_column,
    column,
  );
  responsiveStyle(".navigation-actions", "grid-row", raw.button_row, row);
  const names = new Set<string>();
  const fields = (Array.isArray(data.fields) ? data.fields : [])
    .slice(0, 32)
    .filter((field) => {
      if (!field || typeof field !== "object") return false;
      const name = String(field.name ?? "");
      if (!validName(name) || names.has(name)) return false;
      names.add(name);
      return true;
    });
  data.navigation_fields_html = fields
    .map((field) => {
      const name = String(field.name);
      responsiveStyle(
        `[data-navigation-field="${name}"]`,
        "grid-column",
        field.column,
        column,
      );
      responsiveStyle(
        `[data-navigation-field="${name}"]`,
        "grid-row",
        field.row,
        row,
      );
      const inputId = `nav-${id}-${name}`;
      const kind = ["text", "number", "select"].includes(field.kind)
        ? field.kind
        : "text";
      const numeric =
        kind === "number"
          ? ["min", "max", "step"]
              .flatMap((key) =>
                typeof field[key] === "number" &&
                Number.isFinite(field[key]) &&
                (key !== "step" || field[key] > 0)
                  ? [`${key}="${field[key]}"`]
                  : [],
              )
              .join(" ")
          : "";
      // `suggest` only ever adds behaviour. The markup is identical with and
      // without a configured key, which is what lets the editor canvas, the
      // preview shell and the published page agree on everything except the
      // suggestions themselves — none of the three can be wrong about layout.
      const suggest = field.suggest_address === true && kind === "text";
      const attrs = `id="${escape(inputId)}" name="${escape(name)}" class="navigation-input"${field.required === true ? " required" : ""}${suggest ? ' data-navigation-suggest="address" autocomplete="off"' : ""}`;
      const input =
        kind === "select"
          ? `<select ${attrs}><option value="">${escape(field.placeholder || "Choose…")}</option>${(Array.isArray(
              field.options,
            )
              ? field.options
              : []
            )
              .slice(0, 100)
              .filter((option: unknown) => option && typeof option === "object")
              .map(
                (option: Record<string, unknown>) =>
                  `<option value="${escape(option.value)}">${escape(option.label ?? option.value)}</option>`,
              )
              .join("")}</select>`
          : `<input ${attrs} type="${kind}" maxlength="512" placeholder="${escape(field.placeholder)}"${kind === "number" ? ` ${numeric}${typeof field.step === "number" && field.step > 0 ? "" : ' step="any"'}` : ""}>`;
      return `<div class="navigation-field" data-navigation-field="${escape(name)}"><label for="${escape(inputId)}">${escape(field.label || name)}</label>${input}</div>`;
    })
    .join("");
  data.navigation_layout_html = layout.length
    ? `<style>${layout.join("")}</style>`
    : "";
  data.destination = navigationDestination(data.destination);
  data.handoff_key = /^[a-zA-Z0-9_-]{1,64}$/.test(
    String(data.handoff_key ?? ""),
  )
    ? data.handoff_key
    : "page-defaults";
  data.mode = data.mode === "receive" ? "receive" : "navigate";
  data.navigation_action_html =
    data.mode === "navigate" && data.destination
      ? `<div class="navigation-actions"><a data-navigation-fallback href="${escape(data.destination)}">${escape(data.button_label || "Continue")}</a><button type="button" data-navigation-continue hidden>${escape(data.button_label || "Continue")}</button></div>`
      : "";
  data.address_country = /^[A-Za-z]{2}$/.test(String(data.address_country ?? ""))
    ? String(data.address_country).toLowerCase()
    : "";
  data.navigation_colors = [
    ["button_background", "--navigation-button-bg"],
    ["button_color", "--navigation-button-color"],
    ["input_background", "--navigation-input-bg"],
    ["input_color", "--navigation-input-color"],
    ["input_border_color", "--navigation-input-border"],
  ]
    .flatMap(([field, variable]) => {
      const color = surfaceColor(data[field]);
      return color ? [`${variable}:${color}`] : [];
    })
    .join(";");
}

// Values stay in this browser tab. No submissions, URL parameters, telemetry,
// cookies, third-party storage, or automatic network retries.
//
// Address suggestions are the one exception, and only when the site owner has
// configured a provider key AND a field opted in. Then the typed text goes to
// that provider, exactly as it would on any site using their widget directly.
// The block never learns which provider it is: it asks the page for the
// `address_autocomplete` capability and receives structured address parts. An
// unconfigured key, a blocked script, or a surface that cannot run one — the
// editor canvas, the preview shell — all produce the same result, which is
// that nothing registers and every field stays a plain input.
export const NAVIGATION_FORM_RUNTIME = String.raw`
window.TyperollBlocks.register('core/navigation_form', (el) => {
  const prefix='typeroll:page-defaults:v1:';
  const key=el.dataset.handoffKey;
  const fields=Array.from(el.querySelectorAll('.navigation-input'));
  const accepted=fields.map(input=>input.name);
  // Structured address parts, keyed by the field that produced them. Kept
  // beside the typed text rather than replacing it: the display string is what
  // the visitor sees and confirms, the parts are what a destination form needs.
  const parts={};
  const PART_NAMES=['street','street_number','postal_code','locality','country','formatted'];
  const safeName=name=>/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)&&!['constructor','prototype'].includes(name.toLowerCase())&&!/password|token|secret|authorization/i.test(name);
  function consume(handoffKey, acceptedFields) {
    if(!/^[a-zA-Z0-9_-]{1,64}$/.test(handoffKey)||!Array.isArray(acceptedFields)||acceptedFields.length>32)return {};
    try {
      const raw=sessionStorage.getItem(prefix+handoffKey);
      if(!raw||raw.length>20000)return {};
      const packet=JSON.parse(raw);
      if(packet.version!==1||packet.target!==location.pathname||!Number.isFinite(packet.expires)||packet.expires<Date.now()||packet.expires>Date.now()+900000){sessionStorage.removeItem(prefix+handoffKey);return {};}
      sessionStorage.removeItem(prefix+handoffKey);
      const result={};
      acceptedFields.filter(safeName).forEach(name=>{const value=packet.values?.[name];if(Object.prototype.hasOwnProperty.call(packet.values||{},name)&&typeof value==='string'&&value.length<=512)result[name]=value;});
      return result;
    } catch{return {};}
  }
  window.TyperollPageHandoff={consume};
  if(el.dataset.mode==='receive') {
    // A receiving field may be named for a part (address_from_postal_code) or
    // for the whole address, so both are offered to consume().
    const wanted=accepted.concat(accepted.flatMap(name=>PART_NAMES.map(part=>name+'_'+part)));
    const defaults=consume(key,wanted);
    fields.forEach(input=>{if(Object.prototype.hasOwnProperty.call(defaults,input.name))input.value=defaults[input.name];});
    bindSuggestions();
    return;
  }
  const link=el.querySelector('[data-navigation-fallback]'),button=el.querySelector('[data-navigation-continue]');
  if(!link||!button)return;
  let target;try{target=new URL(link.href,location.href);}catch{return;}
  if(target.origin!==location.origin||target.hash)return;
  link.hidden=true;button.hidden=false;
  function navigate(){
    if(fields.some(input=>!input.reportValidity()))return;
    const values={};
    fields.forEach(input=>{
      if(!safeName(input.name))return;
      values[input.name]=String(input.value).slice(0,512);
      const found=parts[input.name];
      // Only carry parts the visitor's current text actually produced. A
      // selection followed by hand-editing the field would otherwise ship
      // components describing a different address.
      if(found&&found.for===input.value)PART_NAMES.forEach(part=>{
        const name=input.name+'_'+part;
        if(typeof found.values[part]==='string'&&safeName(name))values[name]=found.values[part].slice(0,512);
      });
    });
    try {
      // A small fixed prefix budget avoids retaining multiple abandoned banners.
      const keys=[];for(let i=0;i<sessionStorage.length;i++){const item=sessionStorage.key(i);if(item?.startsWith(prefix))keys.push(item);}
      keys.forEach(item=>sessionStorage.removeItem(item));
      sessionStorage.setItem(prefix+key,JSON.stringify({version:1,target:target.pathname,expires:Date.now()+900000,values}));
    }catch{/* Navigation remains available when tab storage is disabled. */}
    location.assign(target.href);
  }
  button.addEventListener('click',navigate);
  el.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.matches('input')){event.preventDefault();navigate();}});
  bindSuggestions();

  function bindSuggestions(){
    const wanting=fields.filter(input=>input.dataset.navigationSuggest==='address');
    if(!wanting.length)return;
    let bound=false;
    function attach(){
      if(bound)return;
      const capability=(window.TyperollClientCapabilities||{}).address_autocomplete;
      if(!capability||typeof capability.attach!=='function')return;
      bound=true;
      const country=el.dataset.addressCountry||'';
      wanting.forEach(input=>{
        try{
          capability.attach(input,{country:country},selected=>{
            if(!selected||typeof selected!=='object')return;
            const kept={};
            PART_NAMES.forEach(part=>{if(typeof selected[part]==='string')kept[part]=selected[part];});
            parts[input.name]={for:input.value,values:kept};
          });
        }catch(e){/* One field failing must not take the others with it. */}
      });
    }
    // The loader may register before or after this block initialises, so both
    // orders are handled. No loader at all means neither fires and the fields
    // stay plain, which is the honest fallback.
    attach();
    if(bound)return;
    function announced(event){
      if(!event||!event.detail||event.detail.name!=='address_autocomplete')return;
      attach();
      // Dropped once it has done its job, so the handler stops retaining this
      // block's inputs after they leave the document.
      if(bound)document.removeEventListener('typeroll:capability',announced);
    }
    document.addEventListener('typeroll:capability',announced);
  }
});
`;

export const navigationForm: BlockType = {
  id: "core/navigation_form",
  name: "navigation_form",
  label: "Navigation inputs",
  icon: "arrow-right",
  category: "content",
  container: false,
  schema: [
    {
      name: "button_nowrap",
      type: "boolean",
      label: "Keep button text on one line",
      default: false,
    },
    pixels("button_padding_x_px", "Button horizontal padding", 0, 48),
    pixels("button_padding_y_px", "Button vertical padding", 0, 48),
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
      label: "Line height",
      min: 1,
      max: 2.5,
      responsive: true,
      css_unit: "number",
    },
    {
      name: "mode",
      type: "select",
      label: "Mode",
      options: ["navigate", "receive"],
      default: "navigate",
    },
    {
      name: "destination",
      type: "text",
      label: "Destination page path",
      placeholder: "/quote/",
    },
    {
      name: "handoff_key",
      type: "text",
      label: "Defaults key",
      default: "page-defaults",
    },
    {
      name: "address_country",
      type: "text",
      label: "Restrict addresses to country (2-letter code)",
      placeholder: "se",
    },
    {
      name: "aria_label",
      type: "text",
      label: "Accessible name",
      default: "Get started",
    },
    {
      name: "show_labels",
      type: "boolean",
      label: "Show field labels",
      default: true,
    },
    {
      name: "button_label",
      type: "text",
      label: "Continue button",
      default: "Continue",
    },
    {
      name: "fields",
      type: "array",
      label: "Input fields",
      fields: [
        { name: "name", type: "text", label: "Field name", required: true },
        { name: "label", type: "text", label: "Label" },
        {
          name: "kind",
          type: "select",
          label: "Input type",
          options: ["text", "number", "select"],
          default: "text",
        },
        { name: "placeholder", type: "text", label: "Placeholder" },
        {
          name: "required",
          type: "boolean",
          label: "Required",
          default: false,
        },
        {
          name: "suggest_address",
          type: "boolean",
          label: "Suggest addresses",
          default: false,
        },
        {
          name: "column",
          type: "select",
          label: "Grid column",
          options: [
            "auto",
            "full",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "span 2",
            "span 3",
          ],
          responsive: true,
        },
        {
          name: "row",
          type: "select",
          label: "Grid row",
          options: ["auto", "1", "2", "3", "4", "5", "6"],
          responsive: true,
        },
        { name: "min", type: "number", label: "Minimum number" },
        { name: "max", type: "number", label: "Maximum number" },
        { name: "step", type: "number", label: "Number increment", min: 0.001 },
        {
          name: "options",
          type: "array",
          label: "Select options",
          fields: [
            { name: "value", type: "text", label: "Value" },
            { name: "label", type: "text", label: "Label" },
          ],
        },
      ],
    },
    {
      name: "columns",
      type: "select",
      label: "Columns including button",
      options: ["1", "2", "3", "4"],
      default: "1",
      responsive: true,
    },
    {
      name: "column_widths",
      type: "text",
      label: "Column widths (optional, e.g. 1fr 180px)",
      responsive: true,
    },
    {
      name: "button_column",
      type: "select",
      label: "Button column",
      options: ["auto", "full", "1", "2", "3", "4", "5", "6"],
      responsive: true,
    },
    {
      name: "button_row",
      type: "select",
      label: "Button row",
      options: ["auto", "1", "2", "3", "4", "5", "6"],
      responsive: true,
    },
    pixels("input_padding_x_px", "Input horizontal padding", 0, 48),
    pixels("input_padding_y_px", "Input vertical padding", 0, 48),
    pixels("input_border_width_px", "Input border width", 0, 8),
    { name: "input_border_color", type: "color", label: "Input border color" },
    pixels("gap_px", "Field gap", 0, 80),
    pixels("input_height_px", "Minimum input height", 32, 100),
    pixels("font_size_px", "Font size", 12, 40),
    pixels("radius_px", "Corner radius", 0, 40),
    { name: "button_background", type: "color", label: "Button background" },
    { name: "button_color", type: "color", label: "Button text" },
    { name: "input_background", type: "color", label: "Input background" },
    { name: "input_color", type: "color", label: "Input text" },
  ],
  template:
    '<div id="navigation-{{navigation_id}}" data-block="navigation_form" role="form" aria-label="{{aria_label}}" data-handoff-key="{{handoff_key}}" data-mode="{{mode}}" data-show-labels="{{show_labels}}" data-font="{{font}}" data-button-nowrap="{{button_nowrap}}" data-address-country="{{address_country}}" style="--columns:{{columns}};{{navigation_colors}}">{{{navigation_fields_html}}}{{{navigation_action_html}}}</div>{{{navigation_layout_html}}}',
  styles: `[data-block="navigation_form"]{display:grid;grid-template-columns:repeat(var(--columns,1),minmax(0,1fr));gap:var(--gap_px,12px);align-items:end;font-size:var(--font_size_px,1rem);line-height:var(--line_height,1.4)}
[data-block="navigation_form"][data-font="body"]{font-family:var(--font-body,inherit)}
[data-block="navigation_form"][data-font="heading"]{font-family:var(--font-heading,inherit)}
[data-block="navigation_form"] .navigation-field{display:flex;flex-direction:column;gap:6px;min-width:0}
[data-block="navigation_form"] label{font-weight:600}
[data-block="navigation_form"][data-show-labels="false"] label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
[data-block="navigation_form"] .navigation-input{width:100%;box-sizing:border-box;min-height:var(--input_height_px,44px);padding:var(--input_padding_y_px,10px) var(--input_padding_x_px,12px);border:var(--input_border_width_px,1px) solid var(--navigation-input-border,#bbc1c9);border-radius:var(--radius_px,6px);font:inherit;background:var(--navigation-input-bg,#fff);color:var(--navigation-input-color,#20242a)}
[data-block="navigation_form"] .navigation-actions>*{box-sizing:border-box;width:100%;min-height:var(--input_height_px,44px);display:flex;align-items:center;justify-content:center;padding:var(--button_padding_y_px,10px) var(--button_padding_x_px,16px);font:inherit;font-weight:600;background:var(--navigation-button-bg,var(--color-primary,#17243a));color:var(--navigation-button-color,#fff);border:0;border-radius:var(--radius_px,6px);text-decoration:none;cursor:pointer}
[data-block="navigation_form"][data-button-nowrap="true"] .navigation-actions>*{white-space:nowrap}
[data-block="navigation_form"] [hidden]{display:none!important}
[data-block="navigation_form"] :focus-visible{outline:2px solid currentColor;outline-offset:3px}`,
  script: NAVIGATION_FORM_RUNTIME,
  origin: "core",
  created_at: "1970-01-01T00:00:00Z",
};
