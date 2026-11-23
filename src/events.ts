import { randomUUID } from 'node:crypto';
import { Kafka, logLevel, type Producer } from 'kafkajs';
import { log } from './lib/logger';
import type { Order } from './orderRepository';
import type { OrderStatus } from './db';

export const TOPICS = {
  orderCreated: 'order.created',
  orderCancelled: 'order.cancelled',
} as const;

export interface OrderCreatedEvent {
  eventId: string;
  type: 'order.created';
  occurredAt: string;
  order: Order;
}

export interface OrderCancelledEvent {
  eventId: string;
  type: 'order.cancelled';
  occurredAt: string;
  previousStatus: OrderStatus;
  order: Order;
}

export type OrderEvent = OrderCreatedEvent | OrderCancelledEvent;

export function orderCreated(order: Order): OrderCreatedEvent {
  return { eventId: randomUUID(), type: 'order.created', occurredAt: new Date().toISOString(), order };
}

export function orderCancelled(order: Order, previousStatus: OrderStatus): OrderCancelledEvent {
  return { eventId: randomUUID(), type: 'order.cancelled', occurredAt: new Date().toISOString(), previousStatus, order };
}

export interface EventPublisher {
  publish(topic: string, key: string, event: OrderEvent, headers?: Record<string, string>): Promise<void>;
  isConnected(): boolean;
}

export class KafkaPublisher implements EventPublisher {
  private readonly producer: Producer;
  private connected = false;

  constructor(brokers: string[], clientId: string) {
    const kafka = new Kafka({ clientId, brokers, logLevel: logLevel.WARN, retry: { retries: 5 } });
    this.producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true, maxInFlightRequests: 1 });
    this.producer.on('producer.connect', () => (this.connected = true));
    this.producer.on('producer.disconnect', () => (this.connected = false));
  }

  async connect(): Promise<void> {
    await this.producer.connect();
    this.connected = true;
    log.info('kafka producer connected');
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async publish(topic: string, key: string, event: OrderEvent, headers: Record<string, string> = {}): Promise<void> {
    await this.producer.send({
      topic,
      messages: [{ key, value: JSON.stringify(event), headers: { 'event-type': event.type, ...headers } }],
    });
    log.info('event published', { topic, key, eventId: event.eventId, type: event.type });
  }
}
