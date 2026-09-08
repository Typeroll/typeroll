const breakpoints = new Set(['mobile', 'tablet', 'laptop', 'desktop', 'wide']);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only declared, rendered fields cross the publication boundary. */
export function projectPublicationData(data, schema) {
  if (!object(data)) throw new Error('Invalid publication block data');
  const result = {};
  for (const field of schema) {
    if (field.rendered === false || !Object.hasOwn(data, field.name)) continue;
    const value = data[field.name];
    if (field.type === 'object' && object(value) && Array.isArray(field.fields)) {
      result[field.name] = projectPublicationData(value, field.fields);
    } else if (field.type === 'array' && Array.isArray(value) && Array.isArray(field.fields)) {
      result[field.name] = value.map(item => projectPublicationData(item, field.fields));
    } else {
      // Field values are public content; JSON cloning rejects non-serializable input.
      result[field.name] = JSON.parse(JSON.stringify(value));
    }
  }
  return result;
}

export function projectPublicationBlocks(blocks, definitions, depth = 0) {
  if (!Array.isArray(blocks) || depth > 50) throw new Error('Publication requires HTML content or a valid block tree');
  return blocks.map(block => {
    if (!object(block) || !/^[a-zA-Z0-9_-]{1,128}$/.test(block.id ?? '')) throw new Error('Invalid publication block ID');
    const definition = definitions.find(definition => definition.id === block.type);
    if (!definition) throw new Error('Unsupported publication block type');
    const result = { id: block.id, type: block.type, data: projectPublicationData(block.data, definition.schema) };
    if (block.children !== undefined) result.children = projectPublicationBlocks(block.children, definitions, depth + 1);
    if (block.slots !== undefined) {
      if (!Array.isArray(block.slots)) throw new Error('Invalid publication block slots');
      result.slots = block.slots.map(slot => projectPublicationBlocks(slot, definitions, depth + 1));
    }
    if (block.hidden_on !== undefined) {
      if (!Array.isArray(block.hidden_on) || block.hidden_on.some(value => !breakpoints.has(value))) throw new Error('Invalid block visibility');
      result.hidden_on = [...block.hidden_on];
    }
    if (block.responsive !== undefined) {
      if (!object(block.responsive)) throw new Error('Invalid responsive block data');
      result.responsive = {};
      for (const [breakpoint, override] of Object.entries(block.responsive)) {
        if (!breakpoints.has(breakpoint) || !object(override)) throw new Error('Invalid responsive block data');
        const projected = {};
        if (override.hidden !== undefined) {
          if (typeof override.hidden !== 'boolean') throw new Error('Invalid responsive visibility');
          projected.hidden = override.hidden;
        }
        if (override.data_overrides !== undefined) projected.data_overrides = projectPublicationData(override.data_overrides, definition.schema);
        if (typeof override.class_overrides === 'string') projected.class_overrides = override.class_overrides;
        result.responsive[breakpoint] = projected;
      }
    }
    if (block.style_overrides !== undefined) {
      if (!object(block.style_overrides)) throw new Error('Invalid block style overrides');
      result.style_overrides = {};
      for (const field of ['spacing_before', 'spacing_after', 'custom_css', 'custom_class', 'html_id']) {
        if (typeof block.style_overrides[field] === 'string') result.style_overrides[field] = block.style_overrides[field];
      }
    }
    return result;
  });
}


/** Renderer declarations are public code; editor ownership and provenance are excluded. */
export function projectPublicationSchema(schema) {
  if (!Array.isArray(schema)) throw new Error('Invalid publication schema');
  return schema.filter(field => field.rendered !== false).map(field => {
    if (!object(field) || typeof field.name !== 'string' || !field.name || ['__proto__', 'constructor', 'prototype'].includes(field.name)) throw new Error('Invalid publication field');
    const result = { name: field.name, type: field.type };
    for (const name of ['label', 'placeholder', 'choices_markup', 'ref_collection']) if (typeof field[name] === 'string') result[name] = field[name];
    for (const name of ['required', 'responsive']) if (typeof field[name] === 'boolean') result[name] = field[name];
    for (const name of ['min', 'max']) if (typeof field[name] === 'number' && Number.isFinite(field[name])) result[name] = field[name];
    for (const name of ['options', 'option_labels']) if (field[name] !== undefined) {
      if (!Array.isArray(field[name]) || field[name].some(value => typeof value !== 'string')) throw new Error('Invalid publication field options');
      result[name] = [...field[name]];
    }
    if (field.fields !== undefined) result.fields = projectPublicationSchema(field.fields);
    if (field.responsive_css !== undefined) {
      if (!object(field.responsive_css) || Object.values(field.responsive_css).some(value => typeof value !== 'string')) throw new Error('Invalid publication responsive CSS');
      result.responsive_css = Object.fromEntries(Object.entries(field.responsive_css));
    }
    if (field.default !== undefined) result.default = projectPublicationData({ [field.name]: field.default }, [field])[field.name];
    return result;
  });
}

export function projectPublicationBlockTypes(blockTypes, coreBlockTypes) {
  if (!Array.isArray(blockTypes)) throw new Error('Invalid publication block definitions');
  const definitions = [...coreBlockTypes, ...blockTypes];
  if (new Set(definitions.map(definition => definition.id)).size !== definitions.length) throw new Error('Duplicate publication block definition');
  return blockTypes.map(definition => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(definition.id ?? '')) throw new Error('Invalid publication block definition ID');
    const result = { id: definition.id, schema: projectPublicationSchema(definition.schema) };
    if (definition.extension) {
      result.extension = {};
      for (const field of ['extension_id', 'installation_id', 'component_id', 'render_mode']) {
        if (typeof definition.extension[field] !== 'string') throw new Error('Invalid publication Extension block');
        result.extension[field] = definition.extension[field];
      }
    }
    for (const name of ['name', 'label', 'icon', 'category', 'template', 'styles', 'script', 'origin']) {
      if (typeof definition[name] === 'string') result[name] = definition[name];
    }
    if (definition.container !== undefined) {
      if (![true, false, 'slots', 'repeater', 'conditional'].includes(definition.container)) throw new Error('Invalid publication container kind');
      result.container = definition.container;
    }
    if (Number.isInteger(definition.slot_count)) result.slot_count = definition.slot_count;
    if (typeof definition.item_compatible === 'boolean') result.item_compatible = definition.item_compatible;
    for (const name of ['slot_labels', 'script_fields']) if (definition[name] !== undefined) {
      if (!Array.isArray(definition[name]) || definition[name].some(value => typeof value !== 'string')) throw new Error('Invalid publication block metadata');
      result[name] = [...definition[name]];
    }
    if (definition.expand_to !== undefined) {
      const target = definitions.find(candidate => candidate.id === definition.expand_to.target);
      if (!target) throw new Error('Publication block alias target is missing');
      result.expand_to = { target: target.id, defaults: projectPublicationData(definition.expand_to.defaults, target.schema) };
    }
    return result;
  });
}
