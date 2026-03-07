/**
 * @file EventBus.ts
 * @module engine/core
 *
 * Lightweight, typed publish-subscribe event bus.
 *
 * ## Usage
 * ```ts
 * eventBus.subscribe<{ a: number }>('collision', ({ a }) => console.log(a));
 * eventBus.publish('collision', { a: 1, b: 2 });
 * eventBus.unsubscribe('collision', handler);
 * ```
 *
 * `eventBus` is a module-level singleton exported from this file so that any
 * system or component can import it without dependency injection.
 *
 * ## Design notes
 * - All handlers for an event are called synchronously inside `publish()`.
 * - Topics that have never been subscribed silently no-op on `publish()`.
 * - Generic type parameter `T` enforces payload shape at the call site.
 */
type Handler<T = unknown> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<string, Handler[]>();

  subscribe<T>(event: string, handler: Handler<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler as Handler);
    return () => {
      const list = this.listeners.get(event);
      if (list) this.listeners.set(event, list.filter(h => h !== (handler as Handler)));
    };
  }

  publish<T>(event: string, payload: T): void {
    this.listeners.get(event)?.forEach(h => h(payload));
  }
}

export const eventBus = new EventBus();
