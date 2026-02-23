/**
 * Physics component.
 * Flat Float32Array for ECS batch processing.
 *
 * Layout (10 floats):
 * [0..2]  velocity      vx, vy, vz
 * [3..5]  acceleration  ax, ay, az
 * [6]     mass
 * [7]     speed         (scalar, derived)
 * [8]     maxSpeed
 * [9]     drag
 */
export const PHYSICS_STRIDE = 10;

export function createPhysics(mass = 1, maxSpeed = 200, drag = 0.02): Float32Array {
  const p = new Float32Array(PHYSICS_STRIDE);
  p[6] = mass;
  p[8] = maxSpeed;
  p[9] = drag;
  return p;
}

export const Physics = {
  STRIDE: PHYSICS_STRIDE,
  VEL_X: 0, VEL_Y: 1, VEL_Z: 2,
  ACC_X: 3, ACC_Y: 4, ACC_Z: 5,
  MASS: 6,
  SPEED: 7,
  MAX_SPEED: 8,
  DRAG: 9,
} as const;
