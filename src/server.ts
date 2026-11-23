import { createApp } from './app';
import { HttpCatalogClient } from './catalogClient';
import { loadConfig } from './config';
import { createPool, migrate } from './db';
import { KafkaPublisher } from './events';
import { log } from './lib/logger';
import { OrderRepository } from './orderRepository';

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);
  const publisher = new KafkaPublisher(config.kafkaBrokers, config.kafkaClientId);
  await publisher.connect();

  const app = createApp({
    orders: new OrderRepository(pool),
    catalog: new HttpCatalogClient(config.catalogApiUrl, config.catalogTimeoutMs),
    publisher,
    config,
  });
  const server = app.listen(config.port, () => log.info('orders-api listening', { port: config.port }));

  const shutdown = () => {
    log.info('shutting down');
    server.close(() => void Promise.allSettled([publisher.disconnect(), pool.end()]).then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error('failed to start', { err: String(err?.stack ?? err) });
  process.exit(1);
});
