// Hard-coded colours and font families in a block template (the
// `design_findings` a template save answers with, lib/design-token-audit.ts),
// with the palette or font role to use instead. A finding with an exact
// `replacement` offers "Use <token>": the template's blocks are patched
// (applyDesignTokenReplacements) and saved again, so the template follows
// the design of every site it is inserted into. Nothing here blocks a save.

import { useState } from 'react';
import { applyDesignTokenReplacements, type BlockTemplate, type DesignTokenReplacement } from '@typeroll/shared';

export interface TemplateDesignFindingView {
  code: 'hardcoded_color' | 'hardcoded_size' | 'hardcoded_font';
  path: string;
  value: string | number;
  suggestions: string[];
  exact_matches: string[];
  message: string;
  block_id?: string;
  replacement?: DesignTokenReplacement;
}

const ROLE_LABEL: Record<string, string> = { heading: 'heading font', body: 'body font', mono: 'mono font', display: 'display font', accent: 'accent font' };

/** One line for a finding: what is hard-coded and what to use. */
export function findingLine(finding: TemplateDesignFindingView): string {
  const what = finding.code === 'hardcoded_font' ? `The font “${finding.value}”` : `The colour ${finding.value}`;
  const use = finding.suggestions.map(token => ROLE_LABEL[token] ?? token).join(' or ');
  return use ? `${what} is hard-coded; use ${use} instead.` : `${what} is hard-coded.`;
}

/** Save the template with one finding's exact replacement applied; answers with the saved template and its new findings. */
export async function applyTemplateFinding(siteId: string, template: Pick<BlockTemplate, 'id' | 'blocks'>, replacement: DesignTokenReplacement): Promise<{ template: BlockTemplate; findings: TemplateDesignFindingView[] }> {
  const blocks = applyDesignTokenReplacements(template.blocks, [replacement]);
  const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/block-templates/${encodeURIComponent(template.id)}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blocks }),
  });
  const body = await res.json().catch(() => ({})) as { block_template?: BlockTemplate; design_findings?: TemplateDesignFindingView[]; error?: string };
  if (!res.ok || !body.block_template) throw new Error(body.error ?? `Could not save the template (${res.status})`);
  return { template: body.block_template, findings: body.design_findings ?? [] };
}

export function TemplateDesignFindings({ siteId, template, findings, canEdit = true, onSaved }: {
  siteId: string;
  template: Pick<BlockTemplate, 'id' | 'blocks'>;
  findings: TemplateDesignFindingView[];
  canEdit?: boolean;
  onSaved: (result: { template: BlockTemplate; findings: TemplateDesignFindingView[] }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!findings.length) return null;
  const apply = async (replacement: DesignTokenReplacement) => {
    setBusy(true); setError(null);
    try { onSaved(await applyTemplateFinding(siteId, template, replacement)); }
    catch (caught) { setError((caught as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="template-design-findings" data-design-findings role="status">
      <p style={{ margin: '0 0 .25rem', fontWeight: 600 }}>
        {findings.length === 1 ? '1 hard-coded value' : `${findings.length} hard-coded values`}: the template keeps {findings.length === 1 ? 'it' : 'them'} on every site.
      </p>
      <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
        {findings.map(finding => (
          <li key={`${finding.path}:${finding.value}`} data-finding-path={finding.path}>
            {findingLine(finding)}
            {canEdit && finding.replacement && <> <button type="button" className="btn btn--secondary" disabled={busy}
              onClick={() => void apply(finding.replacement!)}>Use {finding.replacement.after}</button></>}
          </li>
        ))}
      </ul>
      {error && <p role="alert" style={{ margin: '.25rem 0 0' }}>{error}</p>}
    </div>
  );
}
