import { Agent } from 'undici';
import net from 'node:net';
import { assertPublicDestination, parsePublicHttpsUrl } from '../extensions/public-http';

interface Options { fetchImpl?: typeof fetch; validate?: typeof assertPublicDestination }
const missingDns = (error: unknown) => {
  const value = error as { code?: string; cause?: { code?: string } };
  return (value?.cause?.code ?? value?.code) === 'ENOTFOUND';
};

export function publicIpv4Answers(data: any): string[] {
  if (data?.Status !== 0 || !Array.isArray(data.Answer)) throw Error('Public DNS has not confirmed this host');
  const answers = [...new Set<string>(data.Answer.filter((entry: any) => entry.type === 1).map((entry: any) => entry.data))];
  if (!answers.length || answers.length > 8) throw Error('Public DNS has not confirmed this host');
  for (const address of answers) {
    if (!net.isIPv4(address)) throw Error('Invalid public DNS address');
    parsePublicHttpsUrl(`https://${address}`);
  }
  return answers;
}

/** A newly created hostname can outlive a process-local negative DNS answer.
 * Resolve only that failure through public DNS, then pin the HTTPS connection
 * to checked IPv4 answers. Never fall back after a private-address rejection. */
export async function publicationResponse(url: URL, init: RequestInit, options: Options = {}) {
  parsePublicHttpsUrl(url.href);
  if (!['GET', 'HEAD'].includes(init.method ?? 'GET')) throw Error('Publication checks must be read-only');
  let response: Response | undefined, agent: Agent | undefined;
  const close = async () => {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    await agent?.close();
  };
  try {
    try {
      await (options.validate ?? assertPublicDestination)(url);
      response = await (options.fetchImpl ?? fetch)(url, { ...init, redirect: 'manual' });
    } catch (error) {
      if (!missingDns(error) || options.fetchImpl || options.validate) throw error;
      const resolver = new URL('https://cloudflare-dns.com/dns-query');
      resolver.searchParams.set('name', url.hostname); resolver.searchParams.set('type', 'A');
      const dns = await fetch(resolver, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Accept: 'application/dns-json' } });
      if (!dns.ok || !dns.body) throw error;
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of dns.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.length; if (size > 65536) throw Error('Public DNS response exceeds its limit'); chunks.push(Buffer.from(chunk));
      }
      const addresses = publicIpv4Answers(JSON.parse(Buffer.concat(chunks).toString('utf8'))).map(address => ({ address, family: 4 as const }));
      agent = new Agent({ connect: { lookup: (hostname, lookupOptions, callback) => {
        if (hostname !== url.hostname) return callback(Error('Publication host changed'), '', 4);
        if (lookupOptions.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, 4);
      } } });
      response = await fetch(url, { ...init, redirect: 'manual', dispatcher: agent } as RequestInit);
    }
    return { response: response!, close };
  } catch (error) { await close(); throw error; }
}
