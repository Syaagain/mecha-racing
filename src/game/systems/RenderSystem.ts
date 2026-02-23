import { Vector3, Quaternion } from '@babylonjs/core';
import { System }    from '../../engine/core/System';
import type { World } from '../../engine/core/World';
import { Transform } from '../components/Transform';
import type { Renderable } from '../components/Renderable';

/**
 * RenderSystem – syncs ECS Transform TypedArrays into Babylon mesh transforms.
 * No manual GPU draw calls; Babylon's render loop handles the GPU work.
 */
export class RenderSystem extends System {
  /**
   * Called every variable frame (alpha = interpolation factor).
   * Writes ECS position + rotation into each entity's Babylon mesh.
   */
  update(_dt: number, world: World): void {
    this.sync(0, world);
  }

  sync(alpha: number, world: World): void {
    void alpha; // interpolation reserved for future use
    for (const id of world.query(['transform', 'renderable'])) {
      const xfm = world.getComponent<Float32Array>(id, 'transform')!;
      const rdr = world.getComponent<Renderable>(id, 'renderable')!;
      if (!rdr.mesh) continue;

      rdr.mesh.isVisible = rdr.visible;
      rdr.mesh.position.set(
        xfm[Transform.POS_X],
        xfm[Transform.POS_Y],
        xfm[Transform.POS_Z],
      );

      if (!rdr.mesh.rotationQuaternion)
        rdr.mesh.rotationQuaternion = Quaternion.Identity();
      rdr.mesh.rotationQuaternion.set(
        xfm[Transform.ROT_X],
        xfm[Transform.ROT_Y],
        xfm[Transform.ROT_Z],
        xfm[Transform.ROT_W],
      );

      rdr.mesh.scaling = new Vector3(
        xfm[Transform.SCL_X],
        xfm[Transform.SCL_Y],
        xfm[Transform.SCL_Z],
      );
    }
  }

  /**
   * Sync thin-instance buffer for a mesh shared by many entities.
   * Stub – implement when thin-instancing is activated.
   */
  syncThinInstances(world: World): void {
    void world; // TODO: write thinInstanceIndices into mesh buffer
  }
}
