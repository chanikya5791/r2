export interface Config {
  port: number;
  databaseUrl: string;
  kafkaBrokers: string[];
  kafkaClientId: string;
  catalogApiUrl: string;
  catalogTimeoutMs: number;
  jwtSecret: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3002),
    databaseUrl: env.DATABASE_URL ?? 'postgres://shoplite:shoplite@localhost:5432/orders',
    kafkaBrokers: (env.KAFKA_BROKERS ?? 'localhost:9094').split(',').map((b) => b.trim()).filter(Boolean),
    kafkaClientId: env.KAFKA_CLIENT_ID ?? 'orders-api',
    catalogApiUrl: (env.CATALOG_API_URL ?? 'http://localhost:3003').replace(/\/$/, ''),
    catalogTimeoutMs: Number(env.CATALOG_TIMEOUT_MS ?? 3000),
    jwtSecret: env.JWT_SECRET ?? 'dev-secret-change-me',
  };
}
