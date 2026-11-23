import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import jwt from 'jsonwebtoken';
import type { Pool } from 'pg';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createPool, migrate } from '../../src/db';
import { OrderRepository } from '../../src/orderRepository';
import { FakeCatalog, RecordingPublisher } from './fakes';

process.env.LOG_LEVEL = 'silent';

export const JWT_SECRET = 'test-secret';

export const users = {
  admin: { id: '00000000-0000-4000-8000-00000000000a', email: 'admin@test.local', role: 'admin' as const },
  alice: { id: '00000000-0000-4000-8000-0000000000a1', email: 'alice@test.local', role: 'customer' as const },
  bob: { id: '00000000-0000-4000-8000-0000000000b0', email: 'bob@test.local', role: 'customer' as const },
};

export const bearer = (u: { id: string; email: string; role: string }) =>
  `Bearer ${jwt.sign({ email: u.email, role: u.role }, JWT_SECRET, { subject: u.id, expiresIn: '1h' })}`;

export interface TestContext {
  app: ReturnType<typeof createApp>;
  pool: Pool;
  catalog: FakeCatalog;
  publisher: RecordingPublisher;
  reset: () => Promise<void>;
  stop: () => Promise<void>;
}

export async function startTestApp(): Promise<TestContext> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = createPool(container.getConnectionUri());
  await migrate(pool);
  const catalog = new FakeCatalog();
  const publisher = new RecordingPublisher();
  const app = createApp({ orders: new OrderRepository(pool), catalog, publisher, config: loadConfig({ JWT_SECRET }) });
  return {
    app,
    pool,
    catalog,
    publisher,
    reset: async () => {
      await pool.query('TRUNCATE orders CASCADE');
      catalog.products.clear();
      catalog.calls = [];
      catalog.down = false;
      publisher.messages = [];
      publisher.fail = false;
      publisher.connected = true;
    },
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
