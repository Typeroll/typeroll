// What a form's actions and prefill may use: every registered action type and
// prefill source, with the config schema each declares. Core types and the
// ones enabled apps contribute come from the registries, so a new app type
// appears with no change here. Shared by the portal's Forms editor
// (/api/sites/{siteId}/form-capabilities), the v1 API and MCP
// (get_form_capabilities), so agents discover the same types before writing
// a form's `actions`.

export async function formCapabilities() {
  const { actionRegistry } = await import('./forms/actions');
  const { prefillRegistry } = await import('./forms/prefill');
  return {
    actions: [...(await actionRegistry()).values()].map((a) => ({
      type: a.type,
      label: a.label,
      description: a.description,
      admin_only: Boolean(a.admin_only),
      config_fields: a.config_fields ?? [],
      // Whether it can also veto a submit, so the editor can say so.
      has_before: typeof a.before === 'function',
    })),
    prefill_sources: [...(await prefillRegistry()).values()].map((s) => ({
      type: s.type,
      label: s.label,
      description: s.description,
      config_fields: s.config_fields ?? [],
    })),
  };
}
