import { Pool } from 'pg';

export const ORDER_STATUSES = ['PENDING', 'PROCESSED', 'FAILED', 'CANCELLED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The jobs worker (shoplite-jobs) also connects to this database and moves orders
 * from PENDING to PROCESSED or FAILED, so keep the two in step when changing this schema.
 */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS orders (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     user_id UUID NOT NULL,
     status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSED', 'FAILED', 'CANCELLED')),
     total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
     currency TEXT NOT NULL DEFAULT 'USD',
     idempotency_key TEXT,
     failure_reason TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (user_id, idempotency_key)
   )`,
  `CREATE INDEX IF NOT EXISTS orders_user_created_idx ON orders (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status)`,
  `CREATE TABLE IF NOT EXISTS order_items (
     order_id UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
     line INTEGER NOT NULL,
     product_id TEXT NOT NULL,
     sku TEXT NOT NULL,
     name TEXT NOT NULL,
     unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
     quantity INTEGER NOT NULL CHECK (quantity > 0),
     PRIMARY KEY (order_id, line)
   )`,
];

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export async function migrate(pool: Pool): Promise<void> {
  for (const sql of MIGRATIONS) await pool.query(sql);
}
