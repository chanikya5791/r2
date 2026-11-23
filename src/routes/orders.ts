import { Router } from 'express';
import type { CatalogClient } from '../catalogClient';
import { orderCancelled, orderCreated, TOPICS, type EventPublisher } from '../events';
import { forbidden, HttpError, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import type { Order, OrderRepository } from '../orderRepository';
import { buildOrderLines, createOrderSchema, fetchProducts, idempotencyKeySchema, listOrdersQuerySchema } from '../orderService';

interface Deps {
  orders: OrderRepository;
  catalog: CatalogClient;
  publisher: EventPublisher;
}

export function ordersRouter({ orders, catalog, publisher }: Deps): Router {
  const router = Router();

  async function loadOwnOrder(id: string, user: Express.Request['user']): Promise<Order> {
    const order = await orders.findById(id);
    if (!order) throw notFound('Order not found');
    if (user!.role !== 'admin' && order.userId !== user!.id) throw forbidden();
    return order;
  }

  router.post('/', async (req, res) => {
    const body = createOrderSchema.parse(req.body);
    const rawKey = req.header('Idempotency-Key');
    const idempotencyKey = rawKey === undefined ? undefined : idempotencyKeySchema.parse(rawKey);
    const requestId = req.header('x-request-id');
    const userId = req.user!.id;

    if (idempotencyKey) {
      const existing = await orders.findByIdempotencyKey(userId, idempotencyKey);
      if (existing) {
        res.status(200).setHeader('Idempotent-Replayed', 'true').json(existing);
        return;
      }
    }

    const products = await fetchProducts(catalog, body.items.map((i) => i.productId), requestId);
    const lines = buildOrderLines(body.items, products);
    const { order, created } = await orders.create({ userId, idempotencyKey, lines });
    if (!created) {
      res.status(200).setHeader('Idempotent-Replayed', 'true').json(order);
      return;
    }

    try {
      await publisher.publish(TOPICS.orderCreated, order.id, orderCreated(order), requestId ? { 'x-request-id': requestId } : {});
    } catch (err) {
      log.error('failed to publish order.created', { orderId: order.id, err: String(err) });
      await orders.markFailed(order.id, 'EVENT_PUBLISH_FAILED');
      throw new HttpError(503, 'EVENTS_UNAVAILABLE', 'The order could not be queued for processing, please retry', {
        orderId: order.id,
      });
    }

    res.status(201).location(`/orders/${order.id}`).json(order);
  });

  router.get('/', async (req, res) => {
    const q = listOrdersQuerySchema.parse(req.query);
    const isAdmin = req.user!.role === 'admin';
    // Customers always see only their own orders; admins can filter by userId.
    const userId = isAdmin ? q.userId : req.user!.id;
    const { items, total } = await orders.list({ userId, status: q.status, page: q.page, limit: q.limit });
    res.json({ items, total, page: q.page, limit: q.limit });
  });

  router.get('/:id', async (req, res) => {
    res.json(await loadOwnOrder(req.params.id, req.user));
  });

  router.post('/:id/cancel', async (req, res) => {
    const current = await loadOwnOrder(req.params.id, req.user);
    const result = await orders.cancel(current.id);
    if (!result) {
      const latest = (await orders.findById(current.id))!;
      throw new HttpError(409, 'INVALID_STATUS', `An order that is ${latest.status} cannot be cancelled`, {
        status: latest.status,
      });
    }
    const requestId = req.header('x-request-id');
    try {
      await publisher.publish(
        TOPICS.orderCancelled,
        result.order.id,
        orderCancelled(result.order, result.previousStatus),
        requestId ? { 'x-request-id': requestId } : {},
      );
    } catch (err) {
      // The cancellation stands; stock release will be missing, so make it loud.
      log.error('failed to publish order.cancelled', { orderId: result.order.id, err: String(err) });
    }
    res.json(result.order);
  });

  return router;
}
