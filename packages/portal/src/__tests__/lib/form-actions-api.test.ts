// App installation credentials hold forms:read / forms:write with the site's
// admin permission; they still never see or set a form's email recipients and
// webhook targets.
import { describe, it, expect } from 'vitest';
import { formActionsPermission, formActionsView } from '../../lib/form-actions-api';

describe('formActionsPermission', () => {
  const form = { actions: [{ type: 'email', config: { to: 'owner@example.com', subject: 's', body: 'b' } }] } as never;

  it('follows a person key\'s site permission', () => {
    expect(formActionsPermission({ permission: 'admin' })).toBe('admin');
    expect(formActionsView(form, formActionsPermission({ permission: 'admin' }))).toHaveLength(1);
    expect(formActionsView(form, formActionsPermission({ permission: 'write' }))).toEqual([]);
  });

  it('never grants actions to an app installation credential', () => {
    const app = { permission: 'admin', extensionIdentity: { installationId: 'app-one', scopes: ['forms:read', 'forms:write'] } };
    expect(formActionsPermission(app)).toBe('read');
    expect(formActionsView(form, formActionsPermission(app))).toEqual([]);
  });
});
