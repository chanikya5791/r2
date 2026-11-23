import type { Pool, PoolClient } from 'pg';
import type { OrderStatus } from './db';

export interface OrderLine {
  productId: string;
  sku: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface Order {
  id: string;
  userId: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  failureReason: string | null;
  items: OrderLine[];
  createdAt: string;
  updatedAt: string;
}

interface OrderRow {
  id: string;
  user_id: string;
  status: OrderStatus;
  total_cents: number;
  currency: string;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ItemRow {
  order_id: string;
  line: number;
  product_id: string;
  sku: string;
  name: string;
  unit_price_cents: number;
  quantity: number;
}

export interface ListOrdersFilter {
  userId?: string;
  status?: OrderStatus;
  page: number;
  limit: number;
}

const toOrder = (r: OrderRow, items: ItemRow[]): Order => ({
  id: r.id,
  userId: r.user_id,
  status: r.status,
  totalCents: r.total_cents,
  currency: r.currency,
  failureReason: r.failure_reason,
  items: items
    .sort((a, b) => a.line - b.line)
    .map((i) => ({
      productId: i.product_id,
      sku: i.sku,
      name: i.name,
      unitPriceCents: i.unit_price_cents,
      quantity: i.quantity,
      lineTotalCents: i.unit_price_cents * i.quantity,
    })),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

export class OrderRepository {
  constructor(private readonly pool: Pool) {}

  private async withItems(client: Pool | PoolClient, rows: OrderRow[]): Promise<Order[]> {
    if (rows.length === 0) return [];
    const { rows: items } = await client.query<ItemRow>('SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])', [
      rows.map((r) => r.id),
    ]);
    return rows.map((r) => toOrder(r, items.filter((i) => i.order_id === r.id)));
  }

  /**
   * Inserts the order and its lines in one transaction. When an order with the same
   * (userId, idempotencyKey) already exists, returns that order with created=false instead.
   */
  async create(input: {
    userId: string;
    idempotencyKey?: string;
    lines: Omit<OrderLine, 'lineTotalCents'>[];
  }): Promise<{ order: Order; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const total = input.lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
      const { rows } = await client.query<OrderRow>(
        `INSERT INTO orders (user_id, total_cents, idempotency_key)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [input.userId, total, input.idempotencyKey ?? null],
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        const existing = await this.findByIdempotencyKey(input.userId, input.idempotencyKey!);
        return { order: existing!, created: false };
      }
      const order = rows[0];
      for (const [index, l] of input.lines.entries()) {
        await client.query(
          `INSERT INTO order_items (order_id, line, product_id, sku, name, unit_price_cents, quantity)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [order.id, index + 1, l.productId, l.sku, l.name, l.unitPriceCents, l.quantity],
        );
      }
      await client.query('COMMIT');
      const [full] = await this.withItems(this.pool, [order]);
      return { order: full, created: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<Order | null> {
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [id]);
    const [order] = await this.withItems(this.pool, rows);
    return order ?? null;
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<Order | null> {
    const { rows } = await this.pool.query<OrderRow>('SELECT * FROM orders WHERE user_id = $1 AND idempotency_key = $2', [
      userId,
      key,
    ]);
    const [order] = await this.withItems(this.pool, rows);
    return order ?? null;
  }

  async list(f: ListOrdersFilter): Promise<{ items: Order[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.userId) where.push(`user_id = $${params.push(f.userId)}`);
    if (f.status) where.push(`status = $${params.push(f.status)}`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ rows }, count] = await Promise.all([
      this.pool.query<OrderRow>(
        `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, f.limit, (f.page - 1) * f.limit],
      ),
      this.pool.query<{ count: string }>(`SELECT count(*) FROM orders ${whereSql}`, params),
    ]);
    return { items: await this.withItems(this.pool, rows), total: Number(count.rows[0].count) };
  }

  /**
   * Atomically moves an order to CANCELLED if it is PENDING or PROCESSED.
   * Returns the updated order and the status it had before, or null if it could not be cancelled.
   */
  async cancel(id: string): Promise<{ order: Order; previousStatus: OrderStatus } | null> {
    const { rows } = await this.pool.query<OrderRow & { previous_status: OrderStatus }>(
      `WITH prev AS (
         SELECT id, status FROM orders WHERE id = $1 AND status IN ('PENDING', 'PROCESSED') FOR UPDATE
       )
       UPDATE orders o
          SET status = 'CANCELLED', updated_at = now()
         FROM prev
        WHERE o.id = prev.id
       RETURNING o.*, prev.status AS previous_status`,
      [id],
    );
    if (rows.length === 0) return null;
    const [order] = await this.withItems(this.pool, rows);
    return { order, previousStatus: rows[0].previous_status };
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE orders SET status = 'FAILED', failure_reason = $2, updated_at = now() WHERE id = $1 AND status = 'PENDING'`,
      [id, reason],
    );
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
