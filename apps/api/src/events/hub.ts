import { ServerEventSchema, type ServerEvent } from '@ptvault/contracts';

export type EventHubMessage = { type: 'event'; event: ServerEvent } | { type: 'heartbeat' };

export type EventSubscription = AsyncIterableIterator<EventHubMessage> & {
  readonly closedSignal: AbortSignal;
  close: () => void;
};

export type EventHubOptions = {
  maxQueueSize?: number;
  heartbeatMs?: number;
};

const DEFAULT_MAX_QUEUE_SIZE = 100;
const DEFAULT_HEARTBEAT_MS = 20_000;

class ClientSubscription implements EventSubscription {
  private readonly queue: EventHubMessage[] = [];
  private waiter: ((result: IteratorResult<EventHubMessage>) => void) | undefined;
  private closed = false;
  private signal: AbortSignal | undefined;
  private readonly closeController = new AbortController();

  readonly closedSignal = this.closeController.signal;

  constructor(
    private readonly maxQueueSize: number,
    private readonly unregister: (subscription: ClientSubscription) => void,
  ) {}

  attach(signal: AbortSignal | undefined): void {
    this.signal = signal;
    if (signal?.aborted) {
      this.close();
      return;
    }
    signal?.addEventListener('abort', this.close, { once: true });
  }

  enqueue(message: EventHubMessage): void {
    if (this.closed) return;

    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = undefined;
      resolve({ done: false, value: message });
      return;
    }

    if (this.queue.length >= this.maxQueueSize) {
      this.close();
      return;
    }

    this.queue.push(message);
  }

  next(): Promise<IteratorResult<EventHubMessage>> {
    const message = this.queue.shift();
    if (message) return Promise.resolve({ done: false, value: message });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    if (this.waiter) {
      return Promise.reject(new Error('EVENT_SUBSCRIPTION_CONCURRENT_READ'));
    }

    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  return(): Promise<IteratorResult<EventHubMessage>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.signal?.removeEventListener('abort', this.close);
    this.signal = undefined;
    this.unregister(this);
    this.closeController.abort();
    const resolve = this.waiter;
    this.waiter = undefined;
    resolve?.({ done: true, value: undefined });
  };

  [Symbol.asyncIterator](): AsyncIterableIterator<EventHubMessage> {
    return this;
  }
}

export class EventHub {
  private readonly clients = new Set<ClientSubscription>();
  private readonly maxQueueSize: number;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: EventHubOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (!Number.isInteger(this.maxQueueSize) || this.maxQueueSize < 1) {
      throw new Error('EVENT_HUB_INVALID_QUEUE_SIZE');
    }
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) {
      throw new Error('EVENT_HUB_INVALID_HEARTBEAT');
    }

    this.heartbeat = setInterval(() => {
      this.broadcast({ type: 'heartbeat' });
    }, heartbeatMs);
    this.heartbeat.unref();
  }

  subscribe(signal?: AbortSignal): EventSubscription {
    const subscription = new ClientSubscription(this.maxQueueSize, (client) => {
      this.clients.delete(client);
    });
    if (this.closed) {
      subscription.close();
      return subscription;
    }

    this.clients.add(subscription);
    subscription.attach(signal);
    return subscription;
  }

  publish(input: unknown): ServerEvent {
    if (this.closed) throw new Error('EVENT_HUB_CLOSED');
    const event = ServerEventSchema.parse(input);
    this.broadcast({ type: 'event', event });
    return event;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const client of [...this.clients]) client.close();
  }

  private broadcast(message: EventHubMessage): void {
    for (const client of [...this.clients]) client.enqueue(message);
  }
}
