import {
  extensionPropsToFields,
  paths,
  type BlockType,
  type ExtensionInstallation,
  type ExtensionManifest,
} from '@typeroll/shared';
import { getStore } from '../datastore';

const ISO_EPOCH = '1970-01-01T00:00:00.000Z';

function safeSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

export function extensionBlockTypeId(installationId: string, componentId: string): string {
  return `extension--${safeSegment(installationId)}--${safeSegment(componentId)}`;
}

export function extensionBlockType(
  installation: ExtensionInstallation,
  manifest: ExtensionManifest,
  component: NonNullable<ExtensionManifest['frontend']>['components'][number],
): BlockType {
  const blockId = extensionBlockTypeId(installation.id, component.id);
  return {
    id: blockId,
    name: `${safeSegment(manifest.id)}-${safeSegment(component.id)}`,
    label: component.label,
    icon: component.icon ?? 'Blocks',
    category: ['layout', 'content', 'media', 'custom'].includes(component.category ?? '')
      ? component.category as BlockType['category']
      : 'custom',
    container: false,
    schema: extensionPropsToFields(component.props_schema),
    template: `<div class="tr-extension-mount"><p class="tr-extension-placeholder">${escapeHtml(component.label)} loads on the published site.</p></div>`,
    styles: '.tr-extension-placeholder{padding:1rem;border:1px dashed currentColor;border-radius:.5rem;opacity:.7}',
    origin: 'third_party',
    extension: {
      extension_id: manifest.id,
      installation_id: installation.id,
      component_id: component.id,
      render_mode: component.render_mode,
    },
    created_at: ISO_EPOCH,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function provisionExtensionBlocks(
  orgId: string,
  siteId: string,
  installation: ExtensionInstallation,
  manifest: ExtensionManifest,
  enabled: boolean,
  versionId = 'main',
): Promise<{ written: string[]; removed: string[] }> {
  const store = getStore();
  const result = { written: [] as string[], removed: [] as string[] };
  for (const component of manifest.frontend?.components ?? []) {
    const block = extensionBlockType(installation, manifest, component);
    const blockPath = paths.blockType(orgId, siteId, block.id, versionId);
    if (!enabled) {
      await store.deleteDoc(blockPath);
      result.removed.push(block.id);
      continue;
    }
    const { id: _id, ...body } = block;
    await store.setDoc(blockPath, body);
    result.written.push(block.id);
  }
  return result;
}
