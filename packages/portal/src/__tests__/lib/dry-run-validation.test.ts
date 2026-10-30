import { expect, it } from 'vitest';
import { dryRunValidationIssues } from '../../lib/publishing/dry-run-validation';

it('finds unnamed image links in image blocks and stored HTML, including nested blocks', () => {
  const pages = [
    { id: 'a', path: '/a', blocks: [{ type: 'core/columns', data: {}, children: [{ type: 'core/image', data: { src: '/x.png', link: 'https://partner.example', alt: ' ' } }] }] },
    { id: 'b', path: '/b', blocks: [{ type: 'core/prose', data: { html: '<a href="/c"><img src="/c.png" alt=""></a><a href="/d"><img src="/d.png" alt="Named"></a><a href="/e" aria-label="Label"><img src="/e.png" alt=""></a>' } }] },
    { id: 'c', path: '/c', html_content: '<a href="/f"><img src="/f.png"> Visible text</a>', blocks: [{ type: 'core/image', data: { src: '/x.png', link: '/g', alt: 'Described' } }] },
  ];
  expect(dryRunValidationIssues(pages)).toEqual([
    { code: 'image_link_unnamed', page: '/a', href: 'https://partner.example', source: 'image_block' },
    { code: 'image_link_unnamed', page: '/b', href: '/c', source: 'html' },
  ]);
});
