import { createHash } from 'node:crypto';
import { paths } from '@typeroll/shared';
import type { MailScope } from './delivery';

export const queueRecipientDigest = (scope: MailScope, group: string, recipient: string) =>
  createHash('sha256').update(JSON.stringify([scope.installationId, group, recipient.trim().toLowerCase()])).digest('hex');
export const queueOptoutPath = (scope: MailScope, digest: string) => `${paths.site(scope.orgId, scope.siteId)}/mail_queue_optouts/${digest}`;
