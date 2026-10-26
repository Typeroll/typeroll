import { SITE_SETTINGS_SECTIONS, isSiteSettingsSection, type SiteSettingsSection } from './site-settings-sections';

/** Navigation stays in-document so unsaved values survive section changes. */
export function initializeSiteSettings() {
  const form = document.querySelector<HTMLFormElement>('#site-settings-form');
  const scope = form?.elements.namedItem('settings_section') as HTMLInputElement | null;
  const picker = document.querySelector<HTMLSelectElement>('#settings-section');
  const save = document.querySelector<HTMLButtonElement>('#settings-save-button');
  const status = document.querySelector<HTMLElement>('#settings-save-status');
  if (!form || !scope || !picker || !save || !status) return;
  let selected: SiteSettingsSection = isSiteSettingsSection(scope.value) ? scope.value : 'general';
  const dirty = new Set<SiteSettingsSection>();
  const generations = new Map<SiteSettingsSection, number>();
  const messages = new Map<SiteSettingsSection, { text: string; error?: boolean }>();
  let saving: SiteSettingsSection | undefined;
  document.querySelector('.settings-navigation')?.setAttribute('data-enhanced', '');
  form.noValidate = true; // Only validate the section being saved, including collapsed details.

  function renderMessage() {
    const message = messages.get(selected);
    status!.textContent = message?.text ?? (dirty.has(selected) ? 'Unsaved changes in this section.' : '');
    status!.toggleAttribute('data-error', message?.error === true);
    save!.disabled = saving !== undefined;
  }
  function navigate(section: SiteSettingsSection, push: boolean) {
    selected = section;
    scope!.value = section;
    picker!.value = section;
    for (const panel of document.querySelectorAll<HTMLElement>('[data-settings-section]')) panel.hidden = panel.dataset.settingsSection !== section;
    for (const link of document.querySelectorAll<HTMLElement>('[data-settings-link]')) {
      if (link.dataset.settingsLink === section) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const info = SITE_SETTINGS_SECTIONS.find(item => item.id === section)!;
    document.querySelector('#settings-description')!.textContent = info.description;
    save!.textContent = `Save ${info.label}`;
    renderMessage();
    if (push) {
      const url = new URL(location.href);
      url.searchParams.set('section', section);
      url.searchParams.delete('saved');
      history.pushState(null, '', url);
    }
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-settings-link]')) {
    link.addEventListener('click', event => {
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
      const section = link.dataset.settingsLink;
      if (!isSiteSettingsSection(section)) return;
      event.preventDefault();
      navigate(section, true);
    });
  }
  picker.addEventListener('change', () => { if (isSiteSettingsSection(picker.value)) navigate(picker.value, true); });
  window.addEventListener('popstate', () => {
    const value = new URL(location.href).searchParams.get('section');
    navigate(isSiteSettingsSection(value) ? value : 'general', false);
  });
  form.addEventListener('input', event => {
    const section = (event.target as HTMLElement).closest<HTMLElement>('[data-settings-section]')?.dataset.settingsSection;
    if (!isSiteSettingsSection(section)) return;
    dirty.add(section);
    generations.set(section, (generations.get(section) ?? 0) + 1);
    messages.delete(section);
    document.querySelector<HTMLElement>(`[data-settings-dirty="${section}"]`)!.hidden = false;
    renderMessage();
  });
  window.addEventListener('beforeunload', event => {
    if (dirty.size) { event.preventDefault(); event.returnValue = ''; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saving) return;
    const section = selected;
    // Do not submit values from another section, including draft edits there.
    const data = new FormData();
    data.set('settings_section', section);
    for (const panel of form.querySelectorAll<HTMLElement>(`[data-settings-section="${section}"]`)) {
      for (const control of panel.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')) {
        if (!control.name || control.disabled) continue;
        if (!control.checkValidity()) {
          for (let details = control.closest('details'); details; details = details.parentElement?.closest('details') ?? null) details.open = true;
          control.reportValidity();
          return;
        }
        if (control instanceof HTMLInputElement && ['checkbox', 'radio'].includes(control.type) && !control.checked) continue;
        data.append(control.name, control.value);
      }
    }
    saving = section;
    const generation = generations.get(section) ?? 0;
    messages.set(section, { text: 'Saving…' });
    renderMessage();
    try {
      const response = await fetch(form.action, { method: 'POST', body: data, headers: { accept: 'application/json' } });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text.startsWith('<') ? 'Could not save. Check your access and try again.' : text || 'Could not save. Try again.');
      }
      const result = await response.json();
      if (result.saved !== true) throw new Error('Could not confirm the save. Please try again.');
      if ((generations.get(section) ?? 0) === generation) {
        dirty.delete(section);
        document.querySelector<HTMLElement>(`[data-settings-dirty="${section}"]`)!.hidden = true;
        messages.set(section, { text: 'Saved. Publish the site when you want these changes to go live.' });
      } else messages.set(section, { text: 'Saved. You have newer unsaved changes in this section.' });
    } catch (error) {
      messages.set(section, { text: error instanceof Error ? error.message : 'Could not save. Try again.', error: true });
    } finally {
      saving = undefined;
      renderMessage();
    }
  });
}
