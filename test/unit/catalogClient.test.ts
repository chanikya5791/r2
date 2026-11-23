import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogUnavailableError, HttpCatalogClient } from '../../src/catalogClient';

let server: Server;
let baseUrl: string;
const seen: { url?: string; requestId?: string }[] = [];

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  server = createServer((req, res) => {
    seen.push({ url: req.url, requestId: req.headers['x-request-id'] as string | undefined });
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.url === '/products/p1')
      return send(200, { id: 'p1', sku: 'S1', name: 'One', priceCents: 100, stock: 2, category: 'x', description: '' });
    if (req.url === '/products/boom') return send(500, { error: {} });
    if (req.url === '/products/slow') return void setTimeout(() => send(200, {}), 500);
    if (req.url === '/health') return send(200, { status: 'ok' });
    send(404, { error: { code: 'NOT_FOUND' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('HttpCatalogClient', () => {
  it('returns only the fields orders need and forwards x-request-id', async () => {
    const product = await new HttpCatalogClient(baseUrl).getProduct('p1', 'rid-9');
    expect(product).toEqual({ id: 'p1', sku: 'S1', name: 'One', priceCents: 100, stock: 2 });
    expect(seen.at(-1)).toEqual({ url: '/products/p1', requestId: 'rid-9' });
  });

  it('url-encodes ids', async () => {
    await new HttpCatalogClient(baseUrl).getProduct('a/b');
    expect(seen.at(-1)!.url).toBe('/products/a%2Fb');
  });

  it('returns null on 404', async () => {
    expect(await new HttpCatalogClient(baseUrl).getProduct('nope')).toBeNull();
  });

  it('throws CatalogUnavailableError on 5xx', async () => {
    await expect(new HttpCatalogClient(baseUrl).getProduct('boom')).rejects.toBeInstanceOf(CatalogUnavailableError);
  });

  it('throws CatalogUnavailableError on timeout', async () => {
    await expect(new HttpCatalogClient(baseUrl, 50).getProduct('slow')).rejects.toBeInstanceOf(CatalogUnavailableError);
  });

  it('throws CatalogUnavailableError when nothing is listening', async () => {
    await expect(new HttpCatalogClient('http://127.0.0.1:1').getProduct('p1')).rejects.toBeInstanceOf(CatalogUnavailableError);
  });

  it('ping reflects /health', async () => {
    expect(await new HttpCatalogClient(baseUrl).ping()).toBe(true);
    expect(await new HttpCatalogClient('http://127.0.0.1:1').ping()).toBe(false);
  });
});
