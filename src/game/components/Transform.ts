/**
 * Transform component.
 * Laid out as a flat Float32Array for cache-friendly ECS access.
 *
 * Layout (10 floats):
 * [0..2]  position  x, y, z
 * [3..6]  rotation  qw, qx, qy, qz  (quaternion)
 * [7..9]  scale     sx, sy, sz
 */
export const TRANSFORM_STRIDE = 10;

export function createTransform(): Float32Array {
  const t = new Float32Array(TRANSFORM_STRIDE);
  t[3] = 1; // qw = 1  → identity quaternion
  t[7] = 1; t[8] = 1; t[9] = 1; // scale = (1, 1, 1)
  return t;
}

export const Transform = {
  STRIDE: TRANSFORM_STRIDE,
  POS_X: 0, POS_Y: 1, POS_Z: 2,
  ROT_W: 3, ROT_X: 4, ROT_Y: 5, ROT_Z: 6,
  SCL_X: 7, SCL_Y: 8, SCL_Z: 9,
} as const;
