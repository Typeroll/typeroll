import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import HtmlPageEditor from '../../components/HtmlPageEditor';
import type { Page } from '@typeroll/shared';

it('preserves valid CSS selectors in server-rendered HTML editor styles', () => {
  const html = renderToString(createElement(HtmlPageEditor, {
    siteId: 'site', page: { id: 'page', title: 'Test', slug: 'test', status: 'published', content_mode: 'html', html_content: '' } as Page,
    previewUrl: '/api/sites/site/preview/page', lastDeployedAt: null,
  }));
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]);
  const editor = styles.find(css => css.includes('.editor__actions'));
  // Style is a raw-text HTML element: entities stay literal and break both CSS and hydration.
  expect(editor).toContain('.editor__actions > span');
  expect(editor).not.toMatch(/&(?:gt|lt|quot|amp);|&#(?:x27|39);/);
});
