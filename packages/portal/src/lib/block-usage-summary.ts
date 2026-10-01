// Shape and wording of a global block's usage. Kept free of server imports
// so the editors (browser) and the server-rendered list share one wording.

export interface BlockUsagePage {
  page_id: string;
  title: string;
  slug: string;
  status: string;
}

export interface BlockUsageTemplate {
  template_id: string;
  label: string;
  status: string;
}

export interface BlockUsageGlobalBlock {
  partial_id: string;
  name: string;
  /** header and footer appear on every page; free blocks where placed. */
  kind: 'header' | 'footer' | 'free';
  status: string;
}

/** Everything that references a global block, saved or in a draft. */
export interface BlockUsage {
  pages: BlockUsagePage[];
  templates: BlockUsageTemplate[];
  global_blocks: BlockUsageGlobalBlock[];
}

export function emptyBlockUsage(): BlockUsage {
  return { pages: [], templates: [], global_blocks: [] };
}

export function blockUsageCount(usage: BlockUsage): number {
  return usage.pages.length + usage.templates.length + usage.global_blocks.length;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * "used on 2 pages", "used on 1 page, 1 template and 1 global block",
 * "used in 1 template". Pages are always named when nothing else uses the
 * block, so an unused block reads "used on 0 pages".
 */
export function describeBlockUsage(usage: BlockUsage): string {
  const parts: string[] = [];
  const namePages = usage.pages.length > 0 || blockUsageCount(usage) === 0;
  if (namePages) parts.push(plural(usage.pages.length, 'page', 'pages'));
  if (usage.templates.length) parts.push(plural(usage.templates.length, 'template', 'templates'));
  if (usage.global_blocks.length) parts.push(plural(usage.global_blocks.length, 'global block', 'global blocks'));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
  return `${namePages ? 'used on' : 'used in'} ${list}`;
}
