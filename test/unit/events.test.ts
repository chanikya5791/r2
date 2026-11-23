import { describe, expect, it } from 'vitest';
import { orderCancelled, orderCreated } from '../../src/events';
import type { Order } from '../../src/orderRepository';

const order: Order = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  status: 'PENDING',
  totalCents: 500,
  currency: 'USD',
  failureReason: null,
  items: [{ productId: 'p', sku: 'S', name: 'N', unitPriceCents: 250, quantity: 2, lineTotalCents: 500 }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('event builders', () => {
  it('builds order.created with a unique event id', () => {
    const a = orderCreated(order);
    const b = orderCreated(order);
    expect(a).toMatchObject({ type: 'order.created', order });
    expect(a.eventId).not.toBe(b.eventId);
    expect(Date.parse(a.occurredAt)).not.toBeNaN();
  });

  it('builds order.cancelled with the previous status', () => {
    expect(orderCancelled({ ...order, status: 'CANCELLED' }, 'PROCESSED')).toMatchObject({
      type: 'order.cancelled',
      previousStatus: 'PROCESSED',
      order: { status: 'CANCELLED' },
    });
  });
});
