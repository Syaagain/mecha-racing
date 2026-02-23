import { System }         from '../../engine/core/System';
import type { World }     from '../../engine/core/World';
import type { CameraData } from '../components/Camera';
import { Transform }      from '../components/Transform';

/**
 * CameraSystem – syncs Babylon TargetCamera/FollowCamera properties from
 * the ECS CameraData component every variable frame.
 */
export class CameraSystem extends System {
  update(_dt: number, world: World): void {
    for (const camId of world.query(['camera', 'cameraTarget'])) {
      const cam      = world.getComponent<CameraData>(camId, 'camera')!;
      const targetId = world.getComponent<number>(camId, 'cameraTarget')!;
      const xfm      = world.getComponent<Float32Array>(targetId, 'transform');

      if (!cam.babylonCamera || !xfm) continue;

      const fc = cam.babylonCamera as import('@babylonjs/core').FollowCamera;
      if ('radius' in fc) {
        fc.radius           = cam.followDistance;
        fc.heightOffset     = cam.followHeight;
        fc.rotationOffset   = cam.rotationOffset;
      }
      fc.fov  = cam.fov;
      fc.minZ = cam.near;
      fc.maxZ = cam.far;

      const renderable = world.getComponent<{ mesh: import('@babylonjs/core').AbstractMesh | null }>(targetId, 'renderable');
      if (renderable?.mesh && (fc as unknown as { lockedTarget: unknown }).lockedTarget !== renderable.mesh) {
        (fc as unknown as { lockedTarget: unknown }).lockedTarget = renderable.mesh;
      }

      if (!renderable?.mesh) {
        fc.position.x = xfm[Transform.POS_X] + cam.followDistance;
        fc.position.y = xfm[Transform.POS_Y] + cam.followHeight;
        fc.position.z = xfm[Transform.POS_Z];
      }
    }
  }
}
