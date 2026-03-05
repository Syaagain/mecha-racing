import type { AbstractMesh } from '@babylonjs/core';

/**
 * Renderable component – PURE DATA, no logic.
 *
 * Holds the Babylon `AbstractMesh` reference that RenderSystem syncs ECS
 * Transform data into each frame.  All fields are mutable by systems;
 * the interface itself carries no methods.
 *
 * Thin-instance workflow:
 *   1. `RenderSystem.syncThinInstances` writes a flat matrix buffer to the
 *      shared mesh's `thinInstanceSetBuffer`.
 *   2. `thinInstanceIndex` is this entity's row in that buffer (0-based).
 *      -1 means "not yet assigned to a thin-instance slot".
 */
export interface Renderable {
  /** Babylon mesh for this entity.  Null until AssetLoader assigns it. */
  mesh:               AbstractMesh | null;
  visible:            boolean;
  castShadows:        boolean;
  /**
   * Row index in the shared thin-instance matrix buffer.
   * -1 = individual mesh mode (no thin instancing).
   */
  thinInstanceIndex:  number;
}

export function createRenderable(): Renderable {
  return { mesh: null, visible: true, castShadows: true, thinInstanceIndex: -1 };
}
