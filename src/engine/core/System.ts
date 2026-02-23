import type { World } from './World';

/**
 * System – abstract base for all ECS systems.
 * Every system receives the fixed-step delta time and the World each tick.
 */
export abstract class System {
  abstract update(dt: number, world: World): void;
}
