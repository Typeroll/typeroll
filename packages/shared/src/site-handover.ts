/**
 * Handing a site over to a client: a checklist, an optional structure lock
 * and a start view for the people who edit content.
 *
 * Stored as `SiteSettings.handover`. With `lock_structure`, people without
 * design rights (editors, clients with a shared site) can change the content
 * of blocks but not add, remove or move blocks, change a block's type, or
 * create or delete pages. Builders and administrators are never locked.
 */

export interface HandoverChecklistItem {
  id: string;
  label: string;
  done?: boolean;
  /** A portal address to do it, e.g. `/app/sites/<id>/media`. */
  href?: string;
}

export interface SiteHandover {
  lock_structure?: boolean;
  /** Page id the start view opens first. */
  start_page?: string;
  checklist?: HandoverChecklistItem[];
  /** Set when the site was handed over; absent while it is being built. */
  handed_over_at?: string;
}

export const MAX_HANDOVER_ITEMS = 40;
const ITEM_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Errors in a handover object. The settings API replaces the whole object on write. */
export function siteHandoverErrors(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  if (typeof input !== 'object' || Array.isArray(input)) return ['handover must be an object'];
  const h = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of Object.keys(h)) if (!['lock_structure', 'start_page', 'checklist', 'handed_over_at'].includes(key)) errors.push(`handover.${key} is not allowed`);
  if (h.lock_structure !== undefined && typeof h.lock_structure !== 'boolean') errors.push('handover.lock_structure must be true or false');
  if (h.start_page !== undefined && (typeof h.start_page !== 'string' || !h.start_page || h.start_page.length > 128)) errors.push('handover.start_page must be a page id');
  if (h.handed_over_at !== undefined && (typeof h.handed_over_at !== 'string' || Number.isNaN(Date.parse(h.handed_over_at)))) errors.push('handover.handed_over_at must be a date');
  if (h.checklist !== undefined) {
    if (!Array.isArray(h.checklist) || h.checklist.length > MAX_HANDOVER_ITEMS) errors.push(`handover.checklist must be a list of at most ${MAX_HANDOVER_ITEMS} items`);
    else {
      const seen = new Set<string>();
      h.checklist.forEach((item, index) => {
        const where = `handover.checklist[${index}]`;
        if (!item || typeof item !== 'object') { errors.push(`${where} must be an object`); return; }
        const i = item as Record<string, unknown>;
        if (typeof i.id !== 'string' || !ITEM_ID.test(i.id)) errors.push(`${where}.id must be a slug`);
        else if (seen.has(i.id)) errors.push(`${where}.id "${i.id}" is used twice`);
        else seen.add(i.id);
        if (typeof i.label !== 'string' || !i.label.trim() || i.label.length > 200) errors.push(`${where}.label must be text up to 200 characters`);
        if (i.done !== undefined && typeof i.done !== 'boolean') errors.push(`${where}.done must be true or false`);
        if (i.href !== undefined && (typeof i.href !== 'string' || !/^\/(?!\/)[^\s]{0,500}$/.test(i.href))) errors.push(`${where}.href must be a portal path starting with /`);
        for (const key of Object.keys(i)) if (!['id', 'label', 'done', 'href'].includes(key)) errors.push(`${where}.${key} is not allowed`);
      });
    }
  }
  return errors;
}

/** Whether the structure lock applies to a person: only with the lock on and without design rights. */
export function structureLocked(handover: SiteHandover | null | undefined, canDesign: boolean): boolean {
  return !!handover?.lock_structure && !canDesign;
}

/** The checklist's progress, e.g. for the start view: `{ done: 3, total: 5 }`. */
export function handoverProgress(handover: SiteHandover | null | undefined): { done: number; total: number } {
  const items = handover?.checklist ?? [];
  return { done: items.filter(item => item.done).length, total: items.length };
}

// ── Placeholders left in content ─────────────────────────────────────────

const PLACEHOLDER = /\[([A-Z][^\]\n<>]{1,118})\](?!\()/g;

/**
 * Bracketed placeholders such as "[Feature name]" left in a block tree's
 * text — the built-in starters mark what to replace that way. Markdown links
 * and lower-case brackets are not placeholders.
 */
export function bracketPlaceholders(value: unknown, limit = 20): string[] {
  const found = new Set<string>();
  const scan = (input: unknown, key = '', depth = 0) => {
    if (found.size >= limit || depth > 40) return;
    if (typeof input === 'string') {
      if (/(?:^|_)(?:id|type|href|url|src|class|style_id|css)$/.test(key)) return;
      for (const match of input.replace(/<[^>]*>/g, ' ').matchAll(PLACEHOLDER)) { found.add(`[${match[1].trim()}]`); if (found.size >= limit) return; }
    } else if (Array.isArray(input)) input.forEach(item => scan(item, key, depth + 1));
    else if (input && typeof input === 'object') for (const [inner, child] of Object.entries(input)) scan(child, inner, depth + 1);
  };
  scan(value);
  return [...found];
}
