import type { WorkflowType } from '@typeroll/shared';
import type { WorkflowDef } from './types';
import { migrationWorkflow } from './migration';
import { rebuildDeployWorkflow } from './rebuild-deploy';
import { sitePlanningWorkflow } from './site-planning';
import { seoAuditWorkflow } from './seo-audit';
import { contentImprovementWorkflow } from './content-improvement';
import { linkCheckWorkflow } from './link-check';
import { performanceAuditWorkflow } from './performance-audit';
import { contentGenerationWorkflow } from './content-generation';
import { schemaMarkupWorkflow } from './schema-markup';
import { urlParityWorkflow } from './url-parity';

export const workflows: Record<WorkflowType, WorkflowDef> = {
  migration: migrationWorkflow,
  rebuild_deploy: rebuildDeployWorkflow,
  site_planning: sitePlanningWorkflow,
  seo_audit: seoAuditWorkflow,
  content_improvement: contentImprovementWorkflow,
  link_check: linkCheckWorkflow,
  performance_audit: performanceAuditWorkflow,
  content_generation: contentGenerationWorkflow,
  schema_markup: schemaMarkupWorkflow,
  url_parity: urlParityWorkflow,
};

export function getWorkflowDef(type: WorkflowType): WorkflowDef {
  const def = workflows[type];
  if (!def) throw new Error(`Unknown workflow type: ${type}`);
  return def;
}
