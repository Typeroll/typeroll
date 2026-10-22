// Workflow-friendly helpers around the Anthropic SDK.
//
// These wrap a single non-streaming request and return either text or
// parsed JSON, with the same model the chat uses. The key is the Site owner
// organization's own key (organization-ai.ts); there is no platform key.
// Without access for the Site they throw AiNotEnabledError, which fails the
// workflow step with a message that points to Organization settings.

import type Anthropic from '@anthropic-ai/sdk';
import { AiNotEnabledError, getAnthropicForSite, type AiScope } from './organization-ai';

const MODEL_ID = 'claude-sonnet-4-6';

async function client(scope: AiScope): Promise<Anthropic> {
  const c = await getAnthropicForSite({ orgId: scope.orgId, siteId: scope.siteId });
  if (!c) throw new AiNotEnabledError();
  return c;
}

export async function generateText(
  scope: AiScope,
  system: string,
  user: string,
  opts: { maxTokens?: number } = {}
): Promise<string> {
  const c = await client(scope);
  const res = await c.messages.create({
    model: MODEL_ID,
    max_tokens: opts.maxTokens ?? 4096,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export async function generateJson<T>(
  scope: AiScope,
  system: string,
  user: string,
  opts: { maxTokens?: number } = {}
): Promise<T> {
  const text = await generateText(
    scope,
    `${system}\n\nRespond with valid JSON only. Do not wrap in markdown code fences. Do not include any text before or after the JSON.`,
    user,
    opts
  );
  return parseJsonLoose<T>(text);
}

function parseJsonLoose<T>(s: string): T {
  // Tolerate ```json fences and stray prose before/after.
  let body = s.trim();
  const fenced = body.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) body = fenced[1];
  const firstBrace = body.indexOf('{');
  const firstBracket = body.indexOf('[');
  const start = [firstBrace, firstBracket].filter((n) => n >= 0).sort((a, b) => a - b)[0] ?? 0;
  body = body.slice(start);
  // Trim trailing prose by walking back from the end to the matching closer.
  const last = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (last >= 0) body = body.slice(0, last + 1);
  return JSON.parse(body) as T;
}
