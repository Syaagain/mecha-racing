import { TargetCamera } from '@babylonjs/core';

/**
 * CameraComponent.
 * Stores Babylon TargetCamera ref (FollowCamera is a subclass) and
 * the raw projection matrices for shader uniforms.
 */
export interface CameraData {
  /** The Babylon camera object – assigned by LevelBuilder after creation. */
  babylonCamera:  TargetCamera | null;
  /** Projection + view matrix cache (16 floats each = 32 total). */
  matrices:        Float32Array;
  /** Distance behind the target */
  followDistance:  number;
  /** Height above target */
  followHeight:    number;
  /** Rotation offset in degrees */
  rotationOffset:  number;
  fov:  number;
  near: number;
  far:  number;
}

export function createCamera(
  followDistance = 12,
  followHeight   = 4,
  /**
   * 180° = camera sits BEHIND the vehicle (at –Z when yaw = 0).
   *
   * Babylon FollowCamera orbit formula:
   *   camOffset = ( sin(vehicleYaw + rotationOffset_rad) * radius,
   *                 heightOffset,
   *                 cos(vehicleYaw + rotationOffset_rad) * radius )
   *
   * At rotationOffset = 0°  → offset.Z = +radius → camera is IN FRONT,
   *   making every control appear inverted on screen.
   * At rotationOffset = 180° → offset.Z = -radius → camera is BEHIND ✓
   *   W accelerates away from the camera (forward on screen).
   *   D turns the car clockwise ≡ right on screen.
   */
  rotationOffset = 180,
  fov            = 0.8,
  near           = 0.1,
  far            = 2000,
): CameraData {
  return {
    babylonCamera:  null,
    matrices:        new Float32Array(32), // [0..15] = view, [16..31] = projection
    followDistance,
    followHeight,
    rotationOffset,
    fov,
    near,
    far,
  };
}
