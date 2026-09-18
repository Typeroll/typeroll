import { paths, type Extension, type ExtensionInstallation, type ExtensionVersion } from '@typeroll/shared';
import { getStore } from '../datastore';

export interface NativeAdminApproval {
  developer_org_id: string;
  extension_id: string;
  manifest_sha256: string;
  enabled: boolean;
}

/** This host-owned collection has no extension/developer write API. */
export async function approvedNativeAdmin(installation: ExtensionInstallation, version: ExtensionVersion): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(version.manifest_sha256)) return false;
  const extension = await getStore().getDoc<Extension>(paths.extension(installation.developer_org_id, installation.extension_id));
  if (extension?.status !== 'active') return false;
  const approval = await getStore().getDoc<NativeAdminApproval>(`extension_admin_approvals/${version.manifest_sha256}`);
  return Boolean(approval?.enabled && approval.developer_org_id === installation.developer_org_id &&
    approval.extension_id === installation.extension_id && approval.manifest_sha256 === version.manifest_sha256 &&
    version.extension_id === installation.extension_id && version.status === 'published');
}
