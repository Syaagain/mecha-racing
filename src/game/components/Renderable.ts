import { AbstractMesh } from '@babylonjs/core';

/**
 * Renderable component.
 * Holds a reference to the Babylon AbstractMesh instance that represents
 * this entity in the scene. RenderSystem writes ECS Transform data into it.
 */
export interface Renderable {
  mesh:                AbstractMesh | null;
  visible:             boolean;
  castShadows:         boolean;
  /** Per-entity indices into a thin-instance buffer (populated by RenderSystem). */
  thinInstanceIndices: number[];
}

export function createRenderable(): Renderable {
  return { mesh: null, visible: true, castShadows: true, thinInstanceIndices: [] };
}
