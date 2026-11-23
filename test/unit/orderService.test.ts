import { describe, expect, it } from 'vitest';
import type { CatalogProduct } from '../../src/catalogClient';
import { HttpError } from '../../src/lib/errors';
import { buildOrderLines, createOrderSchema, fetchProducts, listOrdersQuerySchema } from '../../src/orderService';
import { FakeCatalog } from '../helpers/fakes';

const product = (id: string, over: Partial<CatalogProduct> = {}): CatalogProduct => ({
  id,
  sku: `SKU-${id}`,
  name: `P${id}`,
  priceCents: 250,
  stock: 5,
  ...over,
});

function catchHttp(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected an HttpError');
}

describe('createOrderSchema', () => {
  it('accepts a normal order', () => {
    expect(createOrderSchema.parse({ items: [{ productId: 'a', quantity: 2 }] })).toEqual({ items: [{ productId: 'a', quantity: 2 }] });
  });

  it.each([
    ['empty items', { items: [] }],
    ['missing items', {}],
    ['zero quantity', { items: [{ productId: 'a', quantity: 0 }] }],
    ['fractional quantity', { items: [{ productId: 'a', quantity: 1.5 }] }],
    ['quantity over 100', { items: [{ productId: 'a', quantity: 101 }] }],
    ['string quantity', { items: [{ productId: 'a', quantity: '2' }] }],
    ['blank productId', { items: [{ productId: ' ', quantity: 1 }] }],
    ['duplicate products', { items: [{ productId: 'a', quantity: 1 }, { productId: 'a', quantity: 1 }] }],
    ['more than 20 lines', { items: Array.from({ length: 21 }, (_, i) => ({ productId: `p${i}`, quantity: 1 })) }],
  ])('rejects %s', (_name, body) => {
    expect(createOrderSchema.safeParse(body).success).toBe(false);
  });
});

describe('listOrdersQuerySchema', () => {
  it('validates status and userId', () => {
    expect(listOrdersQuerySchema.safeParse({ status: 'PROCESSED' }).success).toBe(true);
    expect(listOrdersQuerySchema.safeParse({ status: 'processed' }).success).toBe(false);
    expect(listOrdersQuerySchema.safeParse({ userId: 'nope' }).success).toBe(false);
  });
});

describe('buildOrderLines', () => {
  it('prices lines from the catalog, not from the client', () => {
    const lines = buildOrderLines(
      [
        { productId: 'a', quantity: 2 },
        { productId: 'b', quantity: 1 },
      ],
      new Map([
        ['a', product('a', { priceCents: 300 })],
        ['b', product('b', { priceCents: 1999 })],
      ]),
    );
    expect(lines).toEqual([
      { productId: 'a', sku: 'SKU-a', name: 'Pa', unitPriceCents: 300, quantity: 2 },
      { productId: 'b', sku: 'SKU-b', name: 'Pb', unitPriceCents: 1999, quantity: 1 },
    ]);
  });

  it('reports every unknown product with 422', () => {
    const err = catchHttp(() =>
      buildOrderLines(
        [
          { productId: 'a', quantity: 1 },
          { productId: 'x', quantity: 1 },
          { productId: 'y', quantity: 1 },
        ],
        new Map([
          ['a', product('a')],
          ['x', null],
          ['y', null],
        ]),
      ),
    );
    expect(err.status).toBe(422);
    expect(err.code).toBe('PRODUCT_NOT_FOUND');
    expect(err.details).toEqual({ productIds: ['x', 'y'] });
  });

  it('reports short stock with 409, allowing exactly the available amount', () => {
    const products = new Map([
      ['a', product('a', { stock: 3 })],
      ['b', product('b', { stock: 0 })],
    ]);
    expect(() => buildOrderLines([{ productId: 'a', quantity: 3 }], products)).not.toThrow();
    const err = catchHttp(() =>
      buildOrderLines(
        [
          { productId: 'a', quantity: 4 },
          { productId: 'b', quantity: 1 },
        ],
        products,
      ),
    );
    expect(err.status).toBe(409);
    expect(err.details).toEqual({
      items: [
        { productId: 'a', requested: 4, available: 3 },
        { productId: 'b', requested: 1, available: 0 },
      ],
    });
  });
});

describe('fetchProducts', () => {
  it('looks up every product and forwards the request id', async () => {
    const catalog = new FakeCatalog();
    catalog.add({ id: 'a' });
    const map = await fetchProducts(catalog, ['a', 'missing'], 'req-1');
    expect(map.get('a')?.id).toBe('a');
    expect(map.get('missing')).toBeNull();
    expect(catalog.calls).toEqual([
      { id: 'a', requestId: 'req-1' },
      { id: 'missing', requestId: 'req-1' },
    ]);
  });

  it('turns catalog outages into 503', async () => {
    const catalog = new FakeCatalog();
    catalog.down = true;
    await expect(fetchProducts(catalog, ['a'])).rejects.toMatchObject({ status: 503, code: 'CATALOG_UNAVAILABLE' });
  });
});
