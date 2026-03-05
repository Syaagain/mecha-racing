import type { System } from './System';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Reusable query result – the same object is returned and overwritten on every
 * call to `getEntitiesWith` / `query`.  Consumers MUST read `ids[0..count-1]`
 * synchronously before the next query.
 */
export interface QueryResult {
  /** Pre-allocated buffer – valid entity ids occupy indices [0, count). */
  readonly ids: Uint32Array;
  /** Number of valid entries in `ids`. */
  count: number;
}

// ---------------------------------------------------------------------------
// Internal constant
// ---------------------------------------------------------------------------

const MAX_ENTITIES = 4_096;

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

/**
 * World – ECS kernel.
 *
 * ## Component storage strategy
 * | Data type         | Storage               | Access via getComponent |
 * |-------------------|-----------------------|-------------------------|
 * | `Float32Array`    | Flat shared buffer    | Live `subarray` view    |
 * | Any other object  | `Map<entity, data>`   | Direct reference        |
 *
 * Float32Array components are stored in a single contiguous buffer per
 * component type:  `buf[entityId * stride .. entityId * stride + stride - 1]`.
 * This layout is directly compatible with `thinInstanceSetBuffer` and
 * avoids per-frame garbage creation.
 *
 * ## Query strategy – zero heap allocation per call
 * Entity bitmasks (`Uint32Array`) are AND-compared against the query mask.
 * Results are written into a single pre-allocated scratch `Uint32Array`; the
 * returned value is a lightweight `subarray` view (no buffer copy).
 */
export class World {
  // ── Limits ────────────────────────────────────────────────────────────────
  private readonly maxEntities: number;

  // ── Entity state ──────────────────────────────────────────────────────────
  /** Next fresh id (monotonically increasing, never reused until freed). */
  private nextId = 0;
  /** Bitmask of attached components, indexed by entity id. */
  private readonly entityMasks: Uint32Array;
  /** 1 = alive, 0 = dead / recycled. */
  private readonly entityAlive: Uint8Array;
  /**
   * Recycled ids.  Plain `number[]` is fine: create/destroy is not a
   * per-frame hotpath, so occasional GC there is acceptable.
   */
  private readonly freeList: number[] = [];

  // ── Component registry ────────────────────────────────────────────────────
  /** component name → unique power-of-2 bit (supports up to 32 types). */
  private readonly componentBit = new Map<string, number>();
  private nextBit = 0;

  /**
   * Flat `Float32Array` storage for numeric components.
   * Index entity `e` as:  `buf[e * stride]` … `buf[e * stride + stride - 1]`
   */
  private readonly typedStorages = new Map<string, Float32Array>();
  /** Element count per entity for each typed component. */
  private readonly strides = new Map<string, number>();

  /** Map-backed storage for non-numeric / object components. */
  private readonly objectStorages = new Map<string, Map<number, unknown>>();

  // ── Query scratch buffer (zero GC) ────────────────────────────────────────
  /** Single pre-allocated result object, reused on every query. */
  private readonly _qr: QueryResult;

  // ── Systems ───────────────────────────────────────────────────────────────
  /** Registered systems – ticked in insertion order by `World.tick()`. */
  readonly systems: System[] = [];

  // ── Constructor ───────────────────────────────────────────────────────────

  constructor(maxEntities: number = MAX_ENTITIES) {
    this.maxEntities = maxEntities;
    this.entityMasks = new Uint32Array(maxEntities);
    this.entityAlive = new Uint8Array(maxEntities);
    this._qr         = { ids: new Uint32Array(maxEntities), count: 0 };
  }

  /** No-op kept for API compatibility with the `App.ts` bootstrap call. */
  init(_maxEntities?: number): void {}

  // ── Component registration ────────────────────────────────────────────────

  /**
   * Pre-register a **typed** component backed by a flat `Float32Array`.
   * Idempotent – safe to call multiple times with the same name.
   *
   * @param name   Slot name (e.g. `'transform'`)
   * @param stride Floats per entity (e.g. `TRANSFORM_STRIDE`)
   */
  registerTyped(name: string, stride: number): void {
    if (this.componentBit.has(name)) return;
    this._assignBit(name);
    this.strides.set(name, stride);
    this.typedStorages.set(name, new Float32Array(this.maxEntities * stride));
  }

  /**
   * Pre-register an **object** component backed by a `Map<entityId, T>`.
   * Idempotent – safe to call multiple times with the same name.
   */
  registerObject(name: string): void {
    if (this.componentBit.has(name)) return;
    this._assignBit(name);
    this.objectStorages.set(name, new Map<number, unknown>());
  }

  private _assignBit(name: string): void {
    if (this.nextBit >= 32) {
      throw new Error('World: maximum of 32 component types exceeded');
    }
    this.componentBit.set(name, 1 << this.nextBit++);
  }

  // ── Entity lifecycle ──────────────────────────────────────────────────────

  /**
   * Creates and returns a fresh entity id.
   * Recycles ids from `destroyEntity` before incrementing the counter.
   */
  createEntity(): number {
    const id = this.freeList.length > 0 ? this.freeList.pop()! : this.nextId++;
    if (id >= this.maxEntities) {
      throw new Error(`World: entity limit (${this.maxEntities}) exceeded`);
    }
    this.entityAlive[id] = 1;
    this.entityMasks[id] = 0;
    return id;
  }

  /**
   * Marks an entity dead, wipes its component data, and recycles its id.
   * Safe to call on an already-dead entity (no-op).
   */
  destroyEntity(id: number): void {
    if (this.entityAlive[id] === 0) return;
    this.entityAlive[id] = 0;
    this.entityMasks[id] = 0;

    for (const store of this.objectStorages.values()) {
      store.delete(id);
    }

    // Zero-fill typed slots so stale data cannot leak to a recycled entity.
    for (const [name, buf] of this.typedStorages) {
      const stride = this.strides.get(name)!;
      buf.fill(0, id * stride, id * stride + stride);
    }

    this.freeList.push(id);
  }

