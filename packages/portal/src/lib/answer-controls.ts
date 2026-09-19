export interface EditField {
  name: string; label?: string; type: string; value?: unknown;
  fields?: EditField[]; item_key?: string;
  options?: Array<string | { value: string; label: string }>;
  option_labels?: string[];
  path?: string; sources?: Record<string, { kind: string; updated_at: string }>;
  source?: { kind: string; updated_at: string };
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) => {
  const result = document.createElement(tag); if (text) result.textContent = text; return result;
};
export const sameAnswer = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key) && sameAnswer((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
};
/** The control returns only deliberate edits; displayed defaults never confirm data. */
export function editControl(field: EditField, onChange: () => void): { element: HTMLElement; read(): unknown } {
  let value = structuredClone(field.value);
  const wrapper = node('fieldset'); wrapper.style.cssText = 'border:0;padding:0;margin:0;display:grid;gap:.5rem;min-width:0';
  wrapper.append(node('legend', field.label ?? field.name));
  const path = field.path ?? field.name;
  const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
  const source = field.sources?.[path] ?? field.source;
  if (source) wrapper.append(node('small', `Source: ${source.kind} · ${source.updated_at}`));
  const changed = (next: unknown) => { value = next; onChange(); };
  const style = 'font:inherit;box-sizing:border-box;max-width:100%;min-width:0;min-height:44px;padding:.6rem;border:1px solid #888;border-radius:.35rem';
  if (field.type === 'boolean') {
    const group = `answer-${crypto.randomUUID()}`;
    const radios: HTMLInputElement[] = [];
    const choices = node('div'); choices.style.cssText = 'display:flex;flex-wrap:wrap;gap:1.5rem'; wrapper.append(choices);
    for (const [label, answer] of [['Yes', true], ['No', false]] as const) {
      const line = node('label', label); line.style.cssText = 'display:flex;align-items:center;gap:.65rem;min-height:44px';
      const input = node('input'); input.type = 'radio'; input.name = group; input.value = String(answer); input.checked = value === answer;
      input.addEventListener('change', () => changed(answer)); radios.push(input); line.prepend(input); choices.append(line);
    }
    const clear = node('button', 'Clear answer'); clear.type = 'button'; clear.style.cssText = style + ';justify-self:start';
    clear.addEventListener('click', () => { radios.forEach(input => { input.checked = false; }); changed(null); });
    wrapper.append(clear);
  } else if (field.type === 'object') {
    for (const child of field.fields ?? []) {
      const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const control = editControl({ ...child, value: object[child.name], sources: field.sources, path: `${path}/${escape(child.name)}` }, () => {
        changed({ ...(value && typeof value === 'object' ? value : {}), [child.name]: control.read() });
      }); wrapper.append(control.element);
    }
  } else if (['array', 'list'].includes(field.type) && field.fields) {
    let items = Array.isArray(value) ? structuredClone(value) : [];
    const rows = node('div'); rows.style.cssText = 'display:grid;gap:1.5rem';
    const render = () => {
      rows.replaceChildren();
      items.forEach((item, i) => {
        const definition = { ...field, type: 'object', label: `${field.label ?? field.name} ${i + 1}`,
          fields: field.fields!.filter(child => child.name !== field.item_key), value: item,
          path: field.item_key ? `${path}/@${escape(String(item[field.item_key]))}` : path };
        const control = editControl(definition, () => { items[i] = control.read(); changed([...items]); });
        const remove = node('button', 'Remove item'); remove.type = 'button'; remove.style.cssText = style;
        remove.addEventListener('click', () => { items.splice(i, 1); changed([...items]); render(); });
        control.element.append(remove); rows.append(control.element);
      });
    }; render(); wrapper.append(rows);
    const add = node('button', 'Add item'); add.type = 'button'; add.style.cssText = style;
    add.addEventListener('click', () => { items.push(field.item_key ? { [field.item_key]: crypto.randomUUID() } : {}); changed([...items]); render(); }); wrapper.append(add);
  } else if (['select', 'multiselect', 'page_ref', 'page_ref_list'].includes(field.type)) {
    const input = node('select'); input.setAttribute('aria-label', field.label ?? field.name); input.style.cssText = style; input.multiple = ['multiselect', 'page_ref_list'].includes(field.type);
    const options = field.options ?? [];
    if (!input.multiple) { const empty = node('option', 'Unanswered'); empty.value = ''; input.append(empty); }
    const known = new Set(options.map(option => typeof option === 'string' ? option : option.value));
    const selected = Array.isArray(value) ? value : typeof value === 'string' && value ? [value] : [];
    // Preserve previously selected references even if no longer in discovery.
    for (const option of [...options, ...selected.filter(item => typeof item === 'string' && !known.has(item))]) {
      const id = typeof option === 'string' ? option : option.value;
      const item = node('option', typeof option === 'string' ? field.option_labels?.[(field.options ?? []).indexOf(option)] ?? option : option.label);
      item.value = id; item.selected = selected.includes(id); input.append(item);
    }
    input.addEventListener('change', () => changed(input.multiple ? [...input.selectedOptions].map(option => option.value) : input.value || null)); wrapper.append(input);
  } else {
    const multi = ['textarea', 'richtext', 'list_simple'].includes(field.type);
    const input = multi ? node('textarea') : node('input'); input.setAttribute('aria-label', field.label ?? field.name); input.style.cssText = style;
    if (input instanceof HTMLInputElement) input.type = ['number', 'email', 'url', 'date'].includes(field.type) ? field.type : 'text';
    input.value = field.type === 'list_simple' && Array.isArray(value) ? value.join('\n') : String(value ?? '');
    input.addEventListener('input', () => changed(field.type === 'number' ? input.value === '' ? null : Number(input.value)
      : field.type === 'list_simple' ? input.value.split('\n').filter(Boolean) : input.value)); wrapper.append(input);
  }
  return { element: wrapper, read: () => value };
}
