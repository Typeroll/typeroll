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
export function trackedBacklinks(index) {
  return new Proxy(index, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof key === 'string') active.getStore()?.push({ kind: 'backlinks', id: key, hash: digest(value ?? null) });
    return value;
  } });
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
      if (entry.kind === 'backlinks') return digest(resolvers.backlinks[entry.id] ?? null) === entry.hash;
      if (entry.kind === 'navigation') return digest(resolvers.navigation(entry.id)) === entry.hash;
      return false;
    });
  } catch { return false; }
}

export function navigationContext(type, pageId, compute) {
  let value;
  const read = () => recordNavigation(pageId, value ??= compute());
  return { ...type, get previous() { return read().previous; }, get next() { return read().next; } };
}
