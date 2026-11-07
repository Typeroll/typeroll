import { describe, expect, it } from 'vitest';
import { serverInfo } from '../src/server';

describe('server info', () => {
  it('names Typeroll and links its documentation', () => {
    expect(serverInfo()).toMatchObject({ name: 'typeroll', title: 'Typeroll CMS', websiteUrl: 'https://typeroll.com/docs/' });
    expect(serverInfo().icons).toBeUndefined();
  });

  it('points the icons at the portal origin, whatever path it is given', () => {
    const icons = serverInfo('https://app.example.test/api/mcp?x=1').icons!;
    expect(icons.map(icon => icon.src)).toEqual([
      'https://app.example.test/icon.svg', 'https://app.example.test/icon-512.png', 'https://app.example.test/icon-192.png',
    ]);
    expect(icons[0]).toMatchObject({ mimeType: 'image/svg+xml', sizes: ['any'] });
  });
});
