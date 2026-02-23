import type { System } from './System';

/**
 * World – ECS core: entity management, component storages, and system orchestration.
 *
 * storages drills down as Map<componentName, Map<entityId, data>>.
 * Registered systems are ticked together via World.tick(dt).
 */
export class World {
  private nextId  = 0;
  private storages = new Map<string, Map<number, unknown>>();

  /** Registered ECS systems – ticked by World.tick(). */
  readonly systems: System[] = [];

  /** Pre-allocate hint (no-op in this impl – kept for diagram conformance). */
  init(_maxEntities?: number): void {}

  createEntity(): number { return this.nextId++; }

  destroyEntity(id: number): void {
    for (const store of this.storages.values()) store.delete(id);
  }

  addComponent<T>(entity: number, name: string, data: T): void {
    if (!this.storages.has(name)) this.storages.set(name, new Map());
    this.storages.get(name)!.set(entity, data);
  }

  getComponent<T>(entity: number, name: string): T | undefined {
    return this.storages.get(name)?.get(entity) as T | undefined;
  }

  /**
   * Returns the raw storage map for a component type.
   * Matches the diagram's getStorage(name): TypedArray signature;
   * cast to the concrete type at the call site.
   */
  getStorage(name: string): Map<number, unknown> | undefined {
    return this.storages.get(name);
  }

  query(componentNames: string[]): number[] {
    if (componentNames.length === 0) return [];
    const [first, ...rest] = componentNames;
    const store = this.storages.get(first);
    if (!store) return [];
    return [...store.keys()].filter(id =>
      rest.every(n => this.storages.get(n)?.has(id)),
    );
  }

  /** Tick all registered systems in insertion order. */
  tick(dt: number): void {
    for (const sys of this.systems) sys.update(dt, this);
  }
}
