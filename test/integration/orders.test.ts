import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectMatchesSpec } from '../helpers/openapi';
import { bearer, startTestApp, users, type TestContext } from '../helpers/testApp';

let ctx: TestContext;

const placeOrder = (user = users.alice, items: unknown = [{ productId: 'p1', quantity: 2 }], key?: string) => {
  const req = request(ctx.app).post('/orders').set('Authorization', bearer(user));
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send({ items });
};

beforeAll(async () => {
  ctx = await startTestApp();
});
afterAll(async () => {
  await ctx?.stop();
});
beforeEach(async () => {
  await ctx.reset();
  ctx.catalog.add({ id: 'p1', sku: 'MUG-1', name: 'Mug', priceCents: 1200, stock: 10 });
  ctx.catalog.add({ id: 'p2', sku: 'BOOK-1', name: 'Book', priceCents: 1999, stock: 1 });
});

describe('GET /health', () => {
  it('is ok when postgres and kafka are up', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ postgres: 'up', kafka: 'up', catalogApi: 'up' });
    expectMatchesSpec(res, '/health', 'get');
  });

  it('is 503 when kafka is down but not when only the catalog is down', async () => {
    ctx.catalog.down = true;
    expect((await request(ctx.app).get('/health')).status).toBe(200);
    ctx.publisher.connected = false;
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.checks.kafka).toBe('down');
    expectMatchesSpec(res, '/health', 'get');
  });
});

