import { CatalogUnavailableError, type CatalogClient, type CatalogProduct } from '../../src/catalogClient';
import type { EventPublisher, OrderEvent } from '../../src/events';

export class FakeCatalog implements CatalogClient {
  products = new Map<string, CatalogProduct>();
  down = false;
  calls: { id: string; requestId?: string }[] = [];

  add(p: Partial<CatalogProduct> & { id: string }): CatalogProduct {
    const product = { sku: `SKU-${p.id}`, name: `Product ${p.id}`, priceCents: 1000, stock: 10, ...p };
    this.products.set(p.id, product);
    return product;
  }

  async getProduct(id: string, requestId?: string) {
    this.calls.push({ id, requestId });
    if (this.down) throw new CatalogUnavailableError('down');
    return this.products.get(id) ?? null;
  }

  async ping() {
    return !this.down;
  }
}

export class RecordingPublisher implements EventPublisher {
  messages: { topic: string; key: string; event: OrderEvent; headers: Record<string, string> }[] = [];
  fail = false;
  connected = true;

  async publish(topic: string, key: string, event: OrderEvent, headers: Record<string, string> = {}) {
    if (this.fail) throw new Error('kafka is down');
    this.messages.push({ topic, key, event, headers });
  }

  isConnected() {
    return this.connected;
  }
}
