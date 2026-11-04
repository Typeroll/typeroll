// One-step setup for common AI clients. Links only prefill the client's own
// form; the person confirms there and signs in to Typeroll.

import { useState } from 'react';
import type { McpClientLinks } from '@typeroll/shared';

interface Props { endpoint: string; links: McpClientLinks }

function Command({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="stack" style={{ gap: '.25rem' }}>
    <span className="text-sm">{label}</span>
    <div style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-start' }}>
      <code style={{ overflowWrap: 'anywhere', flex: 1 }}>{command}</code>
      <button type="button" className="btn btn--ghost" aria-label={`Copy the ${label} command`}
        onClick={async () => { try { await navigator.clipboard.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); } }}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  </div>;
}

export default function McpConnectLinks({ endpoint, links }: Props) {
  const [copied, setCopied] = useState(false);
  return <section className="card stack" aria-labelledby="connect-heading">
    <h2 id="connect-heading">Connect an assistant</h2>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem' }}>
      <a className="btn" href={links.claude} target="_blank" rel="noopener noreferrer">Add to Claude ↗</a>
      <a className="btn btn--ghost" href={links.cursor}>Add to Cursor</a>
      <a className="btn btn--ghost" href={links.vscode}>Add to VS Code</a>
    </div>
    <p className="text-sm muted">Add to Claude opens claude.ai with Typeroll filled in; select <strong>Add</strong>, then sign in and approve access. It then works in Claude Desktop too. Team and Enterprise owners can <a href={links.claude_organization} target="_blank" rel="noopener noreferrer">add it for the whole organization ↗</a>.</p>
    <Command label="Claude Code" command={links.claude_code} />
    <Command label="Codex" command={links.codex} />
    <p className="text-sm muted">Other assistants: add this MCP server in their connector settings, then sign in.{' '}
      <code style={{ overflowWrap: 'anywhere' }}>{endpoint}</code>{' '}
      <button type="button" className="btn btn--ghost" onClick={async () => { try { await navigator.clipboard.writeText(endpoint); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy address'}</button>
    </p>
  </section>;
}