describe('POST /orders', () => {
  it('creates a PENDING order priced from the catalog and publishes order.created', async () => {
    const res = await placeOrder(users.alice, [
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 1 },
    ]).set('X-Request-Id', 'trace-1');
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/orders/${res.body.id}`);
    expect(res.body).toMatchObject({
      userId: users.alice.id,
      status: 'PENDING',
      totalCents: 2 * 1200 + 1999,
      currency: 'USD',
      failureReason: null,
      items: [
        { productId: 'p1', sku: 'MUG-1', name: 'Mug', unitPriceCents: 1200, quantity: 2, lineTotalCents: 2400 },
        { productId: 'p2', sku: 'BOOK-1', name: 'Book', unitPriceCents: 1999, quantity: 1, lineTotalCents: 1999 },
      ],
    });
    expectMatchesSpec(res, '/orders', 'post');

    expect(ctx.publisher.messages).toHaveLength(1);
    const [msg] = ctx.publisher.messages;
    expect(msg.topic).toBe('order.created');
    expect(msg.key).toBe(res.body.id);
    expect(msg.headers['x-request-id']).toBe('trace-1');
    expect(msg.event).toMatchObject({ type: 'order.created', order: res.body });
    expect(ctx.catalog.calls.every((c) => c.requestId === 'trace-1')).toBe(true);
  });

  it('ignores any price or total sent by the client', async () => {
    const res = await request(ctx.app)
      .post('/orders')
      .set('Authorization', bearer(users.alice))
      .send({ items: [{ productId: 'p1', quantity: 1, unitPriceCents: 1 }], totalCents: 1 });
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(1200);
  });

  it('returns 401 without a token', async () => {
    const res = await request(ctx.app).post('/orders').send({ items: [{ productId: 'p1', quantity: 1 }] });
    expect(res.status).toBe(401);
    expectMatchesSpec(res, '/orders', 'post');
  });

  it('returns 400 for an invalid body', async () => {
    const res = await placeOrder(users.alice, [{ productId: 'p1', quantity: 0 }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expectMatchesSpec(res, '/orders', 'post');
    expect(ctx.publisher.messages).toHaveLength(0);
  });

  it('returns 422 for unknown products and creates nothing', async () => {
    const res = await placeOrder(users.alice, [
      { productId: 'p1', quantity: 1 },
      { productId: 'ghost', quantity: 1 },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'PRODUCT_NOT_FOUND', details: { productIds: ['ghost'] } });
    expectMatchesSpec(res, '/orders', 'post');
    const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM orders');
    expect(rows[0].n).toBe(0);
  });

  it('returns 409 when there is not enough stock', async () => {
    const res = await placeOrder(users.alice, [{ productId: 'p2', quantity: 2 }]);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: { items: [{ productId: 'p2', requested: 2, available: 1 }] },
    });
    expectMatchesSpec(res, '/orders', 'post');
  });

  it('returns 503 when the catalog is down', async () => {
    ctx.catalog.down = true;
    const res = await placeOrder();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CATALOG_UNAVAILABLE');
    expectMatchesSpec(res, '/orders', 'post');
  });

  it('marks the order FAILED and returns 503 when the event cannot be published', async () => {
    ctx.publisher.fail = true;
    const res = await placeOrder();
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('EVENTS_UNAVAILABLE');
    expectMatchesSpec(res, '/orders', 'post');
    const order = await request(ctx.app).get(`/orders/${res.body.error.details.orderId}`).set('Authorization', bearer(users.alice));
    expect(order.body).toMatchObject({ status: 'FAILED', failureReason: 'EVENT_PUBLISH_FAILED' });
  });

  describe('Idempotency-Key', () => {
    it('replays the original order instead of creating a second one', async () => {
      const first = await placeOrder(users.alice, [{ productId: 'p1', quantity: 1 }], 'checkout-123');
      const second = await placeOrder(users.alice, [{ productId: 'p1', quantity: 5 }], 'checkout-123');
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expectMatchesSpec(second, '/orders', 'post');
      expect(ctx.publisher.messages).toHaveLength(1);
    });

    it('handles concurrent requests with the same key', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => placeOrder(users.alice, undefined, 'race-key')));
      const ids = new Set(results.map((r) => r.body.id));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const { rows } = await ctx.pool.query('SELECT count(*)::int AS n FROM orders');
      expect(rows[0].n).toBe(1);
    });

    it('scopes keys per user', async () => {
      const a = await placeOrder(users.alice, undefined, 'shared-key');
      const b = await placeOrder(users.bob, undefined, 'shared-key');
      expect(b.status).toBe(201);
      expect(b.body.id).not.toBe(a.body.id);
    });

    it('rejects an empty key', async () => {
      const res = await placeOrder(users.alice, undefined, ' ');
      expect(res.status).toBe(400);
    });
  });
});

describe('GET /orders', () => {
  it('shows customers only their own orders, newest first', async () => {
    const a1 = await placeOrder(users.alice);
    await placeOrder(users.bob);
    const a2 = await placeOrder(users.alice);
    const res = await request(ctx.app).get('/orders').set('Authorization', bearer(users.alice));
    expect(res.status).toBe(200);
    expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([a2.body.id, a1.body.id]);
    expect(res.body.total).toBe(2);
    expectMatchesSpec(res, '/orders', 'get');
  });

  it('ignores the userId filter for customers', async () => {
    await placeOrder(users.bob);
    const res = await request(ctx.app).get(`/orders?userId=${users.bob.id}`).set('Authorization', bearer(users.alice));
    expect(res.body.items).toEqual([]);
  });

  it('lets admins see everything and filter by user and status', async () => {
    await placeOrder(users.alice);
    const bobOrder = await placeOrder(users.bob);
    await request(ctx.app).post(`/orders/${bobOrder.body.id}/cancel`).set('Authorization', bearer(users.bob));

    const all = await request(ctx.app).get('/orders').set('Authorization', bearer(users.admin));
    expect(all.body.total).toBe(2);
    const bobs = await request(ctx.app).get(`/orders?userId=${users.bob.id}`).set('Authorization', bearer(users.admin));
    expect(bobs.body.items.map((o: { id: string }) => o.id)).toEqual([bobOrder.body.id]);
    const cancelled = await request(ctx.app).get('/orders?status=CANCELLED').set('Authorization', bearer(users.admin));
    expect(cancelled.body.items.map((o: { id: string }) => o.id)).toEqual([bobOrder.body.id]);
  });

  it('pages and validates the query', async () => {
    for (let i = 0; i < 3; i++) await placeOrder();
    const page = await request(ctx.app).get('/orders?limit=2&page=2').set('Authorization', bearer(users.alice));
    expect(page.body).toMatchObject({ total: 3, page: 2, limit: 2 });
    expect(page.body.items).toHaveLength(1);
    const bad = await request(ctx.app).get('/orders?status=SHIPPED').set('Authorization', bearer(users.alice));
    expect(bad.status).toBe(400);
    expectMatchesSpec(bad, '/orders', 'get');
  });
});

describe('GET /orders/:id', () => {
  it('returns the order to its owner and admins, 403 to others', async () => {
    const order = await placeOrder();
    const own = await request(ctx.app).get(`/orders/${order.body.id}`).set('Authorization', bearer(users.alice));
    expect(own.status).toBe(200);
    expect(own.body).toEqual(order.body);
    expectMatchesSpec(own, '/orders/{id}', 'get');
    expect((await request(ctx.app).get(`/orders/${order.body.id}`).set('Authorization', bearer(users.admin))).status).toBe(200);
    const other = await request(ctx.app).get(`/orders/${order.body.id}`).set('Authorization', bearer(users.bob));
    expect(other.status).toBe(403);
    expectMatchesSpec(other, '/orders/{id}', 'get');
  });

  it.each(['00000000-0000-4000-8000-000000000000', 'not-a-uuid'])('returns 404 for %s', async (id) => {
    const res = await request(ctx.app).get(`/orders/${id}`).set('Authorization', bearer(users.alice));
    expect(res.status).toBe(404);
    expectMatchesSpec(res, '/orders/{id}', 'get');
  });
});

describe('POST /orders/:id/cancel', () => {
  it('cancels a PENDING order and publishes order.cancelled with the previous status', async () => {
    const order = await placeOrder();
    const res = await request(ctx.app).post(`/orders/${order.body.id}/cancel`).set('Authorization', bearer(users.alice));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expectMatchesSpec(res, '/orders/{id}/cancel', 'post');
    const msg = ctx.publisher.messages.at(-1)!;
    expect(msg.topic).toBe('order.cancelled');
    expect(msg.event).toMatchObject({ type: 'order.cancelled', previousStatus: 'PENDING', order: { id: order.body.id } });
  });

  it('cancels a PROCESSED order (stock will be released by the jobs worker)', async () => {
    const order = await placeOrder();
    await ctx.pool.query(`UPDATE orders SET status = 'PROCESSED' WHERE id = $1`, [order.body.id]);
    const res = await request(ctx.app).post(`/orders/${order.body.id}/cancel`).set('Authorization', bearer(users.admin));
    expect(res.status).toBe(200);
    expect(ctx.publisher.messages.at(-1)!.event).toMatchObject({ previousStatus: 'PROCESSED' });
  });

  it.each(['CANCELLED', 'FAILED'])('returns 409 for a %s order', async (status) => {
    const order = await placeOrder();
    await ctx.pool.query(`UPDATE orders SET status = $2 WHERE id = $1`, [order.body.id, status]);
    const res = await request(ctx.app).post(`/orders/${order.body.id}/cancel`).set('Authorization', bearer(users.alice));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'INVALID_STATUS', details: { status } });
    expectMatchesSpec(res, '/orders/{id}/cancel', 'post');
  });

  it("does not let customers cancel someone else's order", async () => {
    const order = await placeOrder(users.alice);
    const res = await request(ctx.app).post(`/orders/${order.body.id}/cancel`).set('Authorization', bearer(users.bob));
    expect(res.status).toBe(403);
    const after = await request(ctx.app).get(`/orders/${order.body.id}`).set('Authorization', bearer(users.alice));
    expect(after.body.status).toBe('PENDING');
  });

  it('only one of several concurrent cancels wins', async () => {
    const order = await placeOrder();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(ctx.app).post(`/orders/${order.body.id}/cancel`).set('Authorization', bearer(users.alice))),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(ctx.publisher.messages.filter((m) => m.topic === 'order.cancelled')).toHaveLength(1);
  });
});
