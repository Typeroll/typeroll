// Per-route block settings.
//
// A shared header partial renders on every route, but the block that sits
// over a teal hero on the home page has to be a different colour there than
// anywhere else. Before this, the only ways to say so were a second copy of
// the block behind visibility branches or site CSS against
// `body[data-route="home"]` — a selector a site author has to know, write and
// keep in sync with the setting it overrides.
//
// `route_overrides` says it in the block itself: `{ home: { data_overrides:
// { background: 'primary' } } }`. When the page being rendered is of that
// route kind (page-identity.ts `routeKind`, the same value the page carries as
// `<body data-route>`), the overrides are merged over `block.data` before the
// block renders, so every setting a block has can vary by route and is checked
// like the block's own data.
//
// OPT-IN AND INERT WITHOUT A ROUTE. A block without the field renders exactly
// as before, and a renderer that does not know the route (a bare block
// preview, a form step) renders the base data. Nothing is guessed.

import { ROUTE_KINDS, type RouteKind } from './page-identity.js';
import type { Block, RouteOverride } from './types.js';

const OVERRIDE_KEYS = ['data_overrides'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isRouteKind(value: unknown): value is RouteKind {
  return typeof value === 'string' && (ROUTE_KINDS as readonly string[]).includes(value);
}

/**
 * Why a `route_overrides` value cannot be stored, or null. `path` names the
 * field, e.g. `blocks[0].route_overrides`.
 */
export function routeOverridesError(value: unknown, path = 'route_overrides'): string | null {
  if (!isRecord(value)) return `${path} must be an object keyed by route kind (${ROUTE_KINDS.join(', ')}), for example { "home": { "data_overrides": { "background": "primary" } } }.`;
  for (const [route, override] of Object.entries(value)) {
    if (!isRouteKind(route)) return `${path}.${route} is not a route kind. Use one of ${ROUTE_KINDS.join(', ')} (the page's <body data-route>).`;
    if (!isRecord(override)) return `${path}.${route} must be an object with data_overrides.`;
    for (const key of Object.keys(override)) {
      if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) return `${path}.${route}.${key} is not supported. A route override holds data_overrides only.`;
    }
    if (override.data_overrides !== undefined && !isRecord(override.data_overrides)) return `${path}.${route}.data_overrides must be an object of field values.`;
  }
  return null;
}

/** Every route override's data with its route, in a stable order. */
export function routeOverrideEntries(block: Pick<Block, 'route_overrides'>): Array<[RouteKind, Record<string, unknown>]> {
  const overrides = block.route_overrides;
  if (!isRecord(overrides)) return [];
  const out: Array<[RouteKind, Record<string, unknown>]> = [];
  for (const route of ROUTE_KINDS) {
    const data = (overrides[route] as RouteOverride | undefined)?.data_overrides;
    if (isRecord(data)) out.push([route, data]);
  }
  return out;
}

/**
 * The block as it renders on a route of kind `route`: its data with that
 * route's `data_overrides` merged over it (shallow). The same object when
 * nothing applies, so callers can compare by identity.
 */
export function applyRouteOverrides(block: Block, route: RouteKind | undefined): Block {
  if (!route || !isRecord(block.route_overrides)) return block;
  const data = (block.route_overrides[route] as RouteOverride | undefined)?.data_overrides;
  if (!isRecord(data) || !Object.keys(data).length) return block;
  return { ...block, data: { ...block.data, ...data } };
}

/** applyRouteOverrides over a whole tree, children and slots included. Unchanged subtrees keep their identity. */
export function applyRouteOverridesToTree(blocks: Block[], route: RouteKind | undefined): Block[] {
  if (!route) return blocks;
  let changed = false;
  const out = blocks.map(block => {
    let next = applyRouteOverrides(block, route);
    const children = Array.isArray(block.children) ? applyRouteOverridesToTree(block.children, route) : undefined;
    const slots = Array.isArray(block.slots) ? block.slots.map(slot => Array.isArray(slot) ? applyRouteOverridesToTree(slot, route) : slot) : undefined;
    const childrenChanged = children !== undefined && children !== block.children;
    const slotsChanged = slots !== undefined && slots.some((slot, index) => slot !== block.slots![index]);
    if (childrenChanged || slotsChanged) next = { ...next, ...(childrenChanged ? { children } : {}), ...(slotsChanged ? { slots } : {}) };
    if (next !== block) changed = true;
    return next;
  });
  return changed ? out : blocks;
}

