# ShopLite Orders API (r2)

Places and manages orders for ShopLite. Orders are stored in **PostgreSQL**; every new or cancelled order is
published to **Kafka** for the jobs worker (r4). Prices and stock are checked against the **Catalog API** (r3)
at checkout. Part of the ShopLite test app; see the [infra repo (r5)](../r5) for the whole system.

## Endpoints

Full contract: [`openapi.yaml`](openapi.yaml). Everything except `/health` needs a JWT from the Users API (r6).

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | `{checks: {postgres, kafka, catalogApi}}`. 503 if Postgres or Kafka is down; the Catalog API is reported but does not fail the check. |
| POST | `/orders` | Body `{items: [{productId, quantity}]}`, 1–20 lines, quantity 1–100, each product once. Optional `Idempotency-Key` header. See below. |
| GET | `/orders?status=&page=&limit=` | Newest first. Customers get their own; admins get everyone's and can filter with `userId`. |
| GET | `/orders/:id` | Owner or admin; 403 for other customers, 404 if not found |
| POST | `/orders/:id/cancel` | Owner or admin. Works for `PENDING` and `PROCESSED`; otherwise 409 `INVALID_STATUS`. |

### `POST /orders` responses

| Status | Code | When |
|---|---|---|
| 201 | | Order created as `PENDING`, priced from the catalog (client-sent prices are ignored), `order.created` published |
| 200 | | Same `Idempotency-Key` as an earlier order by this user: returns that order with `Idempotent-Replayed: true`. Safe under concurrency. |
| 400 | `VALIDATION_ERROR` | Bad body or key |
| 409 | `INSUFFICIENT_STOCK` | `details.items[]` lists `{productId, requested, available}` |
| 422 | `PRODUCT_NOT_FOUND` | `details.productIds[]` |
| 503 | `CATALOG_UNAVAILABLE` | Catalog API down, timing out or returning 5xx |
| 503 | `EVENTS_UNAVAILABLE` | Kafka publish failed; the order is saved as `FAILED` / `EVENT_PUBLISH_FAILED` |

The stock check here does not reserve anything; the jobs worker reserves stock when it processes the event. Two
orders can therefore both be accepted for the last unit, and one of them ends up `FAILED` with
`INSUFFICIENT_STOCK`. This is deliberate: it is a realistic race for tests to find.

## Events (Kafka)

| Topic | Key | Payload |
|---|---|---|
| `order.created` | order id | `{eventId, type: "order.created", occurredAt, order}` |
| `order.cancelled` | order id | `{eventId, type: "order.cancelled", occurredAt, previousStatus, order}` |

The `x-request-id` header is forwarded to the Catalog API and onto Kafka messages.

## Database (`orders`)

The `orders` and `order_items` tables are created on start-up (`src/db.ts`). The jobs worker updates
`orders.status` and `orders.failure_reason`.

## Run

```bash
cp .env.example .env
npm ci
npm run dev
```

| Variable | Default |
|---|---|
| `PORT` | `3002` |
| `DATABASE_URL` | `postgres://shoplite:shoplite@localhost:5432/orders` |
| `KAFKA_BROKERS` | `localhost:9094` |
| `CATALOG_API_URL` | `http://localhost:3003` |
| `CATALOG_TIMEOUT_MS` | `3000` |
| `JWT_SECRET` | `dev-secret-change-me` (must match r6) |

## Tests

```bash
npm run test:unit          # validation, pricing, stock checks, HTTP catalog client (timeouts, 5xx, 404)
npm run test:integration   # real Postgres via Testcontainers, fake catalog and Kafka publisher
```

The integration tests check every response against `openapi.yaml`. They cover pricing, all error responses,
idempotency (including concurrent requests), per-user visibility, cancel rules, concurrent cancels, and Kafka or
catalog outages.
