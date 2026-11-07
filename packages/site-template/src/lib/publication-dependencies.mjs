import { AsyncLocalStorage } from 'node:async_hooks';
import { digest } from './publication-render-cache.mjs';

// One receipt per render, including awaits in partials and forms. No global
// current-page variable: parallel renders must never share dependency receipts.
const active = new AsyncLocalStorage();
export function captureDependencies(render) {
  const dependencies = [];
  return active.run(dependencies, async () => ({ value: await render(), dependencies }));
}
export function trackedPageSource(source) {
  return config => {
    const result = source(config);
    const dependencies = active.getStore();
    if (!dependencies) return result;
    const entry = { kind: 'query', config: JSON.parse(JSON.stringify(config)),
      members: digest(result.map(item => item.id)), reads: {} };
    dependencies.push(entry);
    // Query membership is recorded even for empty results; insertions, filter
    // changes, order and limit changes are therefore detected on replay. Only
    // records actually visited (e.g. the current archive slice) add value hashes.
    return new Proxy(result, { get(target, key, receiver) {
      if (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < target.length)
        entry.reads[key] = digest(target[key]);
      return Reflect.get(target, key, receiver);
    } });
  };
}
/** Record the selected output, including an empty result; receipt counts alone are insufficient. */
export function trackedDerivedSource(resolve) {
  return config => {
    const value = resolve(config);
    active.getStore()?.push({ kind: 'derived', config: structuredClone(config), hash: digest(value) });
    return value;
  };
}
export function trackedBacklinks(index) {
  return new Proxy(index, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof key === 'string') active.getStore()?.push({ kind: 'backlinks', id: key, hash: digest(value ?? null) });
    return value;
  } });
}
/** Record successful AND missing URL lookups: later imports can resolve a miss. */
export function trackedMediaLookup(lookup) {
  return { ...lookup, byUrl: new Proxy(lookup.byUrl, { get(target, key) {
    if (key === 'get') return url => {
      const value = target.get(url);
      active.getStore()?.push({ kind: 'media', url, hash: digest(value ?? null) });
      return value;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }) };
}
/**
 * What site menus read about pages (title, address, parent, order), as one
 * receipt per render: a menu follows renames and new child pages, while an
 * edit to a page's body leaves every route that only shows it in a menu.
 */
export function trackedMenuPages(compute) {
  let value;
  return () => {
    value ??= compute();
    const dependencies = active.getStore();
    if (dependencies && !dependencies.some(entry => entry.kind === 'menu_pages')) dependencies.push({ kind: 'menu_pages', hash: digest(value) });
    return value;
  };
}
/**
 * The site field values a render reads (`site.fields.*`, a condition, a site
 * field block), as one receipt on the first read: a route that never reads
 * them does not depend on them. `receipt` returns what the hash covers, the
 * values and the definitions that pick their formats.
 */
export function trackedSiteFields(values, receipt) {
  let hash;
  const record = () => {
    const dependencies = active.getStore();
    if (dependencies && !dependencies.some(entry => entry.kind === 'site_fields')) dependencies.push({ kind: 'site_fields', hash: hash ??= digest(receipt()) });
  };
  return new Proxy(values, {
    get(target, key, receiver) { record(); return Reflect.get(target, key, receiver); },
    has(target, key) { record(); return Reflect.has(target, key); },
    ownKeys(target) { record(); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) { record(); return Reflect.getOwnPropertyDescriptor(target, key); },
  });
}
/**
 * Output that depends on the build's date and time (today's opening hours),
 * with its input: a later build recomputes it and renders the route again
 * only when the output differs.
 */
export function recordClockOutput(input, html) {
  active.getStore()?.push({ kind: 'clock', input: structuredClone(input), hash: digest(html) });
}
export function recordNavigation(pageId, value) {
  active.getStore()?.push({ kind: 'navigation', id: pageId, hash: digest(value) });
  return value;
}
export function dependenciesMatch(dependencies, resolvers, queries = new Map()) {
  if (!Array.isArray(dependencies)) return false;
  try {
    return dependencies.every(entry => {
      if (entry.kind === 'query') {
        if (!entry.config || !entry.reads || typeof entry.reads !== 'object') return false;
        const key = digest(entry.config);
        let query = queries.get(key);
        if (!query) {
          const result = resolvers.query(entry.config);
          query = { result, members: digest(result.map(item => item.id)), hashes: new Map() };
          queries.set(key, query);
        }
        return query.members === entry.members && Object.entries(entry.reads).every(([index, hash]) => {
          if (!/^(0|[1-9][0-9]*)$/.test(index) || Number(index) >= query.result.length) return false;
          if (!query.hashes.has(index)) query.hashes.set(index, digest(query.result[index]));
          return query.hashes.get(index) === hash;
        });
      }
      if (entry.kind === 'derived') return digest(resolvers.derived(entry.config)) === entry.hash;
      if (entry.kind === 'media') return digest(resolvers.media.byUrl.get(entry.url) ?? null) === entry.hash;
      if (entry.kind === 'backlinks') return digest(resolvers.backlinks[entry.id] ?? null) === entry.hash;
      if (entry.kind === 'navigation') return digest(resolvers.navigation(entry.id)) === entry.hash;
      if (entry.kind === 'menu_pages') return digest(resolvers.menuPages()) === entry.hash;
      if (entry.kind === 'site_fields') return digest(resolvers.siteFields()) === entry.hash;
      if (entry.kind === 'clock') return digest(resolvers.clock(entry.input)) === entry.hash;
      return false;
    });
  } catch { return false; }
}

export function navigationContext(type, pageId, compute) {
  let value;
  const read = () => recordNavigation(pageId, value ??= compute());
  return { ...type, get previous() { return read().previous; }, get next() { return read().next; } };
}

/** Refresh dependency receipts only after complete normalized render-input equality is proven. */
export function refreshDependencies(dependencies, resolvers, from, to, replace) {
  return dependencies.map(original => {
    const entry = replace(original, from, to);
    if (entry.kind === 'query') {
      const result = resolvers.query(entry.config);
      return { ...entry, members: digest(result.map(item => item.id)), reads: Object.fromEntries(Object.keys(entry.reads).map(index => [index, digest(result[index])])) };
    }
    if (entry.kind === 'derived') return { ...entry, hash: digest(resolvers.derived(entry.config)) };
    if (entry.kind === 'media') return { ...entry, hash: digest(resolvers.media.byUrl.get(entry.url) ?? null) };
    if (entry.kind === 'backlinks') return { ...entry, hash: digest(resolvers.backlinks[entry.id] ?? null) };
    if (entry.kind === 'navigation') return { ...entry, hash: digest(resolvers.navigation(entry.id)) };
    if (entry.kind === 'menu_pages') return { ...entry, hash: digest(resolvers.menuPages()) };
    if (entry.kind === 'site_fields') return { ...entry, hash: digest(resolvers.siteFields()) };
    // Reused HTML holds the earlier output: a rebase is only safe while it is still the same.
    if (entry.kind === 'clock') {
      if (digest(resolvers.clock(entry.input)) !== entry.hash) throw new Error('Date-dependent output changed');
      return entry;
    }
    throw new Error('Unknown cached dependency');
  });
}
