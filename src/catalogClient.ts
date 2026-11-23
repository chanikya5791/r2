import { log } from './lib/logger';

export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
}

export class CatalogUnavailableError extends Error {}

export interface CatalogClient {
  /** Returns null when the product does not exist. Throws CatalogUnavailableError when the Catalog API cannot answer. */
  getProduct(id: string, requestId?: string): Promise<CatalogProduct | null>;
  ping(): Promise<boolean>;
}

export class HttpCatalogClient implements CatalogClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 3000,
  ) {}

  async getProduct(id: string, requestId?: string): Promise<CatalogProduct | null> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/products/${encodeURIComponent(id)}`, {
        headers: { accept: 'application/json', ...(requestId ? { 'x-request-id': requestId } : {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      log.warn('catalog request failed', { productId: id, err: String(err) });
      throw new CatalogUnavailableError(`Catalog API unreachable: ${String(err)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      log.warn('catalog returned an error', { productId: id, status: res.status });
      throw new CatalogUnavailableError(`Catalog API returned ${res.status}`);
    }
    const body = (await res.json()) as CatalogProduct;
    return { id: body.id, sku: body.sku, name: body.name, priceCents: body.priceCents, stock: body.stock };
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(this.timeoutMs) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
