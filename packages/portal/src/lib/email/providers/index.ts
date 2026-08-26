// Registers the built-in email providers. To add a provider (Resend, SES, …):
// create a sibling module exporting an EmailProvider, then register it here.

import { registerProvider } from '../provider';
import { postmarkProvider } from './postmark';
import { smtpProvider } from './smtp';

registerProvider(smtpProvider);
registerProvider(postmarkProvider);
