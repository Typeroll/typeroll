// @ts-ignore -- the validator is plain JavaScript shared with the frozen publication build.
import { unnamedImageLinks } from '../../../../site-template/src/lib/publication-validation.mjs';
import { ConnectionError } from './connections';

export interface DryRunValidationIssue { code: 'image_link_unnamed'; page: string; href: string; source: 'image_block' | 'html' }

/**
 * Checks a dry run can make on frozen content without rendering. They mirror
 * build rules that otherwise fail only after media preparation; the full
 * validator still runs on the rendered output.
 */
export function dryRunValidationIssues(pages: Array<Record<string, any>>): DryRunValidationIssue[] {
  const issues: DryRunValidationIssue[] = [];
  for (const page of pages) {
    const label = String(page.path ?? page.url ?? page.id ?? '');
    const seen = new Set<unknown>();
    const visit = (value: unknown): void => {
      if (!value || seen.has(value)) return;
      if (typeof value === 'string') {
        if (/<a[\s>]/i.test(value) && /<img[\s>]/i.test(value)) for (const href of unnamedImageLinks(value)) issues.push({ code: 'image_link_unnamed', page: label, href, source: 'html' });
        return;
      }
      if (typeof value !== 'object') return;
      seen.add(value);
      const block = value as Record<string, any>;
      if (block.type === 'core/image' && block.data && typeof block.data === 'object') {
        const link = String(block.data.link ?? '').trim();
        if (link && !String(block.data.alt ?? '').trim()) issues.push({ code: 'image_link_unnamed', page: label, href: link, source: 'image_block' });
      }
      for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
    };
    visit(page);
  }
  return issues;
}

export function assertDryRunValidation(pages: Array<Record<string, any>>) {
  const issues = dryRunValidationIssues(pages);
  if (!issues.length) return;
  const first = issues[0];
  throw new ConnectionError(`Publication validation failed: Image link has no accessible name: ${first.href} (${first.page})${issues.length > 1 ? ` and ${issues.length - 1} more` : ''}. Supply meaningful image alt text or link text.`, 422, 'publication_validation_failed', { issues: issues.slice(0, 50) });
}
