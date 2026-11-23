import { z } from 'zod';
import { CatalogUnavailableError, type CatalogClient, type CatalogProduct } from './catalogClient';
import { ORDER_STATUSES } from './db';
import { HttpError } from './lib/errors';
import { paginationSchema } from './lib/pagination';
import type { OrderLine } from './orderRepository';

export const createOrderSchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().trim().min(1).max(64),
        quantity: z.number().int().min(1).max(100),
      }),
    )
    .min(1, 'An order needs at least one item')
    .max(20, 'An order can have at most 20 items')
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, {
      message: 'Each product may only appear once; use quantity instead',
    }),
});

export const idempotencyKeySchema = z.string().trim().min(1).max(100);

export const listOrdersQuerySchema = paginationSchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
  userId: z.string().uuid().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * Builds priced order lines from catalog products. Throws 422 for unknown products and
 * 409 when a product does not have enough stock right now. The stock is only checked here;
 * the jobs worker reserves it when it handles the order.created event.
 */
export function buildOrderLines(
  items: CreateOrderInput['items'],
  products: Map<string, CatalogProduct | null>,
): Omit<OrderLine, 'lineTotalCents'>[] {
  const missing = items.filter((i) => !products.get(i.productId)).map((i) => i.productId);
  if (missing.length) {
    throw new HttpError(422, 'PRODUCT_NOT_FOUND', 'One or more products do not exist', { productIds: missing });
  }
  const short = items
    .map((i) => ({ productId: i.productId, requested: i.quantity, available: products.get(i.productId)!.stock }))
    .filter((s) => s.available < s.requested);
  if (short.length) {
    throw new HttpError(409, 'INSUFFICIENT_STOCK', 'Not enough stock for one or more products', { items: short });
  }
  return items.map((i) => {
    const p = products.get(i.productId)!;
    return { productId: p.id, sku: p.sku, name: p.name, unitPriceCents: p.priceCents, quantity: i.quantity };
  });
}

export async function fetchProducts(
  catalog: CatalogClient,
  productIds: string[],
  requestId?: string,
): Promise<Map<string, CatalogProduct | null>> {
  try {
    const results = await Promise.all(productIds.map((id) => catalog.getProduct(id, requestId)));
    return new Map(productIds.map((id, i) => [id, results[i]]));
  } catch (err) {
    if (err instanceof CatalogUnavailableError) {
      throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'The catalog service is unavailable, please retry');
    }
    throw err;
  }
}
