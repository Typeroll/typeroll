import type { ExtensionRuntimeSnapshot, PublicExtensionFormBinding } from '@typeroll/shared';

export interface DeployableFormBinding extends PublicExtensionFormBinding {
  extension_id: string;
  component_id: string;
}

export async function assertDeployableFormBindings(
  snapshot: ExtensionRuntimeSnapshot,
  formExists: (formId: string) => Promise<boolean>,
): Promise<DeployableFormBinding[]> {
  const bindings = snapshot.installations.flatMap((installation) =>
    installation.components.flatMap((component) =>
      Object.values(component.resolved_form_bindings ?? {}).map((binding) => ({
        ...binding,
        extension_id: installation.extension_id,
        component_id: component.id,
      })),
    ),
  );
  for (const binding of bindings) {
    let endpoint: URL;
    try {
      endpoint = new URL(binding.submit_url);
    } catch {
      throw new Error('FORMS_PUBLIC_URL or PORTAL_PUBLIC_URL must provide an absolute Forms endpoint');
    }
    if (endpoint.protocol !== 'https:') {
      throw new Error('The deployed Forms endpoint must use HTTPS');
    }
    if (!binding.submit_token) {
      throw new Error('FORMS_HMAC_SECRET is required to deploy an Extension with form bindings');
    }
    if (!await formExists(binding.form_id)) {
      throw new Error(
        `Extension ${binding.extension_id}/${binding.component_id} binds missing form "${binding.form_id}"`,
      );
    }
  }
  return bindings;
}
