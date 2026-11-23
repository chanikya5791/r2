import express from 'express';
import type { CatalogClient } from './catalogClient';
import type { Config } from './config';
import type { EventPublisher } from './events';
import { errorHandler, notFoundHandler } from './lib/errors';
import { authenticate } from './middleware/auth';
import { requestContext } from './middleware/requestContext';
import type { OrderRepository } from './orderRepository';
import { ordersRouter } from './routes/orders';

export interface AppDeps {
  orders: OrderRepository;
  catalog: CatalogClient;
  publisher: EventPublisher;
  config: Config;
}

export function createApp({ orders, catalog, publisher, config }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(requestContext);

  app.get('/health', async (_req, res) => {
    const postgres = await orders.ping().then(
      () => 'up' as const,
      () => 'down' as const,
    );
    const kafka = publisher.isConnected() ? ('up' as const) : ('down' as const);
    const catalogApi = (await catalog.ping()) ? ('up' as const) : ('down' as const);
    // The catalog is a dependency but not ours: report it without failing our own health.
    const ok = postgres === 'up' && kafka === 'up';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'error', service: 'orders-api', checks: { postgres, kafka, catalogApi } });
  });

  app.use('/orders', authenticate(config.jwtSecret), ordersRouter({ orders, catalog, publisher }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
