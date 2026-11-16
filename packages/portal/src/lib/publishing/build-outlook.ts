import { publishingReadiness, type PublishingRequirement } from './readiness';
import { buildEngineRuntime } from '../builds/selection';
import { readEngineConfiguration } from '../builds/state';
import { mediaPreparationStatus } from '../media/preparation';

export interface BuildOutlookNote { code: string; message: string }
/**
 * What a dry run cannot prove by validating the source: whether the real
 * publication would be admitted and could build now. `blockers` stop it
 * (the same requirements a publication is refused with); `notes` let it run
 * but make it slower.
 */
export interface BuildOutlook {
  would_fail: boolean;
  blockers: PublishingRequirement[];
  notes: BuildOutlookNote[];
  build_engine: Awaited<ReturnType<typeof buildEngineRuntime>> | null;
}

export async function publicationBuildOutlook(orgId: string, siteId: string, versionId: string): Promise<BuildOutlook> {
  const [readiness, engine, media] = await Promise.all([
    publishingReadiness(orgId, siteId, versionId),
    buildEngineRuntime(orgId).catch(() => null),
    mediaPreparationStatus(orgId, siteId).catch(() => null),
  ]);
  const notes: BuildOutlookNote[] = [];
  const config = engine ? await readEngineConfiguration(orgId, engine.provider) : null;
  if (config?.status === 'preparing' || config?.status === 'qualifying') {
    notes.push({ code: 'build_engine_update_running', message: 'The build engine is being updated; the publication waits for its verification before building.' });
  } else if (engine?.update_reason === 'capability_missing' && engine.auto_update) {
    notes.push({ code: 'build_engine_update_first', message: `The publication first updates the build engine (Node.js ${engine.node_version} → ${engine.required_node_version}) and waits for its verification, which adds several minutes. If the update fails, the publication stops before building.` });
  }
  if (media && ['queued', 'running', 'waiting'].includes(media.state) && media.total > media.completed) {
    notes.push({ code: 'media_preparation_running', message: `${media.total - media.completed} of ${media.total} images are still being prepared in the background; the publication prepares the rest itself, which takes longer.` });
  } else if (media?.state === 'failed') {
    notes.push({ code: 'media_preparation_stopped', message: `Background image preparation stopped (${media.error_code ?? 'unknown'}); the publication prepares the remaining images itself, which takes longer.` });
  }
  return { would_fail: !readiness.ready, blockers: readiness.required, notes, build_engine: engine };
}
