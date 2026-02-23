type Handler<T = unknown> = (payload: T) => void;

export class EventBus {
  private listeners = new Map<string, Handler[]>();

  on<T>(event: string, handler: Handler<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(handler as Handler);
    return () => this.off(event, handler);
  }

  off<T>(event: string, handler: Handler<T>): void {
    const list = this.listeners.get(event);
    if (list) this.listeners.set(event, list.filter(h => h !== handler));
  }

  emit<T>(event: string, payload: T): void {
    this.listeners.get(event)?.forEach(h => h(payload));
  }

  /** Alias for on() – matches diagram naming. */
  subscribe<T>(event: string, handler: Handler<T>): () => void {
    return this.on(event, handler);
  }

  /** Alias for emit() – matches diagram naming. */
  publish<T>(event: string, payload: T): void {
    this.emit(event, payload);
  }
}

export const eventBus = new EventBus();
