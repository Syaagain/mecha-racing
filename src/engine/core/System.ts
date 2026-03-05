import type { World } from './World';

/**
 * System – abstract base for all ECS systems.
 *
 * Every system receives the fixed-step delta time and the World each tick.
 * Set `debugMode = true` on a system instance to enable per-system debug
 * rendering and conditional assertions (see instructions: Debugging Standards).
 */
export abstract class System {
  /**
   * When true the system should activate debug helpers such as wireframes,
   * velocity vectors, or additional `console.assert` checks.  Off by default
   * to keep the hot-path free of branch overhead in production.
   */
  debugMode = false;

  abstract update(dt: number, world: World): void;
}