  // ── Component add / remove / read ─────────────────────────────────────────

  /**
   * Attaches a component to an entity.
   *
   * - `Float32Array` data → copied into the shared typed buffer at
   *   `entityId × stride`.  Auto-registers as typed on first call.
   * - Any other value → stored by reference in the object `Map`.
   *   Auto-registers as object store on first call.
   */
  addComponent<T>(entity: number, name: string, data: T): void {
    // Auto-register unknown components on first encounter.
    if (!this.componentBit.has(name)) {
      if (data instanceof Float32Array) {
        this.registerTyped(name, data.length);
      } else {
        this.registerObject(name);
      }
    }

    this.entityMasks[entity] |= this.componentBit.get(name)!;

    if (data instanceof Float32Array) {
      const buf    = this.typedStorages.get(name);
      const stride = this.strides.get(name);
      if (buf !== undefined && stride !== undefined) {
        // Copy initial values; per-frame writes go through the view returned
        // by getComponent / getStorage.
        buf.set(data.subarray(0, stride), entity * stride);
        return;
      }
    }

    this.objectStorages.get(name)!.set(entity, data);
  }

  /**
   * Detaches a component from an entity without destroying the entity.
   * Clears the bitmask bit, removes object entry, and zeros typed slot.
   */
  removeComponent(entity: number, name: string): void {
    const bit = this.componentBit.get(name);
    if (bit === undefined) return;
    this.entityMasks[entity] &= ~bit;

    this.objectStorages.get(name)?.delete(entity);

    const buf    = this.typedStorages.get(name);
    const stride = this.strides.get(name);
    if (buf !== undefined && stride !== undefined) {
      buf.fill(0, entity * stride, entity * stride + stride);
    }
  }

  /**
   * Returns the component data for an entity.
   *
   * - **Typed** → a live `subarray` view.  Writes to it mutate the shared
   *   buffer immediately—no extra copy needed from systems.
   * - **Object** → the stored reference.
   *
   * Returns `undefined` if the component is not attached to the entity.
   */
  getComponent<T>(entity: number, name: string): T | undefined {
    const buf = this.typedStorages.get(name);
    if (buf !== undefined) {
      const stride = this.strides.get(name)!;
      return buf.subarray(entity * stride, entity * stride + stride) as unknown as T;
    }
    return this.objectStorages.get(name)?.get(entity) as T | undefined;
  }

  /**
   * Returns the **raw storage** for a component type for use in tight
   * system loops that require direct indexed access.
   *
   * - Typed  → full `Float32Array`  (access entity `e` at `e × stride + offset`).
   * - Object → `Map<number, T>`.
   *
   * @throws if the component name has not been registered yet.
   */
  getStorage<T>(name: string): T {
    const typed = this.typedStorages.get(name);
    if (typed !== undefined) return typed as unknown as T;
    const obj = this.objectStorages.get(name);
    if (obj !== undefined) return obj as unknown as T;
    throw new Error(`World.getStorage: '${name}' is not registered`);
  }

  /**
   * Returns the stride (floats per entity) for a typed component.
   * Returns `undefined` for object components.
   */
  getStride(name: string): number | undefined {
    return this.strides.get(name);
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  /**
   * Returns all alive entities that own **every** listed component.
   *
   * ### Zero-allocation guarantee
   * The method fills a single pre-allocated `Uint32Array` scratch buffer and
   * returns a `subarray` view – a cheap typed-array descriptor with no buffer
   * copy.  The view is invalidated by the **next** query call, so consumers
   * must iterate it synchronously within the same system update.
   *
   * The returned `Uint32Array` is iterable and index-accessible, making it a
   * drop-in replacement for the previous `number[]` return type.
   *
   * @example
   * ```ts
   * const ids = world.getEntitiesWith(['transform', 'physics'] as const);
   * for (let i = 0; i < ids.length; i++) {
   *   const buf = physicsStorage[ids[i] * PHYSICS_STRIDE];
   *   // …
   * }
   * ```
   */
  getEntitiesWith(componentNames: readonly string[]): Uint32Array {
    let mask = 0;
    for (let i = 0; i < componentNames.length; i++) {
      const bit = this.componentBit.get(componentNames[i]);
      if (bit === undefined) {
        // Unknown component → guaranteed no results; return zero-length view.
        this._qr.count = 0;
        return this._qr.ids.subarray(0, 0);
      }
      mask |= bit;
    }

    // Hot path: linear scan over TypedArrays – cache-friendly and branch-free.
    const { entityAlive, entityMasks, maxEntities, _qr } = this;
    let count = 0;
    for (let id = 0; id < maxEntities; id++) {
      if (entityAlive[id] === 1 && (entityMasks[id] & mask) === mask) {
        _qr.ids[count++] = id;
      }
    }
    _qr.count = count;
    return _qr.ids.subarray(0, count);
  }

  /**
   * Alias for `getEntitiesWith` – preserves compatibility with all existing
   * `world.query([...])` call sites in PhysicsSystem, RenderSystem, etc.
   */
  query(componentNames: readonly string[]): Uint32Array {
    return this.getEntitiesWith(componentNames);
  }

  // ── Loop ──────────────────────────────────────────────────────────────────

  /** Ticks all registered systems in insertion order. */
  tick(dt: number): void {
    for (let i = 0; i < this.systems.length; i++) {
      this.systems[i].update(dt, this);
    }
  }
}
