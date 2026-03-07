/**
 * @file CameraSystem.ts
 * @module game/systems
 *
 * Synchronises the Babylon.js `FollowCamera` to the ECS camera entity each
 * fixed tick.
 *
 * ## Responsibility
 * For each entity with both a `camera` and a `cameraTarget` component, the
 * system retrieves the target entity's `Renderable` mesh and assigns it to
 * `FollowCamera.lockedTarget`.  This lets Babylon's built-in FollowCamera
 * logic handle all world-space placement and orientation — the ECS layer only
 * needs to keep the target reference up to date.
 *
 * ## Why a separate system?
 * Keeping camera logic in its own system maintains separation of concerns and
 * allows the camera to be disabled, swapped, or extended (e.g. cinematic
 * camera, top-down debug view) by simply replacing or skipping this system
 * without touching physics or rendering.
 */
import { FollowCamera }   from '@babylonjs/core';
import { System }         from '../../engine/core/System';
import type { World }     from '../../engine/core/World';
import type { CameraData } from '../components/Camera';
import { Transform }      from '../components/Transform';

/**
 * CameraSystem – syncs Babylon FollowCamera properties from the ECS
 * CameraData component every fixed tick.
 *
 * The FollowCamera handles its own position/orientation math internally;
 * this system only updates the configuration parameters (radius, fov, etc.)
 * and keeps `lockedTarget` pointed at the correct vehicle mesh.
 * Never write `camera.rotationQuaternion` or `camera.rotation` here –
 * FollowCamera owns those.
 */
export class CameraSystem extends System {
  update(_dt: number, world: World): void {
    for (const camId of world.query(['camera', 'cameraTarget'])) {
      const cam      = world.getComponent<CameraData>(camId, 'camera')!;
      const targetId = world.getComponent<number>(camId, 'cameraTarget')!;
      const xfm      = world.getComponent<Float32Array>(targetId, 'transform');

      if (!cam.babylonCamera || !xfm) continue;

      // Cast directly to FollowCamera – that is the only camera type we spawn.
      const fc = cam.babylonCamera as FollowCamera;

      fc.radius         = cam.followDistance;
      fc.heightOffset   = cam.followHeight;
      fc.rotationOffset = cam.rotationOffset;
      fc.fov            = cam.fov;
      fc.minZ           = cam.near;
      fc.maxZ           = cam.far;

      // Keep lockedTarget pointed at the vehicle mesh.
      // FollowCamera uses lockedTarget to chase the mesh automatically;
      // we only need to (re-)assign it when the mesh reference changes.
      const renderable = world.getComponent<{ mesh: import('@babylonjs/core').AbstractMesh | null }>(targetId, 'renderable');
      if (renderable?.mesh && fc.lockedTarget !== renderable.mesh) {
        fc.lockedTarget = renderable.mesh;
      }

      // Fallback: if there is no mesh yet, position the camera manually.
      if (!renderable?.mesh) {
        fc.position.x = xfm[Transform.POS_X] + cam.followDistance;
        fc.position.y = xfm[Transform.POS_Y] + cam.followHeight;
        fc.position.z = xfm[Transform.POS_Z];
      }
    }
  }
}
