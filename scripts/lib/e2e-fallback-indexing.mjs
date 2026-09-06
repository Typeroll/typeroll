import { callHostedMcp } from './e2e-agent-journey.mjs';

export async function runFallbackIndexingJourney({
  fetchImpl = fetch,
  portalUrl,
  apiKey,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const call = (name, args) => callHostedMcp({ fetchImpl, portalUrl, apiKey, name, args });
  const deployment = await call('trigger_deploy', { environment: 'production' });
  const jobId = deployment?.job_id;
  if (!jobId) throw new Error('trigger_deploy returned no job id');

  let terminal;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await call('get_deploy_status', { job_id: jobId });
    terminal = status?.job?.status;
    if (terminal === 'succeeded' || terminal === 'failed') break;
    await wait(5_000);
  }
  if (terminal !== 'succeeded') throw new Error(`fixture deploy ended in ${terminal ?? 'timeout'}`);

  let lastReport;
  let lastPublicResponses;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    lastReport = await call('check_site_indexing');
    const fallback = lastReport?.targets?.find((target) => target?.kind === 'fallback');
    if (typeof fallback?.origin === 'string') {
      const [head, get] = await Promise.all(['HEAD', 'GET'].map(async (method) => {
        const response = await fetchImpl(fallback.origin, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        });
        return {
          method,
          status: response.status,
          noindex: response.headers.get('x-robots-tag')
            ?.split(',')
            .some((directive) => directive.trim().toLowerCase() === 'noindex') === true,
        };
      }));
      lastPublicResponses = { head, get };
    }
    if (
      fallback?.reachable &&
      fallback?.header_noindex &&
      lastPublicResponses?.head.status >= 200 && lastPublicResponses.head.status < 300 &&
      lastPublicResponses?.get.status >= 200 && lastPublicResponses.get.status < 300 &&
      lastPublicResponses.head.noindex && lastPublicResponses.get.noindex
    ) {
      return {
        jobId,
        origin: fallback.origin,
        headStatus: lastPublicResponses.head.status,
        getStatus: lastPublicResponses.get.status,
        xRobotsTag: fallback.x_robots_tag,
      };
    }
    if (attempt < 11) await wait(5_000);
  }

  const fallback = lastReport?.targets?.find((target) => target?.kind === 'fallback');
  throw new Error(
    `fallback indexing protection did not become observable after deploy: ${JSON.stringify({
      origin: fallback?.origin ?? null,
      reachable: fallback?.reachable ?? false,
      head_status: fallback?.head_status ?? null,
      get_status: fallback?.get_status ?? null,
      x_robots_tag: fallback?.x_robots_tag ?? null,
      public_responses: lastPublicResponses ?? null,
      issues: fallback?.issues ?? lastReport?.issues ?? [],
    })}`,
  );
}
