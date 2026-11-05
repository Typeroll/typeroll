// The SMTP client on real workerd TCP sockets against a local server, offline.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let mf: Miniflare, dir: string, server: net.Server;
const lines: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'typeroll-smtp-'));
  const entry = fileURLToPath(new URL('../workers/smtp-worker.ts', import.meta.url));
  await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outfile: path.join(dir, 'worker.js'), external: ['cloudflare:sockets'], logLevel: 'silent' });
  server = net.createServer((socket) => {
    let buffer = '', data = false;
    socket.write('220 local ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2); lines.push(line);
        if (data) { if (line === '.') { data = false; socket.write('250 queued\r\n'); } continue; }
        if (line.startsWith('EHLO')) socket.write('250-local\r\n250 SIZE 1000000\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 go ahead\r\n'); }
        else if (line === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: readFileSync(path.join(dir, 'worker.js'), 'utf8'),
    compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'] } as never));
}, 60_000);
afterAll(async () => { await mf?.dispose(); server?.close(); rmSync(dir, { recursive: true, force: true }); });

it('delivers over a Workers TCP socket', async () => {
  const response = await mf.dispatchFetch(`http://smtp/?port=${(server.address() as net.AddressInfo).port}`);
  expect(await response.text()).toBe('sent');
  expect(lines).toEqual(['EHLO localhost', 'MAIL FROM:<site@example.com>', 'RCPT TO:<a@example.net>', 'DATA', 'Subject: hi', '', '..dot', 'body', '.', 'QUIT']);
});
