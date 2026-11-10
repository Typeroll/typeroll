// `format: "linked_text"`: Core builds the HTML part, links hide their URL,
// nothing else becomes markup, and escaped brackets never become links. Offline.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { paths } from '@typeroll/shared';
import { makeTmpFixtures, resetDatastore } from '../helpers/tmp-fixtures';
import { getStore } from '../../lib/datastore';
import { sendApplicationEmail } from '../../lib/email/delivery';
import { linkedTextToHtml, linkedTextToPlain } from '../../lib/email/linked-text';

const footer = 'Du får det här mailet för att du visat intresse för AI-luncher. [Avregistrera dig](https://www.example.se/avregistrera/?t=a_b-1&s=x)';

describe('linked text', () => {
  it('turns https links into anchors and shows label (url) in plain text', () => {
    const html = linkedTextToHtml(`Hej <Anna> & co!\nRad två\n\n${footer}`);
    expect(html).toContain('<a href="https://www.example.se/avregistrera/?t=a_b-1&amp;s=x">Avregistrera dig</a>');
    expect(html).not.toContain('https://www.example.se/avregistrera/?t=a_b-1&amp;s=x<');
    expect(html).toContain('Hej &lt;Anna&gt; &amp; co!<br>\nRad två</p>');
    expect(html.match(/<p /g)).toHaveLength(2);
    expect(linkedTextToPlain(footer)).toBe('Du får det här mailet för att du visat intresse för AI-luncher. Avregistrera dig (https://www.example.se/avregistrera/?t=a_b-1&s=x)');
  });

  it('keeps escaped brackets and non-https links as text', () => {
    const source = String.raw`\[Win\](https://evil.example) [js](javascript:alert(1)) [http](http://example.com) [a"b](https://x.example/"onmouseover=) back\\slash`;
    const html = linkedTextToHtml(source);
    expect(html).not.toContain('<a ');
    expect(html).toContain('[Win](https://evil.example)');
    expect(linkedTextToPlain(source)).toBe('[Win](https://evil.example) [js](javascript:alert(1)) [http](http://example.com) [a"b](https://x.example/"onmouseover=) back\\slash');
  });

  it('unescapes brackets inside a link label', () => {
    expect(linkedTextToHtml(String.raw`[Lunch \[sv\]](https://x.example/)`)).toContain('<a href="https://x.example/">Lunch [sv]</a>');
  });
});

describe('application mail with linked_text', () => {
  const scope = { orgId: 'one', siteId: 'site', installationId: 'app-one' };
  const input = { idempotency_key: 'request-0000000001', to: 'owner@example.com', subject: 'Lunch', text: footer };
  beforeEach(async () => {
    makeTmpFixtures(); await resetDatastore();
    await getStore().setDoc(paths.integrations(scope.orgId, scope.siteId), { email: { type: 'ses', from: 'Approved <mail@example.com>', config: {} } });
  });

  it('sends an HTML part only when asked, and treats the format as part of the message', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, id: 'ses-1' });
    await sendApplicationEmail(scope, input, { send });
    expect(send.mock.calls[0]![1]).toMatchObject({ text: footer });
    expect(send.mock.calls[0]![1].html).toBeUndefined();

    await expect(sendApplicationEmail(scope, { ...input, format: 'linked_text' }, { send })).rejects.toMatchObject({ status: 409 });
    await sendApplicationEmail(scope, { ...input, idempotency_key: 'request-0000000002', format: 'linked_text' }, { send });
    const message = send.mock.calls[1]![1];
    expect(message.text).toContain('Avregistrera dig (https://www.example.se/avregistrera/');
    expect(message.html).toContain('>Avregistrera dig</a>');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('refuses an unknown format', async () => {
    const send = vi.fn();
    await expect(sendApplicationEmail(scope, { ...input, format: 'html' as never }, { send })).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  });
});
