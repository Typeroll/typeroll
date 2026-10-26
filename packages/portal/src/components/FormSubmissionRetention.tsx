// Site-wide opt-in retention for completed form submissions (admins only).
// Empty keeps submissions until someone deletes them, the default.

import { useState } from 'react';

interface Props {
  siteId: string;
  initialDays: number | null;
}

export default function FormSubmissionRetention({ siteId, initialDays }: Props) {
  const [saved, setSaved] = useState<number | null>(initialDays);
  const [value, setValue] = useState(initialDays === null ? '' : String(initialDays));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const days = value.trim() === '' ? null : Number(value);
    if (days !== null && !confirm(`Delete completed submissions ${days} days after they were sent? Older submissions are deleted now and cannot be restored.`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sites/${siteId}/form-submission-retention`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      setSaved(days);
      setMessage({
        ok: true,
        text: days === null
          ? 'Submissions are kept until you delete them.'
          : `Saved. ${data.deleted ?? 0} older submission${data.deleted === 1 ? ' was' : 's were'} deleted.`,
      });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="card stack" aria-labelledby="form-retention-heading">
      <h2 id="form-retention-heading" style={{ fontSize: '1rem' }}>Submission retention</h2>
      <label className="field">
        <span>Delete completed submissions after (days)</span>
        <input
          type="number"
          inputMode="numeric"
          min={30}
          max={3650}
          step={1}
          value={value}
          placeholder="Keep until deleted"
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <p className="text-sm muted">
        Leave empty to keep submissions until you delete them. A period from 30 to 3650 days applies to all forms on
        this site, including submissions already received. {saved !== null && `Currently: ${saved} days.`}
      </p>
      {message && <p className="text-sm" role="status" style={message.ok ? undefined : { color: 'var(--color-danger)' }}>{message.text}</p>}
      <div className="row">
        <button type="submit" className="btn" disabled={busy}>Save retention</button>
      </div>
    </form>
  );
}
