import { useState } from 'react';
import type { WorkflowType } from '@typeroll/shared';

interface FieldDef {
  name: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'number';
  placeholder?: string;
  options?: string[];
  default?: string;
  help?: string;
  optional?: boolean;
}

const fieldsByWorkflow: Partial<Record<WorkflowType, FieldDef[]>> = {
  migration: [
    {
      name: 'wp_url',
      label: 'WordPress site URL',
      type: 'text',
      placeholder: 'https://oldsite.com',
      help: 'The /wp-json/ endpoint must be publicly reachable.',
    },
    {
      name: 'helper_api_key',
      label: 'Typeroll Helper API key (optional)',
      type: 'text',
      placeholder: '',
      optional: true,
      help: 'Install the Typeroll Helper plugin on the WP site for reliable access to custom post types, ACF fields, and featured images. Copy the API key from Settings → Typeroll in WP admin. Leave blank to use only the standard /wp-json/wp/v2/.',
    },
  ],
  site_planning: [
    {
      name: 'business_description',
      label: 'Describe the business',
      type: 'textarea',
      placeholder: 'A family-owned hair salon in downtown Portland offering cuts, color, and treatments. Open since 2014. Target customer is women 25-50 who care about local, hand-crafted experiences.',
      help: 'Be specific about what you do, who for, and what makes you different.',
    },
  ],
  content_generation: [
    { name: 'topic', label: 'Page topic / prompt', type: 'textarea', placeholder: 'A page about our cold-brew coffee process' },
    { name: 'tone', label: 'Tone', type: 'text', placeholder: 'professional, friendly', default: 'professional, friendly' },
    { name: 'audience', label: 'Audience', type: 'text', placeholder: 'coffee enthusiasts', default: 'general readers' },
  ],
  content_improvement: [
    { name: 'limit', label: 'How many pages to improve?', type: 'number', default: '5' },
  ],
  rebuild_deploy: [
    {
      name: 'environment',
      label: 'Environment',
      type: 'select',
      options: ['staging', 'production'],
      default: 'staging',
    },
  ],
  url_parity: [
    {
      name: 'target_origin',
      label: 'Origin to check (optional)',
      type: 'text',
      placeholder: 'https://mysite.sites.typeroll.com',
      optional: true,
      help: 'Defaults to this site\'s fallback subdomain — the right target before DNS is switched over. Override to check the live domain after cutover.',
    },
    {
      name: 'source_origin',
      label: 'Old site origin (optional)',
      type: 'text',
      placeholder: 'https://oldsite.com',
      optional: true,
      help: 'When set together with "Also check the old site", every path is requested upstream too, so a URL that already 404s on the old site is distinguishable from one the migration lost.',
    },
    {
      name: 'check_source',
      label: 'Also check the old site',
      type: 'select',
      options: ['false', 'true'],
      default: 'false',
      optional: true,
    },
    {
      name: 'statuses',
      label: 'Limit to coverage statuses (optional)',
      type: 'text',
      placeholder: 'unhandled,redirected',
      optional: true,
      help: 'Comma-separated: migrated, redirected, excluded, unhandled. Leave blank to check everything — "migrated" is exactly the claim this check exists to falsify.',
    },
  ],
  seo_audit: [],
  link_check: [],
  performance_audit: [],
  schema_markup: [],
};

interface Props {
  siteId: string;
  type: WorkflowType;
}

export default function StartWorkflow({ siteId, type }: Props) {
  const fields = fieldsByWorkflow[type] ?? [];
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    for (const f of fields) if (f.default) v[f.name] = f.default;
    return v;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const config: Record<string, unknown> = {};
    for (const f of fields) {
      const v = values[f.name] ?? f.default ?? '';
      config[f.name] = f.type === 'number' ? Number(v) : v;
    }
    try {
      const res = await fetch(`/api/sites/${siteId}/workflows/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, config }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to start');
      window.location.href = `/app/sites/${siteId}/workflows/${data.workflowId}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={start} className="card stack" style={{ maxWidth: 640 }}>
      {fields.length === 0 ? (
        <p className="muted">This workflow takes no configuration. Click below to run it.</p>
      ) : (
        fields.map((f) => (
          <div key={f.name} className="field">
            <label>{f.label}</label>
            {f.type === 'textarea' ? (
              <textarea
                rows={5}
                value={values[f.name] ?? ''}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                placeholder={f.placeholder}
                required={!f.optional}
              />
            ) : f.type === 'select' ? (
              <select
                value={values[f.name] ?? ''}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
              >
                {f.options!.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            ) : (
              <input
                type={f.type === 'number' ? 'number' : 'text'}
                value={values[f.name] ?? ''}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                placeholder={f.placeholder}
                required={!f.optional}
              />
            )}
            {f.help && <span className="muted text-sm">{f.help}</span>}
          </div>
        ))
      )}

      {error && <div style={{ color: 'var(--color-danger)', fontSize: '0.875rem' }}>{error}</div>}

      <div>
        <button type="submit" className="btn" disabled={busy}>{busy ? 'Starting…' : 'Start workflow'}</button>
      </div>
    </form>
  );
}
